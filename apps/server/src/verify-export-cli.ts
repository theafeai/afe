/**
 * `afe verify-export <file> [options]`: offline verification of an export
 * (docs/export-verification.md). Needs no database, network or config.
 * `afe export-keygen`: generates an Ed25519 key for AFE_EXPORT_SIGNING_KEY.
 */
import { readFile } from "node:fs/promises";
import { parseAnchorReceipts, type AnchorReceipt } from "@afe/core/anchoring";
import {
  generateExportSigningKey,
  verifyExport,
  type ExportVerificationReport,
  type VerifyExportOptions,
} from "@afe/core/export";

export const VERIFY_EXPORT_USAGE = `usage: afe verify-export <file> [--manifest <file>] [--public-key <key|file>]...
                         [--require-signature] [--tenant <id>] [--expect-head <seq>:<hash>]
                         [--anchors <file>]... [--anchor-public-key <key|file>]... [--require-anchor] [--json]`;

export interface CliIo {
  readFile(path: string): Promise<Uint8Array>;
  out(text: string): void;
}

const nodeIo: CliIo = {
  readFile: (p) => readFile(p),
  out: (t) => void process.stdout.write(t),
};

async function keyArg(value: string, io: CliIo): Promise<string> {
  // A literal key (base64url / PEM) or a path to a file holding one.
  if (value.includes("-----BEGIN") || /^[A-Za-z0-9_\-+/]{43}=?$/.test(value)) return value;
  return new TextDecoder().decode(await io.readFile(value));
}

/** Runs the command; returns the process exit code (0 ok, 1 verification failed, 2 usage). */
export async function runVerifyExport(argv: string[], io: CliIo = nodeIo): Promise<number> {
  let file: string | undefined;
  let manifestPath: string | undefined;
  let json = false;
  const options: VerifyExportOptions = { trustedPublicKeys: [] };
  const anchorFiles: string[] = [];
  const anchorKeys: string[] = [];
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      const next = () => {
        const v = argv[++i];
        if (v === undefined) throw new Error(`${a} needs a value`);
        return v;
      };
      if (a === "--manifest") manifestPath = next();
      else if (a === "--public-key") options.trustedPublicKeys!.push(await keyArg(next(), io));
      else if (a === "--require-signature") options.requireSignature = true;
      else if (a === "--tenant") options.expectedTenantId = next();
      else if (a === "--expect-head") {
        const m = /^(\d+):([0-9a-f]{64})$/.exec(next());
        if (!m) throw new Error("--expect-head must be <seq>:<64 hex hash>");
        options.expectedHead = { seq: Number(m[1]), hash: m[2]! };
      } else if (a === "--anchors") anchorFiles.push(next());
      else if (a === "--anchor-public-key") anchorKeys.push(await keyArg(next(), io));
      else if (a === "--require-anchor") options.requireAnchor = true;
      else if (a === "--json") json = true;
      else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
      else if (file === undefined) file = a;
      else throw new Error("only one file can be verified at a time");
    }
    if (!file) throw new Error("missing <file>");
  } catch (err) {
    io.out(`${(err as Error).message}\n${VERIFY_EXPORT_USAGE}\n`);
    return 2;
  }
  if (anchorKeys.length > 0) options.anchorPublicKeys = anchorKeys;
  if (anchorFiles.length > 0) {
    const receipts: AnchorReceipt[] = [];
    for (const f of anchorFiles) {
      try {
        const parsed = parseAnchorReceipts(new TextDecoder().decode(await io.readFile(f)));
        if (parsed.issues.length > 0) throw new Error(parsed.issues[0]!.message);
        receipts.push(...parsed.receipts);
      } catch (err) {
        io.out(`--anchors ${f}: ${(err as Error).message}\n`);
        return 2;
      }
    }
    options.anchors = receipts;
  }
  if (manifestPath) options.manifest = new TextDecoder().decode(await io.readFile(manifestPath));
  const report = verifyExport(await io.readFile(file), options);
  io.out(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(file, report));
  return report.ok ? 0 : 1;
}

export function formatReport(file: string, r: ExportVerificationReport): string {
  const lines: string[] = [];
  const m = r.manifest;
  lines.push(`${r.ok ? "VERIFIED" : "FAILED"}: ${file}`);
  if (m) {
    lines.push(
      `  export ${m.exportId} (${m.format}), tenant ${m.tenantId}, created ${m.createdAt}`,
      `  ${r.eventCount} event(s), seq ${m.firstSeq ?? "-"}..${m.lastSeq ?? "-"}; chain head at export: ${m.chainHead.seq}:${m.chainHead.hash}`,
      `  filter: ${JSON.stringify(m.filter)}`,
    );
  }
  lines.push(
    `  signature: ${r.signature.status}${r.signature.keyId ? ` (key ${r.signature.keyId})` : ""}`,
  );
  const p = r.proofs;
  const mark = (b: boolean) => (b ? "yes" : "no");
  lines.push(
    `  events unmodified:      ${mark(p.eventsIntact)}`,
    `  export unmodified:      ${mark(p.exportIntact)}`,
    `  events match filter:    ${mark(p.matchesFilter)}`,
    `  chain links verified:   ${p.linksVerified}`,
    `  head event included:    ${mark(p.headIncluded)}`,
    `  complete chain proven:  ${mark(p.completeChain)}`,
    `  anchored:               ${mark(p.anchored)}`,
  );
  if (r.anchors) {
    lines.push(`  anchors: ${r.anchors.matched} of ${r.anchors.total} confirmed`);
    for (const x of r.anchors.results) {
      if (x.status === "other_tenant") continue;
      const ts =
        x.timestamp === "absent"
          ? ""
          : `, timestamp ${x.timestamp}${x.timestampGenTime ? ` at ${x.timestampGenTime}` : ""}`;
      lines.push(
        `    seq ${x.seq} (${x.createdAt}, ${x.source ?? x.kind}): ${x.status}, signature ${x.signature}${ts}`,
      );
    }
  }
  for (const e of r.errors) {
    lines.push(`  ERROR ${e.code}${e.seq !== undefined ? ` (seq ${e.seq})` : ""}: ${e.message}`);
  }
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  if (r.limitations.length) {
    lines.push("  not proven by this file:");
    for (const l of r.limitations) lines.push(`    - ${l}`);
  }
  return `${lines.join("\n")}\n`;
}

export function runExportKeygen(io: Pick<CliIo, "out"> = nodeIo): number {
  const k = generateExportSigningKey();
  io.out(
    [
      `AFE_EXPORT_SIGNING_KEY=${k.privateKey}`,
      `# public key (publish this; auditors pass it to --public-key): ${k.publicKey}`,
      `# key id: ${k.keyId}`,
      "",
    ].join("\n"),
  );
  return 0;
}
