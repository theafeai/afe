/**
 * Chain anchoring as a server module (AFE-29, ADR 0007): the `anchor.publish`
 * job, `ctx.anchors` (used by /api/audit/verify and exports) and the anchor
 * read/verify API.
 */
import type { FastifyRequest } from "fastify";
import {
  createEd25519CheckpointSigner,
  createFileChainAnchor,
  createTsaChainAnchor,
  createWebhookChainAnchor,
  DEFAULT_TENANT_ID,
  normaliseExportPublicKey,
  parseAnchorReceipts,
  type ChainAnchor,
  type CheckpointSigner,
} from "@afe/core";
import { validateOutboundUrl, type OutboundUrlPolicy } from "@afe/core/security";
import { listAnchorReceipts } from "@afe/db";
import type { ConnectorModule, ServerContext } from "../context.ts";
import type { JobDefinition } from "../jobs.ts";
import { loadAnchorConfig, type AnchorConfig } from "./config.ts";
import { ANCHOR_JOBS, AnchorService } from "./service.ts";

export interface AnchorModuleOptions {
  /** Overrides on top of the environment (AFE_ANCHOR_*). */
  config?: Partial<AnchorConfig>;
  env?: NodeJS.ProcessEnv;
  /**
   * Replaces the anchors built from the environment: the ChainAnchor extension
   * point (e.g. KMS-signed checkpoints in object storage for the hosted service).
   */
  anchors?: ChainAnchor[];
  /** Replaces the Ed25519 signer from AFE_ANCHOR_SIGNING_KEY / AFE_EXPORT_SIGNING_KEY (e.g. KMS). */
  signer?: CheckpointSigner | null;
  /** Tenant of API requests. Defaults to the single built-in tenant (OSS). */
  resolveTenant?: (req: FastifyRequest) => string | Promise<string>;
  now?: () => Date;
}

export interface AnchorModule extends ConnectorModule {
  service(ctx: ServerContext): AnchorService;
}

function buildAnchors(config: AnchorConfig, policy: OutboundUrlPolicy): ChainAnchor[] {
  const anchors: ChainAnchor[] = [];
  if (config.tsaUrl) {
    anchors.push(
      createTsaChainAnchor({
        url: config.tsaUrl,
        policy,
        ...(config.tsaPolicy ? { tsaPolicy: config.tsaPolicy } : {}),
      }),
    );
  }
  if (config.dir) anchors.push(createFileChainAnchor({ dir: config.dir }));
  if (config.webhookUrl) anchors.push(createWebhookChainAnchor({ url: config.webhookUrl, policy }));
  return anchors;
}

const MAX_SUPPLIED = 10_000;

export function createAnchorModule(options: AnchorModuleOptions = {}): AnchorModule {
  const services = new WeakMap<ServerContext, AnchorService>();
  let config: AnchorConfig | undefined;
  const getConfig = () =>
    (config ??= { ...loadAnchorConfig(options.env ?? process.env), ...options.config });

  const service = (ctx: ServerContext): AnchorService => {
    let s = services.get(ctx);
    if (!s) {
      const c = getConfig();
      const policy: OutboundUrlPolicy = {
        allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets,
        allowInsecureHttp: ctx.config.allowInsecureHttpTargets,
      };
      const anchors = options.anchors ?? buildAnchors(c, policy);
      const signer =
        options.signer !== undefined
          ? options.signer
          : c.signingKey
            ? createEd25519CheckpointSigner(c.signingKey)
            : null;
      if (anchors.length > 0 && !signer) {
        throw new Error(
          "chain anchoring needs a signing key: set AFE_ANCHOR_SIGNING_KEY or AFE_EXPORT_SIGNING_KEY",
        );
      }
      s = new AnchorService({
        pool: ctx.pool,
        anchors,
        signer,
        trustedPublicKeys: c.trustedPublicKeys.map(normaliseExportPublicKey),
        log: ctx.log,
        intervalMs: c.intervalMs,
        onExport: c.onExport,
        ...(options.now ? { now: options.now } : {}),
      });
      services.set(ctx, s);
      ctx.anchors = s;
    }
    return s;
  };

  return {
    source: "anchor",
    service,
    async routes(app, ctx) {
      const s = service(ctx);
      const c = getConfig();
      if (!options.anchors) {
        // Fail fast on an unsafe anchor URL (docs/security/rules.md R6); re-checked per request.
        const policy: OutboundUrlPolicy = {
          allowPrivateNetworks: ctx.config.allowPrivateNetworkTargets,
          allowInsecureHttp: ctx.config.allowInsecureHttpTargets,
        };
        if (c.webhookUrl) await validateOutboundUrl(c.webhookUrl, policy);
        if (c.tsaUrl) await validateOutboundUrl(c.tsaUrl, policy);
      }
      const tenantOf = (req: FastifyRequest) =>
        options.resolveTenant ? options.resolveTenant(req) : DEFAULT_TENANT_ID;

      app.get("/api/audit/anchors", async (req) => {
        const tenantId = await tenantOf(req);
        const stored = await listAnchorReceipts(ctx.pool, tenantId, { limit: 100 });
        return {
          configured: s.configured,
          anchors: s.anchors.map((a) => a.kind),
          publicKey: s.trustedPublicKeys[0] ?? null,
          receipts: stored.map((r) => r.receipt),
        };
      });

      // Auditor-supplied receipts (JSON array, a single receipt, or the anchor
      // file's JSON Lines as {"text": "..."}) checked against the live chain.
      app.post("/api/audit/anchors/verify", async (req, reply) => {
        const tenantId = await tenantOf(req);
        const body = (req.body ?? {}) as {
          receipts?: unknown;
          text?: unknown;
          trustedPublicKeys?: unknown;
        };
        let parsed;
        try {
          const text =
            typeof body.text === "string" ? body.text : JSON.stringify(body.receipts ?? []);
          parsed = parseAnchorReceipts(text);
          const keys = Array.isArray(body.trustedPublicKeys)
            ? body.trustedPublicKeys.map((k) => normaliseExportPublicKey(String(k)))
            : undefined;
          if (parsed.receipts.length > MAX_SUPPLIED) throw new Error("too many receipts");
          const report = await s.verifySupplied(tenantId, parsed.receipts, keys);
          const errors = [...parsed.issues, ...report.errors];
          return { ...report, ok: errors.length === 0, errors };
        } catch (err) {
          return reply.code(400).send({ error: "bad_request", message: (err as Error).message });
        }
      });
    },
    jobs(ctx): JobDefinition[] {
      const s = service(ctx);
      if (!s.configured) return [];
      return [
        {
          name: ANCHOR_JOBS.PUBLISH,
          schedule: getConfig().schedule,
          retryLimit: 0,
          handler: async () => {
            await s.publishAll();
          },
        },
      ];
    },
  };
}

/** The module registered by default (anchors from AFE_ANCHOR_*; inactive when none is set). */
export const anchorModule = createAnchorModule();
