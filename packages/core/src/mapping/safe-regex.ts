/**
 * A small regular expression engine with a linear-time guarantee, for
 * user-configured mapping rules (AFE-19).
 *
 * JavaScript's `RegExp` backtracks: a pattern such as `(a+)+$` or even
 * `a*a*a*a*b` takes exponential or high-polynomial time on some inputs, and a
 * mapping rule runs on every event of every read. Instead of trying to spot
 * "catastrophic" constructs, patterns are parsed into a restricted syntax
 * (RE2-like: no backreferences, no lookaround) and run as a Thompson NFA
 * (Pike VM without captures): time is O(input length × program size), and
 * both are bounded (`MAX_PATTERN_LENGTH`, `MAX_PROGRAM_SIZE`, values are
 * truncated to `MAX_INPUT_LENGTH`).
 *
 * Supported: literals, `.`, classes `[a-z_]` / `[^...]`, escapes `\d \D \w \W
 * \s \S \t \n \r` and escaped punctuation, anchors `^ $`, word boundaries
 * `\b \B`, groups `( )` and `(?: )`, alternation `|`, quantifiers `* + ?
 * {n} {n,} {n,m}` (n, m ≤ 100; a lazy `?` suffix is accepted and has no
 * effect because only "does it match" is computed). Matching is a search
 * (like `RegExp.test`): anchor with `^…$` for a full match.
 */

export const MAX_PATTERN_LENGTH = 256;
export const MAX_PROGRAM_SIZE = 4000;
export const MAX_REPEAT = 100;
export const MAX_INPUT_LENGTH = 1024;

export class SafeRegexError extends Error {
  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(position === undefined ? message : `${message} (at position ${position + 1})`);
    this.name = "SafeRegexError";
  }
}

type CharTest = (c: number) => boolean;
type AssertKind = "start" | "end" | "word" | "nonword";

type Node =
  | { t: "char"; test: CharTest }
  | { t: "assert"; k: AssertKind }
  | { t: "cat"; items: Node[] }
  | { t: "alt"; alts: Node[] }
  | { t: "rep"; node: Node; min: number; max: number };

type Instr =
  | { op: "char"; test: CharTest }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "assert"; k: AssertKind }
  | { op: "match" };

const isDigit: CharTest = (c) => c >= 48 && c <= 57;
const isWord: CharTest = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpace: CharTest = (c) =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff;
const not =
  (f: CharTest): CharTest =>
  (c) =>
    !f(c);
const NEWLINES = new Set([10, 13, 0x2028, 0x2029]);

const CLASS_ESCAPES: Record<string, CharTest> = {
  d: isDigit,
  D: not(isDigit),
  w: isWord,
  W: not(isWord),
  s: isSpace,
  S: not(isSpace),
};
const CONTROL_ESCAPES: Record<string, number> = { t: 9, n: 10, r: 13, f: 12, v: 11 };

function cp(s: string): number {
  return s.codePointAt(0)!;
}

function foldCase(test: CharTest): CharTest {
  return (c) => {
    if (test(c)) return true;
    const s = String.fromCodePoint(c);
    const lower = s.toLowerCase();
    const upper = s.toUpperCase();
    return (
      (lower !== s && [...lower].length === 1 && test(cp(lower))) ||
      (upper !== s && [...upper].length === 1 && test(cp(upper)))
    );
  };
}

class Parser {
  readonly chars: string[];
  i = 0;
  constructor(
    pattern: string,
    readonly ignoreCase: boolean,
  ) {
    this.chars = [...pattern];
  }

  fail(message: string, at = this.i): never {
    throw new SafeRegexError(message, at);
  }

  peek(): string | undefined {
    return this.chars[this.i];
  }

  parse(): Node {
    const node = this.alt();
    if (this.i < this.chars.length) this.fail("unmatched )");
    return node;
  }

  alt(): Node {
    const alts = [this.cat()];
    while (this.peek() === "|") {
      this.i++;
      alts.push(this.cat());
    }
    return alts.length === 1 ? alts[0]! : { t: "alt", alts };
  }

