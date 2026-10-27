/**
 * Bounded in-memory buffer of serialised protocol items, waiting to be sent.
 * When a bound (items or bytes) is exceeded, the OLDEST waiting items are
 * dropped and counted; the count goes to Afe in every batch and heartbeat
 * (`droppedTotal`), which records it as a possible observation gap until a
 * full snapshot taken after the loss has been processed.
 *
 * Items taken for sending are no longer in the buffer (the sender keeps its
 * in-flight batch until Afe accepts it), so dropping never touches them.
 */
export interface BufferedItem {
  /** JSON of one `AgentItem`. */
  json: string;
  bytes: number;
}

export interface BufferLimits {
  maxItems: number;
  maxBytes: number;
}

export class BoundedBuffer {
  readonly #items: BufferedItem[] = [];
  #head = 0;
  #bytes = 0;
  #dropped = 0;
  #waiters: (() => void)[] = [];

  constructor(
    readonly limits: BufferLimits,
    private readonly onDrop?: (count: number) => void,
  ) {}

  get size(): number {
    return this.#items.length - this.#head;
  }
  get bytes(): number {
    return this.#bytes;
  }
  /** Items dropped since the agent started. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Counts items lost elsewhere (e.g. a batch Afe rejected) as dropped. */
  countDropped(n: number): void {
    if (n <= 0) return;
    this.#dropped += n;
    this.onDrop?.(n);
  }

  push(item: object): void {
    const json = JSON.stringify(item);
    const entry = { json, bytes: Buffer.byteLength(json) };
    this.#items.push(entry);
    this.#bytes += entry.bytes;
    let dropped = 0;
    while (
      this.size > 0 &&
      (this.size > this.limits.maxItems || this.#bytes > this.limits.maxBytes)
    ) {
      const old = this.#items[this.#head]!;
      this.#head++;
      this.#bytes -= old.bytes;
      dropped++;
    }
    this.#compact();
    if (dropped) this.countDropped(dropped);
    for (const w of this.#waiters.splice(0)) w();
  }

  /** Removes and returns up to `maxItems` items / `maxBytes` bytes (always at least one item if any). */
  take(maxItems: number, maxBytes: number): BufferedItem[] {
    const out: BufferedItem[] = [];
    let bytes = 0;
    while (this.size > 0 && out.length < maxItems) {
      const next = this.#items[this.#head]!;
      if (out.length > 0 && bytes + next.bytes > maxBytes) break;
      out.push(next);
      bytes += next.bytes;
      this.#head++;
      this.#bytes -= next.bytes;
    }
    this.#compact();
    return out;
  }

  /** Resolves when an item is pushed (or after `ms`). */
  waitForItems(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.size > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      this.#waiters.push(done);
    });
  }

  #compact(): void {
    if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
      this.#items.splice(0, this.#head);
      this.#head = 0;
    }
  }
}
