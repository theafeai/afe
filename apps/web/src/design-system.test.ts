/**
 * Design-system guard (ADR 0009, docs/design-system.md). Static checks over the
 * web UI sources so new features use the shared tokens and classes instead of
 * drifting. A failure names the rule in docs/design-system.md that it enforces.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const WEB = join(SRC, "..");
const DOC = "docs/design-system.md";

/**
 * Classes used in markup on purpose without their own CSS rule. Each needs a
 * reason; add new ones here only when the class is a hook, never to silence an
 * unstyled element (style it instead).
 */
const SEMANTIC_HOOKS: Record<string, string> = {
  outcome: "family name; styled through outcome-<state>",
  status: "family name; styled through status-<state>",
  method: "family name; styled through method-<method>",
  severity: "family name; styled through severity-<level>",
  "drift-status": "family name; styled through drift-status-<state>",
  "conf-unknown": "default glyph of .badge.conf",
  "kind-deploy": "neutral placement kind; only rollback/manual are emphasised",
  "kind-promotion": "neutral placement kind",
  "kind-redeploy": "neutral placement kind",
  "state-loading": "marks the Loading state for tests",
  "gap-head": "first line of the gap panel; styled by .gap-banners",
  "gap-icon": "glyph inside a gap row; styled by .row-gap",
  "gap-cell": "observation-gap table cell; content only",
  "env-cell-since": "line inside a matrix cell; styled by .env-cell > span",
  "where-env": "label inside a .where row",
  "journey-diagram-wrap": "wrapper around the journey diagram",
  arrow: "SVG marker group; styled through arrow-<confidence>",
  day: "day group in the timeline; styled by .day-heading and .events",
  timeline: "timeline container; layout from its children",
  preview: "mapping preview section; uses .card",
  "conn-line": "line inside a connection list item",
  "field-target": "target filter field; styled by .field",
};

/** Inline style is for data-driven geometry only. */
const INLINE_STYLE_KEYS = new Set([
  "left",
  "top",
  "right",
  "bottom",
  "inset",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "display",
  "transform",
  "gridColumn",
  "gridRow",
]);

/** Files allowed to contain colour literals outside the token blocks. */
const COLOUR_LITERAL_FILES = new Set(["icons.tsx"]); // the brand mark's white glyph

function files(ext: RegExp): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => ext.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(SRC, f));
}
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(WEB, f);
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Removes `:root { … }` blocks (the token definitions), keeping everything else. */
function withoutRootBlocks(css: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = css.indexOf(":root", i);
    if (start < 0) return out + css.slice(i);
    out += css.slice(i, start);
    let depth = 0;
    let j = css.indexOf("{", start);
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
}

/** The body of the first `:root { … }` at or after `from`. */
function rootBlock(css: string, from = 0): string {
  const start = css.indexOf("{", css.indexOf(":root", from));
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}" && --depth === 0) return css.slice(start + 1, j);
  }
  return "";
}

function tokenMap(block: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) m.set(d[1]!, d[2]!.trim());
  return m;
}

const CSS = files(/\.css$/);
const CODE = files(/\.tsx?$/);
const STYLES = join(SRC, "styles.css");
const stylesCss = stripComments(read(STYLES));

function violations(check: (file: string, text: string) => string[], list: string[]): string[] {
  return list.flatMap((f) => check(f, read(f)).map((v) => `${rel(f)}: ${v}`));
}