  cat(): Node {
    const items: Node[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === "|" || c === ")") break;
      const start = this.i;
      const atom = this.atom();
      const q = this.quantifier();
      if (q) {
        if (atom.t === "assert") this.fail("nothing to repeat", start);
        items.push({ t: "rep", node: atom, min: q.min, max: q.max });
      } else items.push(atom);
    }
    return { t: "cat", items };
  }

  quantifier(): { min: number; max: number } | null {
    const c = this.peek();
    let q: { min: number; max: number } | null = null;
    if (c === "*") q = { min: 0, max: Infinity };
    else if (c === "+") q = { min: 1, max: Infinity };
    else if (c === "?") q = { min: 0, max: 1 };
    if (q) this.i++;
    else if (c === "{") {
      const start = this.i;
      const rest = this.chars.slice(this.i, this.i + 12).join("");
      const m = /^\{(\d{1,3})(,(\d{0,3}))?\}/.exec(rest);
      if (!m) this.fail("invalid quantifier: write \\{ for a literal brace", start);
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
        this.fail(`repeat counts above ${MAX_REPEAT} are not supported`, start);
      }
      if (max < min) this.fail("quantifier range out of order", start);
      this.i += [...m[0]].length;
      q = { min, max };
    }
    if (!q) return null;
    if (this.peek() === "?") this.i++; // lazy: same match/no-match answer
    const next = this.peek();
    if (next === "*" || next === "+" || next === "?" || next === "{") {
      this.fail("nested quantifier");
    }
    return q;
  }

  atom(): Node {
    const start = this.i;
    const c = this.chars[this.i++]!;
    switch (c) {
      case "(": {
        if (this.peek() === "?") {
          if (this.chars[this.i + 1] !== ":") {
            this.fail("only (?: ) groups are supported (no lookaround or named groups)", start);
          }
          this.i += 2;
        }
        const inner = this.alt();
        if (this.peek() !== ")") this.fail("missing )", start);
        this.i++;
        return inner;
      }
      case "[":
        return this.charClass(start);
      case ".":
        return this.char((ch) => !NEWLINES.has(ch));
      case "^":
        return { t: "assert", k: "start" };
      case "$":
        return { t: "assert", k: "end" };
      case "\\":
        return this.escape(start);
      case "*":
      case "+":
      case "?":
        return this.fail("nothing to repeat", start);
      case "{":
        return this.fail("invalid quantifier: write \\{ for a literal brace", start);
      default: {
        const code = cp(c);
        return this.char((ch) => ch === code);
      }
    }
  }

  char(test: CharTest): Node {
    return { t: "char", test: this.ignoreCase ? foldCase(test) : test };
  }

  escape(start: number): Node {
    const e = this.chars[this.i++];
    if (e === undefined) this.fail("pattern ends with \\", start);
    if (e === "b") return { t: "assert", k: "word" };
    if (e === "B") return { t: "assert", k: "nonword" };
    const cls = CLASS_ESCAPES[e];
    if (cls) return { t: "char", test: cls };
    const ctl = CONTROL_ESCAPES[e];
    if (ctl !== undefined) return this.char((ch) => ch === ctl);
    if (/[A-Za-z0-9]/.test(e)) {
      this.fail(`escape \\${e} is not supported (no backreferences or unicode classes)`, start);
    }
    const code = cp(e);
    return this.char((ch) => ch === code);
  }

  charClass(start: number): Node {
    let negate = false;
    if (this.peek() === "^") {
      negate = true;
      this.i++;
    }
    const parts: CharTest[] = [];
    let first = true;
    for (;;) {
      const c = this.chars[this.i];
      if (c === undefined) this.fail("missing ]", start);
      if (c === "]" && !first) {
        this.i++;
        break;
      }
      first = false;
      const lo = this.classAtom(start);
      if (typeof lo === "function") {
        parts.push(lo);
        continue;
      }
      if (
        this.peek() === "-" &&
        this.chars[this.i + 1] !== undefined &&
        this.chars[this.i + 1] !== "]"
      ) {
        this.i++;
        const hi = this.classAtom(start);
        if (typeof hi === "function") this.fail("invalid range in character class", start);
        if (hi < lo) this.fail("range out of order in character class", start);
        parts.push((ch) => ch >= lo && ch <= hi);
      } else {
        parts.push((ch) => ch === lo);
      }
    }
    const any: CharTest = (ch) => parts.some((p) => p(ch));
    const folded = this.ignoreCase ? foldCase(any) : any;
    return { t: "char", test: negate ? not(folded) : folded };
  }

  /** A code point, or a predicate for \d \w \s inside a class. */
  classAtom(start: number): number | CharTest {
    const c = this.chars[this.i++]!;
    if (c !== "\\") return cp(c);
    const e = this.chars[this.i++];
    if (e === undefined) this.fail("pattern ends with \\", start);
    const cls = CLASS_ESCAPES[e];
    if (cls) return cls;
    const ctl = CONTROL_ESCAPES[e];
    if (ctl !== undefined) return ctl;
    if (/[A-Za-z0-9]/.test(e)) this.fail(`escape \\${e} is not supported in a class`, start);
    return cp(e);
  }
}

class Compiler {
  prog: Instr[] = [];

  emit(i: Instr): number {
    if (this.prog.length >= MAX_PROGRAM_SIZE) {
      throw new SafeRegexError("pattern is too complex (too many repeats or alternatives)");
    }
    this.prog.push(i);
    return this.prog.length - 1;
  }

