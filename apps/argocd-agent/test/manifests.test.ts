/**
 * The agent's deployment manifests must be read-only (AFE-28): every RBAC
 * rule grants only get/list/watch, only on Applications (and Events), and
 * the pod runs non-root with a read-only root filesystem and no capabilities.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const root = path.resolve(import.meta.dirname, "../../../deploy/argocd-agent");
const READ_VERBS = new Set(["get", "list", "watch"]);
const ALLOWED = new Map([
  ["argoproj.io", new Set(["applications"])],
  ["", new Set(["events"])],
]);

interface Rule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
  resourceNames?: string[];
  nonResourceURLs?: string[];
}

async function plainDocs(): Promise<Record<string, unknown>[]> {
  const dir = path.join(root, "manifests");
  const out: Record<string, unknown>[] = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".yaml"))) {
    for (const d of parseAllDocuments(await readFile(path.join(dir, f), "utf8"))) {
      expect(d.errors, f).toEqual([]);
      const v = d.toJS() as Record<string, unknown> | null;
      if (v) out.push({ ...v, __file: f });
    }
  }
  return out;
}

function checkRules(rules: Rule[], where: string) {
  expect(rules.length, where).toBeGreaterThan(0);
  for (const r of rules) {
    expect(r.nonResourceURLs, where).toBeUndefined();
    for (const v of r.verbs ?? []) expect(READ_VERBS.has(v), `${where}: verb ${v}`).toBe(true);
    expect(r.verbs?.length, where).toBeGreaterThan(0);
    for (const g of r.apiGroups ?? []) {
      const allowed = ALLOWED.get(g);
      expect(allowed, `${where}: apiGroup "${g}"`).toBeDefined();
      for (const res of r.resources ?? [])
        expect(allowed!.has(res), `${where}: resource ${g}/${res}`).toBe(true);
    }
  }
}

describe("agent manifests (plain YAML)", () => {
  it("grants only get/list/watch on applications.argoproj.io (and get/list on events)", async () => {
    const docs = await plainDocs();
    const roles = docs.filter((d) => d.kind === "Role" || d.kind === "ClusterRole");
    expect(roles.map((r) => r.kind).sort()).toEqual(["ClusterRole", "Role"]);
    for (const r of roles) checkRules(r.rules as Rule[], `${r.__file} ${r.kind}`);
    // The Applications rule has exactly the read verbs.
    for (const r of roles) {
      const apps = (r.rules as Rule[]).find((x) => x.resources?.includes("applications"));
      expect(apps?.verbs?.sort()).toEqual(["get", "list", "watch"]);
    }
    // Nothing anywhere mentions secrets or a write verb in an RBAC object.
    const text = JSON.stringify(roles);
    expect(text).not.toMatch(/"secrets"|"create"|"update"|"patch"|"delete"|"\*"/);
  });

  it("binds the roles only to the agent's ServiceAccount", async () => {
    const docs = await plainDocs();
    for (const b of docs.filter((d) => String(d.kind).endsWith("Binding"))) {
      expect(b.subjects).toEqual([
        { kind: "ServiceAccount", name: "afe-argocd-agent", namespace: "afe-argocd-agent" },
      ]);
    }
  });

  it("runs the agent locked down", async () => {
    const docs = await plainDocs();
    const dep = docs.find((d) => d.kind === "Deployment") as {
      spec: { replicas: number; strategy: { type: string }; template: { spec: any } };
    };
    expect(dep.spec.replicas).toBe(1);
    expect(dep.spec.strategy.type).toBe("Recreate");
    const pod = dep.spec.template.spec;
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const c = pod.containers[0];
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(c.resources.limits.memory).toBeDefined();
    expect(c.env.find((e: { name: string }) => e.name === "AFE_AGENT_SECRET")).toBeUndefined();
    expect(pod.volumes[0].secret.secretName).toBe("afe-argocd-agent");
  });

  it("limits egress with a NetworkPolicy", async () => {
    const docs = await plainDocs();
    const np = docs.find((d) => d.kind === "NetworkPolicy") as { spec: any };
    expect(np.spec.policyTypes.sort()).toEqual(["Egress", "Ingress"]);
    expect(np.spec.ingress).toEqual([]);
    expect(np.spec.egress).toHaveLength(3);
  });
});

describe("agent Helm chart", () => {
  const tpl = (f: string) => readFile(path.join(root, "helm/afe-argocd-agent/templates", f), "utf8");

  it("RBAC templates contain only read verbs and only applications/events", async () => {
    const text = await tpl("rbac.yaml");
    const verbs = [...text.matchAll(/verbs:\s*\[([^\]]*)\]/g)].flatMap((m) =>
      m[1]!.split(",").map((v) => v.trim().replace(/"/g, "")),
    );
    expect(verbs.length).toBeGreaterThan(0);
    for (const v of verbs) expect(READ_VERBS.has(v), v).toBe(true);
    const resources = [...text.matchAll(/resources:\s*\[([^\]]*)\]/g)].flatMap((m) =>
      m[1]!.split(",").map((v) => v.trim().replace(/"/g, "")),
    );
    expect(new Set(resources)).toEqual(new Set(["applications", "events"]));
    // Every rules entry uses the inline list form checked above.
    expect(text.match(/verbs:/g)!.length).toBe(text.match(/verbs:\s*\[/g)!.length);
    expect(text).not.toMatch(/secrets|nonResourceURLs/);
  });

  it("deployment template keeps the security context and never templates a secret value", async () => {
    const text = await tpl("deployment.yaml");
    for (const s of [
      "runAsNonRoot: true",
      "readOnlyRootFilesystem: true",
      "allowPrivilegeEscalation: false",
      'drop: ["ALL"]',
      "type: RuntimeDefault",
      "type: Recreate",
    ])
      expect(text).toContain(s);
    expect(text).not.toMatch(/kind:\s*Secret\b/);
    const values = parseAllDocuments(
      await readFile(path.join(root, "helm/afe-argocd-agent/values.yaml"), "utf8"),
    )[0]!.toJS() as { afe: Record<string, unknown> };
    expect(Object.keys(values.afe)).not.toContain("secret");
  });
});
