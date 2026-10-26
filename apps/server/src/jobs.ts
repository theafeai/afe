import PgBoss from "pg-boss";

/** A background job handler. Throwing marks the job failed; it is retried. */
export interface JobDefinition<T extends object = object> {
  /** Queue name, prefixed by owner, e.g. "github.webhook", "health.probe". */
  name: string;
  handler(data: T): Promise<void>;
  /** Optional cron schedule (UTC) on which the job is enqueued with `scheduleData`. */
  schedule?: string;
  scheduleData?: T;
  retryLimit?: number;
}

export interface SendOptions {
  /** Deduplicate: at most one queued job per key (pg-boss singletonKey). */
  singletonKey?: string;
  startAfter?: Date | number;
}

/** What connectors and route handlers use to enqueue work. */
export interface JobQueue {
  send(name: string, data: object, options?: SendOptions): Promise<void>;
}

/** Postgres-backed job runner (ADR 0002). */
export class PgBossJobRunner implements JobQueue {
  private readonly boss: PgBoss;
  private started = false;

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString, schema: "pgboss" });
  }

  async start(): Promise<void> {
    if (!this.started) {
      await this.boss.start();
      this.started = true;
    }
  }

  /** Creates queues and schedules; with `work`, also consumes them. */
  async register(definitions: JobDefinition[], { work }: { work: boolean }): Promise<void> {
    await this.start();
    for (const def of definitions) {
      await this.boss.createQueue(def.name, {
        name: def.name,
        retryLimit: def.retryLimit ?? 5,
        retryBackoff: true,
      });
      if (def.schedule) await this.boss.schedule(def.name, def.schedule, def.scheduleData ?? {});
      if (work) {
        await this.boss.work<object>(def.name, async (jobs) => {
          for (const job of jobs) await def.handler(job.data);
        });
      }
    }
  }

  async send(name: string, data: object, options: SendOptions = {}): Promise<void> {
    await this.start();
    await this.boss.send(name, data, {
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    });
  }

  async stop(): Promise<void> {
    if (this.started) await this.boss.stop({ graceful: true });
  }
}

/**
 * In-process queue for tests: records sent jobs and can run them against
 * registered handlers.
 */
export class InlineJobQueue implements JobQueue {
  readonly sent: { name: string; data: object; options: SendOptions }[] = [];
  private readonly handlers = new Map<string, JobDefinition["handler"]>();

  register(definitions: JobDefinition[]): void {
    for (const def of definitions) this.handlers.set(def.name, def.handler);
  }

  async send(name: string, data: object, options: SendOptions = {}): Promise<void> {
    this.sent.push({ name, data, options });
  }

  /** Runs all queued jobs (including ones they enqueue) until the queue is empty. */
  async drain(): Promise<void> {
    while (this.sent.length > 0) {
      const job = this.sent.shift()!;
      const handler = this.handlers.get(job.name);
      if (!handler) throw new Error(`no handler registered for job ${job.name}`);
      await handler(job.data);
    }
  }
}
