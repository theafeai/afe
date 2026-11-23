/**
 * Design-system guard (ADR 0009, ADR 0017, docs/design-system.md). Static checks
 * over the web UI sources so new features use the shared tokens and classes
 * instead of drifting, and so each colour keeps its job: tools their brand
 * colours, status its solid shapes, Afe its spectrum. A failure names the rule in
 * docs/design-system.md that it enforces.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OUTCOMES } from "@afe/core";
import { HealthBadge, OutcomeBadge, StatusBadge } from "./components.tsx";
import { TOOL_PATHS } from "./icons.tsx";

const SRC = dirname(fileURLToPath(import.meta.url));
const WEB = join(SRC, "..");
const DOC = "docs/design-system.md";

/**
 * Classes used in markup on purpose without their own CSS rule. Each needs a
 * reason; add new ones here only when the class is a hook, never to silence an
 * unstyled element (style it instead).
 */
const SEMANTIC_HOOKS: Record<string, string> = {
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

/** Files allowed to contain colour literals outside the token blocks (none). */
const COLOUR_LITERAL_FILES = new Set<string>();

/**
 * ADR 0017 decision 5: the selectors that may read Afe's spectrum (--sp-*,
 * --spectrum, --aurora and any token built from them), grouped by the spectrum's
 * five jobs. Every selector of a rule that reads the spectrum must contain one of
 * these. Adding a selector here is a design decision: record it in ADR 0017.
 */
const SPECTRUM_SELECTORS: Record<string, string[]> = {
  "Afe itself (brand, aurora, title accent, active nav)": [
    ".brand-dot",
    "main::before",
    ".h-acc",
    ".page-header h1",
    '[aria-current="page"]',
  ],
  "selection and focus": [
    ":focus-visible",
    '[aria-pressed="true"]',
    '[aria-selected="true"]',
    ".avatar",
  ],
  live: [".pulse", ".spin"],
  "Afe's inferences": [".inf-dot"],
  "all tools together": [".spark", ".key-sp"],
};

/** Selectors that show a status; tool colours never appear in them (ADR 0017 decision 8). */
const STATUS_SELECTOR =
  /\.(?:s-[\w-]+|si|tri|outcome[\w-]*|flag|gap-[\w-]+|conf[\w-]*|health[\w-]*|status[\w-]*|severity[\w-]*|drift-status[\w-]*|alert-[\w-]+|callout-(?:error|ok|gap))(?![\w-])/;
/** Selectors that show a tool; status colours never appear in them. */
const TOOL_SELECTOR = /\.(?:t-[\w-]+|lg(?:-[\w-]+)?|tm|tool-badge|tool-mark)(?![\w-])/;
const STATUS_TOKEN = /var\(--(?:(?:ok|warn|bad)(?:-[\w-]+)?|conf-[\w-]+|s|s-text)\)/;

/**
 * Page files that render tool marks without their own <ToolLegend> (ADR 0017
 * decision 3), each with the reason. Everything else that colour-codes tools
 * shows the legend.
 */
const LEGEND_EXEMPT: Record<string, string> = {
  "ContainmentPanel.tsx": "embedded in the event detail and journey pages",
  "PlacementHistory.tsx": "embedded in the Environments page, which has the legend",
  "EventDetail.tsx": "one event from one tool, named next to its mark",
  "Mapping.tsx": "setup screen; every mark sits next to its tool's name",
  "Users.tsx": "account sections, one per tool, each titled with the tool's name",
};

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

/** Every innermost `selector { body }` rule, outside the :root token blocks. */
function cssRules(css: string): { selectors: string[]; body: string }[] {
  return [...withoutRootBlocks(stripComments(css)).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!
      .trim()
      .split(",")
      .map((x) => x.trim().replace(/\s+/g, " ")),
    body: m[2]!,
  }));
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
    const pkg = JSON.parse(read(join(WEB, "package.json"))) as {
      dependencies: Record<string, string>;
    };
    const fontPackages = [
      ...Object.keys(pkg.dependencies).filter((d) => d.startsWith("@fontsource")),
      ...[...read(join(SRC, "main.tsx")).matchAll(/import "(@fontsource[^"]+)"/g)].map(
        (m) => m[1]!,
      ),
    ];
    expect(
      [...new Set(fontPackages)].sort(),
      `Fonts are Geist and Geist Mono, bundled (${DOC}, rule 7)`,
    ).toEqual(["@fontsource-variable/geist", "@fontsource-variable/geist-mono"]);
    expect(badFamily, `Use var(--font) or var(--mono) (${DOC}, rule 7)`).toEqual([]);
    expect(external, `Bundle assets instead of loading them remotely (${DOC}, rule 7)`).toEqual([]);
    expect(/<link[^>]+href="https?:/.test(html), "index.html must not load remote assets").toBe(
      false,
    );
  });

  it("rule 4: the in-app dark theme uses exactly the OS dark theme's tokens", () => {
    const media = tokenMap(rootBlock(stylesCss, stylesCss.indexOf("prefers-color-scheme: dark")));
    const chosen = tokenMap(rootBlock(stylesCss, stylesCss.indexOf(':root[data-theme="dark"]')));
    expect(chosen.size, 'styles.css needs a :root[data-theme="dark"] block').toBeGreaterThan(0);
    expect(
      Object.fromEntries(chosen),
      `Keep the two dark blocks identical (${DOC}, rule 4)`,
    ).toEqual(Object.fromEntries(media));
  });

  const light = tokenMap(rootBlock(stylesCss));
  const dark = tokenMap(rootBlock(stylesCss, stylesCss.indexOf("prefers-color-scheme: dark")));
  const THEMES = [
    ["light", light],
    ["dark", dark],
  ] as const;
  const TOOLS = Object.keys(TOOL_PATHS);
  const SURFACES = ["--bg", "--surface", "--surface-2"];

  type Rgba = [number, number, number, number];
  const lookup = (theme: Map<string, string>, name: string) => theme.get(name) ?? light.get(name);
  /** Resolves a token to a colour: hex, rgb(a), var() chains and color-mix(in srgb, …). */
  function colour(theme: Map<string, string>, name: string): Rgba {
    const v = lookup(theme, name);
    if (!v) throw new Error(`token ${name} is not defined`);
    return parse(theme, v, name);
  }
  function percent(theme: Map<string, string>, v: string): number {
    const ref = /^var\((--[\w-]+)\)$/.exec(v.trim());
    const raw = ref ? lookup(theme, ref[1]!) : v;
    const n = /^([\d.]+)%$/.exec((raw ?? "").trim());
    if (!n) throw new Error(`expected a percentage, got "${v}"`);
    return Number(n[1]) / 100;
  }
  function parse(theme: Map<string, string>, v: string, name: string): Rgba {
    v = v.trim();
    if (v === "transparent") return [0, 0, 0, 0];
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) return colour(theme, ref[1]!);
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
    const mix =
      /^color-mix\(in srgb,\s*(var\(--[\w-]+\)|[\w#]+)\s+([^,]+),\s*(var\(--[\w-]+\)|[\w#]+)\)$/.exec(
        v,
      );
    if (mix) {
      const p = percent(theme, mix[2]!);
      const a = parse(theme, mix[1]!, name);
      const b = parse(theme, mix[3]!, name);
      // CSS color-mix with premultiplied alpha.
      const alpha = a[3] * p + b[3] * (1 - p);
      const ch = (i: number) =>
        alpha === 0 ? 0 : (a[i]! * a[3] * p + b[i]! * b[3] * (1 - p)) / alpha;
      return [ch(0), ch(1), ch(2), alpha];
    }
    throw new Error(`token ${name} must be a hex, rgb(a) or color-mix colour, got "${v}"`);
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
  /** Contrast of token `fg` over token `bg`, both composited on the page surface. */
  function pair(theme: Map<string, string>, fg: string, bg: string): number {
    const page = colour(theme, "--surface");
    const b = over(colour(theme, bg), page);
    return ratio(over(colour(theme, fg), b), b);
  }

  describe("rule 8: text tokens meet WCAG AA (4.5:1) in both themes", () => {
    const TEXT = [
      "--text",
      "--text-2",
      "--muted",
      "--accent",
      "--ok-text",
      "--warn-text",
      "--bad-text",
      ...TOOLS.map((t) => `--${t}-text`),
    ];
    for (const [name, theme] of THEMES) {
      it(`${name} theme`, () => {
        const failures: string[] = [];
        const check = (fg: string, bg: string) => {
          const r = pair(theme, fg, bg);
          if (r < 4.5) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}:1`);
        };
        for (const fg of TEXT) for (const s of SURFACES) check(fg, s);
        for (const tone of ["ok", "bad", "warn"]) check(`--${tone}-text`, `--${tone}-bg`);
        check("--accent", "--accent-soft");
        check("--on-accent", "--accent-solid");
        // A tool's logo on its own tile.
        for (const t of TOOLS) check(`--${t}-text`, `--${t}-tile`);
        expect(failures, `Contrast below 4.5:1 (${DOC}, rule 8)`).toEqual([]);
      });
    }
  });

  describe("rule 9: tool and status strokes meet 3:1 (WCAG 1.4.11) in both themes", () => {
    const STROKES = ["--ok", "--warn", "--bad", ...TOOLS.map((t) => `--${t}`)];
    for (const [name, theme] of THEMES) {
      it(`${name} theme`, () => {
        const failures: string[] = [];
        for (const fg of STROKES)
          for (const s of SURFACES) {
            const r = pair(theme, fg, s);
            if (r < 3) failures.push(`${fg} on ${s}: ${r.toFixed(2)}:1`);
          }
        expect(failures, `Non-text contrast below 3:1 (${DOC}, rule 9)`).toEqual([]);
      });
    }
  });

  it("rule 9: --muted text keeps 4.5:1 on the densest point of the page aurora", () => {
    const failures: string[] = [];
    for (const [name, theme] of THEMES) {
      const a = percent(theme, "var(--aurora)");
      const bg = colour(theme, "--bg");
      for (const sp of ["--sp-1", "--sp-2", "--sp-3", "--sp-4"]) {
        const c = colour(theme, sp);
        const wash = over([c[0], c[1], c[2], a], bg);
        const r = ratio(over(colour(theme, "--muted"), wash), wash);
        if (r < 4.5) failures.push(`${name}: --muted over ${sp} aurora: ${r.toFixed(2)}:1`);
      }
    }
    expect(failures, `Lower --aurora (${DOC}, rule 9)`).toEqual([]);
  });

  it("rule 10: every tool has stroke, text and tile tokens in both themes and a .t- class", () => {
    const missing: string[] = [];
    for (const t of TOOLS) {
      for (const token of [`--${t}`, `--${t}-text`, `--${t}-tile`]) {
        if (!light.has(token)) missing.push(`${token} (light)`);
        if (!dark.has(token)) missing.push(`${token} (dark)`);
      }
      const rule = cssRules(stylesCss).find((r) => r.selectors.includes(`.t-${t}`));
      for (const v of ["--t", "--t-text", "--t-tile"])
        if (!rule || !new RegExp(`${v}\\s*:`).test(rule.body)) missing.push(`.t-${t} { ${v} }`);
    }
    expect(missing, `A new tool needs its colours before it ships (${DOC}, rule 10)`).toEqual([]);
  });

  it("rule 11: the spectrum is used only for its five jobs", () => {
    // Tokens that are, or are built from, the spectrum.
    const spectral = new Set(["--sp-1", "--sp-2", "--sp-3", "--sp-4", "--spectrum", "--aurora"]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [k, v] of light)
        if (!spectral.has(k) && [...spectral].some((t) => v.includes(`var(${t})`)))
          grew = Boolean(spectral.add(k));
    }
    const reads = (body: string) => [...spectral].some((t) => body.includes(`var(${t})`));
    const allowed = Object.values(SPECTRUM_SELECTORS).flat();
    const found = violations(
      (_f, text) =>
        cssRules(text)
          .filter((r) => reads(r.body))
          .flatMap((r) => r.selectors.filter((sel) => !allowed.some((a) => sel.includes(a)))),
      CSS,
    );
    const inCode = violations(
      (_f, text) =>
        [...text.matchAll(/--(?:sp-\d|spectrum|aurora)\b/g)].map((m) => `${m[0]} in code`),
      CODE,
    );
    expect(
      [...found, ...inCode],
      `The spectrum is Afe's, for the jobs in SPECTRUM_SELECTORS only (${DOC}, rule 11)`,
    ).toEqual([]);
  });

  it("rule 12: tool colours never show a status, and status colours never mark a tool", () => {
    const toolToken = new RegExp(
      `var\\(--(?:${TOOLS.join("|")})(?:-text|-tile)?\\)|var\\(--t(?:-text|-tile)?\\)`,
    );
    const found = violations(
      (_f, text) =>
        cssRules(text).flatMap((r) =>
          r.selectors.flatMap((sel) => [
            ...(STATUS_SELECTOR.test(sel) && toolToken.test(r.body)
              ? [`${sel}: tool colour on a status`]
              : []),
            ...(TOOL_SELECTOR.test(sel) && STATUS_TOKEN.test(r.body)
              ? [`${sel}: status colour on a tool`]
              : []),
          ]),
        ),
      CSS,
    );
    expect(found, `Colours keep their jobs (${DOC}, rule 12)`).toEqual([]);
  });

  it("rule 13: status is a solid shape plus a word", () => {
    const shape = /class="(?:si|tri|spin)"/;
    const failures: string[] = [];
    const render = (label: string, el: ReturnType<typeof createElement>, word: string) => {
      const html = renderToStaticMarkup(el);
      if (!shape.test(html)) failures.push(`${label}: no solid shape`);
      if (!html.toLowerCase().includes(word.toLowerCase())) failures.push(`${label}: no word`);
      if (/class="icon"/.test(html)) failures.push(`${label}: outline icon`);
    };
    for (const o of OUTCOMES.filter((o) => o !== "none"))
      render(`OutcomeBadge ${o}`, createElement(OutcomeBadge, { outcome: o }), o.split("_")[0]!);
    for (const h of ["healthy", "degraded", "unreachable", "unknown"] as const)
      render(`HealthBadge ${h}`, createElement(HealthBadge, { state: h }), "");
    for (const st of ["active", "revoked", "disconnected"])
      render(`StatusBadge ${st}`, createElement(StatusBadge, { status: st }), st);
    // Status families are rendered through StatusWord, never as a bare span.
    const bare = violations(
      (_f, text) =>
        [
          ...text.matchAll(
            /className=["{`][^"}`]*\bbadge (?:outcome|health|status|severity|drift-status)\b/g,
          ),
        ].map((m) => m[0]),
      CODE.filter((f) => f.endsWith(".tsx")),
    );
    expect([...failures, ...bare], `Use StatusWord / StatusMark (${DOC}, rule 13)`).toEqual([]);
  });

  it("rule 14: no built-in styling for environment names or kinds", () => {
    const envWord =
      /(?:\.|-)(?:dev|development|staging|stage|prod|production|preview|qa|uat)(?![\w-])|\[data-(?:kind|env)\b/;
    const found = violations(
      (_f, text) => cssRules(text).flatMap((r) => r.selectors.filter((sel) => envWord.test(sel))),
      CSS,
    );
    expect(
      found,
      `Environments are the org's; style only .pl (production-like) (${DOC}, rule 14)`,
    ).toEqual([]);
  });

  it("typography: sentence case, never uppercase transforms", () => {
    const found = violations(
      (_f, text) =>
        cssRules(text)
          .filter((r) => /text-transform\s*:\s*uppercase/.test(r.body))
          .flatMap((r) => r.selectors),
      CSS,
    );
    expect(found, `Sentence case everywhere (${DOC}, Typography)`).toEqual([]);
  });

  it("rule 15: every page that colour-codes tools shows the tool legend", () => {
    const pages = CODE.filter((f) => /\/pages\/[^/]+\.tsx$/.test(f));
    const marks = /<ToolBadge\b|<ToolMark\b|className=[^>]*\bt-\$\{|className="[^"]*\bt-[a-z]/;
    const missing = pages
      .filter((f) => marks.test(read(f)) && !read(f).includes("<ToolLegend"))
      .map((f) => basename(f))
      .filter((f) => !(f in LEGEND_EXEMPT));
    const stale = Object.keys(LEGEND_EXEMPT).filter(
      (f) => !pages.some((p) => basename(p) === f && marks.test(read(p))),
    );
    expect(missing, `Render <ToolLegend> under the page header (${DOC}, rule 15)`).toEqual([]);
    expect(stale, "LEGEND_EXEMPT entries that no longer render tool marks; remove them").toEqual(
      [],
    );
  });
});