describe(`design system (${DOC})`, () => {
  it("rule 2: no colour literals outside the token blocks in styles.css", () => {
    const colour = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
    const found = [
      ...violations((f, text) => {
        const css = stripComments(f === STYLES ? withoutRootBlocks(text) : text);
        return css
          .split("\n")
          .filter((l) => colour.test(l))
          .map((l) => l.trim());
      }, CSS),
      ...violations(
        (f, text) =>
          COLOUR_LITERAL_FILES.has(rel(f).replace(/^src\//, ""))
            ? []
            : text
                .split("\n")
                .filter((l) => /["'`]#[0-9a-fA-F]{3,8}["'`]|\b(?:rgba?|hsla?)\(/.test(l))
                .map((l) => l.trim()),
        CODE,
      ),
    ];
    expect(found, `Use a token from styles.css instead (${DOC}, rule 2)`).toEqual([]);
  });

  it("rule 3: every var(--…) is a token defined in styles.css, and only there", () => {
    const defined = new Set([...stylesCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
    const undefinedVars = violations(
      (_f, text) =>
        [...text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!).filter((v) => !defined.has(v)),
      [...CSS, ...CODE],
    );
    const definedElsewhere = violations(
      (_f, text) => [...stripComments(text).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!),
      CSS.filter((f) => f !== STYLES),
    );
    expect(undefinedVars, `Unknown token; add it to styles.css first (${DOC}, rule 3)`).toEqual([]);
    expect(definedElsewhere, `Define tokens only in styles.css (${DOC}, rule 3)`).toEqual([]);
  });

  it("rule 4: only styles.css handles the colour scheme", () => {
    const found = CSS.filter((f) => f !== STYLES && read(f).includes("prefers-color-scheme")).map(
      rel,
    );
    expect(found, `Themes come from tokens, not page overrides (${DOC}, rule 4)`).toEqual([]);
  });

  it("rule 5: every class used in markup is styled or a listed semantic hook", () => {
    const styled = new Set(
      CSS.flatMap((f) => [...stripComments(read(f)).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)]).map(
        (m) => m[1]!,
      ),
    );
    const used = new Map<string, Set<string>>();
    for (const f of CODE.filter((f) => f.endsWith(".tsx"))) {
      const text = read(f);
      const literals = [
        ...[...text.matchAll(/className=\{`([^`]*)`\}/g)].map((m) => m[1]!),
        ...[...text.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!),
        ...[...text.matchAll(/className=\{([^{}`]*)\}/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([^"]*)"/g)].map((s) => s[1]!),
        ),
      ];
      for (const lit of literals)
        for (const word of lit.replace(/\$\{[^}]*\}/g, "\0").split(/\s+/))
          if (word && !word.includes("\0"))
            used.set(word, (used.get(word) ?? new Set()).add(rel(f)));
    }
    const unstyled = [...used]
      .filter(([c]) => !styled.has(c) && !(c in SEMANTIC_HOOKS))
      .map(([c, where]) => `.${c} (${[...where].join(", ")})`);
    const stale = Object.keys(SEMANTIC_HOOKS).filter((c) => !used.has(c) || styled.has(c));
    expect(
      unstyled,
      `Unstyled class: use an existing class, add CSS, or list a real hook in SEMANTIC_HOOKS (${DOC}, rule 5)`,
    ).toEqual([]);
    expect(stale, "SEMANTIC_HOOKS entries that are unused or now styled; remove them").toEqual([]);
  });

  it("rule 6: inline style is for geometry only", () => {
    const found = violations(
      (_f, text) =>
        [...text.matchAll(/style=\{\{([^}]*)\}\}/g)].flatMap((m) =>
          [...m[1]!.matchAll(/(\w+)\s*:/g)]
            .map((k) => k[1]!)
            .filter((k) => !INLINE_STYLE_KEYS.has(k))
            .map((k) => `style key "${k}"`),
        ),
      CODE.filter((f) => f.endsWith(".tsx")),
    );
    expect(found, `Use a class for visual styling (${DOC}, rule 6)`).toEqual([]);
  });

  it("rule 7: fonts come only from the tokens, never from a CDN", () => {
    const badFamily = violations(
      (_f, text) =>
        [...stripComments(text).matchAll(/font-family\s*:\s*([^;]+);/g)]
          .map((m) => m[1]!.trim())
          .filter((v) => !/^(var\(--(font|mono)\)|inherit)$/.test(v)),
      CSS,
    );
    const external = violations(
      (_f, text) => (text.match(/url\(\s*["']?https?:/g) ?? []).map(() => "external url()"),
      CSS,
    );
    const html = read(join(WEB, "index.html"));
    expect(badFamily, `Use var(--font) or var(--mono) (${DOC}, rule 7)`).toEqual([]);
    expect(external, `Bundle assets instead of loading them remotely (${DOC}, rule 7)`).toEqual([]);
    expect(/<link[^>]+href="https?:/.test(html), "index.html must not load remote assets").toBe(
      false,
    );
  });

  describe("rule 8: text tokens meet WCAG AA in both themes", () => {
    const light = tokenMap(rootBlock(stylesCss));
    const dark = tokenMap(rootBlock(stylesCss, stylesCss.indexOf("prefers-color-scheme: dark")));

    type Rgba = [number, number, number, number];
    function colour(theme: Map<string, string>, name: string): Rgba {
      let v = theme.get(name) ?? light.get(name);
      for (let i = 0; v?.startsWith("var("); i++) {
        if (i > 5) break;
        const ref = /var\((--[\w-]+)\)/.exec(v)![1]!;
        v = theme.get(ref) ?? light.get(ref);
      }
      if (!v) throw new Error(`token ${name} is not defined`);
      const hex = /^#([0-9a-f]{6})$/i.exec(v);
      if (hex) {
        const n = parseInt(hex[1]!, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
      }
      const rgba = /^rgba?\(([^)]+)\)$/.exec(v);
      if (rgba) {
        const [r, g, b, a = 1] = rgba[1]!.split(",").map((x) => Number(x.trim()));
        return [r!, g!, b!, a];
      }
      throw new Error(`token ${name} must be a 6-digit hex or rgb(a) colour, got "${v}"`);
    }
    const over = (fg: Rgba, bg: Rgba): Rgba => [
      fg[0] * fg[3] + bg[0] * (1 - fg[3]),
      fg[1] * fg[3] + bg[1] * (1 - fg[3]),
      fg[2] * fg[3] + bg[2] * (1 - fg[3]),
      1,
    ];
    const luminance = ([r, g, b]: Rgba) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: Rgba, b: Rgba) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };

    const TEXT = ["--text", "--text-2", "--muted", "--accent", "--conf-strong"];
    const SIGNAL = ["--ok", "--bad", "--warn", "--recon", "--backfill"];
    const SURFACES = ["--bg", "--surface", "--surface-2"];

    for (const [name, theme] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      it(`${name} theme`, () => {
        const failures: string[] = [];
        const page = colour(theme, "--surface");
        const check = (fg: string, bgName: string, bg: Rgba) => {
          const r = ratio(over(colour(theme, fg), bg), bg);
          if (r < 4.5) failures.push(`${fg} on ${bgName}: ${r.toFixed(2)}:1`);
        };
        for (const fg of [...TEXT, ...SIGNAL])
          for (const s of SURFACES) check(fg, s, over(colour(theme, s), page));
        for (const fg of SIGNAL) check(fg, `${fg}-bg`, over(colour(theme, `${fg}-bg`), page));
        check("--accent", "--accent-soft", over(colour(theme, "--accent-soft"), page));
        check("--on-accent", "--accent-solid", colour(theme, "--accent-solid"));
        expect(failures, `Contrast below 4.5:1 (${DOC}, rule 8)`).toEqual([]);
      });
    }
  });
});