  node(n: Node): void {
    switch (n.t) {
      case "char":
        this.emit({ op: "char", test: n.test });
        return;
      case "assert":
        this.emit({ op: "assert", k: n.k });
        return;
      case "cat":
        for (const item of n.items) this.node(item);
        return;
      case "alt": {
        const jumps: number[] = [];
        for (let k = 0; k < n.alts.length; k++) {
          if (k < n.alts.length - 1) {
            const split = this.emit({ op: "split", x: 0, y: 0 });
            (this.prog[split] as { x: number }).x = split + 1;
            this.node(n.alts[k]!);
            jumps.push(this.emit({ op: "jmp", x: 0 }));
            (this.prog[split] as { y: number }).y = this.prog.length;
          } else this.node(n.alts[k]!);
        }
        for (const j of jumps) (this.prog[j] as { x: number }).x = this.prog.length;
        return;
      }
      case "rep": {
        for (let k = 0; k < n.min; k++) this.node(n.node);
        if (n.max === Infinity) {
          const split = this.emit({ op: "split", x: 0, y: 0 });
          (this.prog[split] as { x: number }).x = split + 1;
          this.node(n.node);
          this.emit({ op: "jmp", x: split });
          (this.prog[split] as { y: number }).y = this.prog.length;
        } else {
          const splits: number[] = [];
          for (let k = n.min; k < n.max; k++) {
            const split = this.emit({ op: "split", x: 0, y: 0 });
            (this.prog[split] as { x: number }).x = split + 1;
            splits.push(split);
            this.node(n.node);
          }
          for (const s of splits) (this.prog[s] as { y: number }).y = this.prog.length;
        }
        return;
      }
    }
  }
}

export interface SafeRegex {
  readonly source: string;
  readonly ignoreCase: boolean;
  /** Number of NFA instructions (the per-character cost bound). */
  readonly size: number;
  /** True when the pattern matches somewhere in `input` (like `RegExp.test`). */
  test(input: string): boolean;
}

/** Parses and compiles a pattern; throws `SafeRegexError` for unsupported or oversized patterns. */
export function compileSafeRegex(
  pattern: string,
  options: { ignoreCase?: boolean } = {},
): SafeRegex {
  if (pattern.length === 0) throw new SafeRegexError("pattern is empty");
  if ([...pattern].length > MAX_PATTERN_LENGTH) {
    throw new SafeRegexError(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  const ignoreCase = options.ignoreCase ?? false;
  const ast = new Parser(pattern, ignoreCase).parse();
  const c = new Compiler();
  c.node(ast);
  c.emit({ op: "match" });
  const prog = c.prog;
  return {
    source: pattern,
    ignoreCase,
    size: prog.length,
    test: (input) => run(prog, input),
  };
}

function run(prog: Instr[], value: string): boolean {
  const input: number[] = [];
  for (const ch of value) {
    if (input.length >= MAX_INPUT_LENGTH) break;
    input.push(cp(ch));
  }
  const n = input.length;
  const marks = new Int32Array(prog.length).fill(-1);
  let clist: number[] = [];
  let nlist: number[] = [];
  const stack: number[] = [];
  let matched = false;

  const holds = (k: AssertKind, pos: number): boolean => {
    switch (k) {
      case "start":
        return pos === 0;
      case "end":
        return pos === n;
      case "word":
      case "nonword": {
        const a = pos > 0 && isWord(input[pos - 1]!);
        const b = pos < n && isWord(input[pos]!);
        return k === "word" ? a !== b : a === b;
      }
    }
  };

  // Adds the epsilon closure of `pc` at position `pos` (generation `pos`) to `list`.
  const add = (list: number[], pc0: number, pos: number) => {
    stack.push(pc0);
    while (stack.length > 0) {
      const pc = stack.pop()!;
      if (marks[pc] === pos) continue;
      marks[pc] = pos;
      const ins = prog[pc]!;
      switch (ins.op) {
        case "jmp":
          stack.push(ins.x);
          break;
        case "split":
          stack.push(ins.y, ins.x);
          break;
        case "assert":
          if (holds(ins.k, pos)) stack.push(pc + 1);
          break;
        case "match":
          matched = true;
          break;
        case "char":
          list.push(pc);
          break;
      }
    }
  };

  for (let pos = 0; pos <= n; pos++) {
    add(clist, 0, pos); // unanchored search: a new thread at every position
    if (matched) return true;
    if (pos === n) break;
    const c = input[pos]!;
    for (const pc of clist) {
      const ins = prog[pc] as { op: "char"; test: CharTest };
      if (ins.test(c)) add(nlist, pc + 1, pos + 1);
    }
    if (matched) return true;
    [clist, nlist] = [nlist, clist];
    nlist.length = 0;
  }
  return matched;
}
