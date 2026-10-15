/**
 * A policy is the decision's own text, versioned as small edits against what the code sends.
 *
 * Text is cut into clauses (a line, a sentence, or a "; " item). A version is a list of clause
 * edits, anchored on the clause text they change. Applying a version is a three-way merge at
 * clause granularity: the code's current text is the base, so text the code adds or changes
 * elsewhere comes through untouched. When the code changed a clause the version also edits,
 * the code wins and that edit is skipped ("retired"); the UI warns about it.
 */

/**
 * `nth` picks among clauses with the same text (0 = the first), e.g. the second "Otherwise, no."
 * An insert goes after or before its anchor clause; with `start` at the beginning; with neither, at the end.
 */
export type Op =
  | { op: "replace"; clause: string; text: string; nth?: number }
  | { op: "delete"; clause: string; nth?: number }
  | { op: "insert"; after: string | null; before: string | null; text: string; nth?: number; start?: boolean };

/** part -> edits against the code's text of that part. Parts: "description", "instructions", "criteria.true", ... */
export type Doc = Record<string, Op[]>;

/** A list marker on its own ("1", "b") stays with the item it starts. */
const LIST = /^\s*(?:\d{1,3}|[a-zA-Z])$/;

/** Cuts text into clauses that join back to exactly the text. Each clause keeps its trailing whitespace. */
export function split(text: string): string[] {
  const out: string[] = [];
  const re = /[.;!?]+(?:\s+|$)|\n\s*/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m[0][0] === "." && LIST.test(text.slice(last, m.index))) continue;
    out.push(text.slice(last, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** How clauses are compared: whitespace doesn't count. */
export const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const core = (c: string) => c.replace(/\s+$/, "");

/**
 * One piece of merged text. `i` is the index of the code's clause it comes from; added text has
 * none, and `rep` says which clause it replaced, if any.
 */
export interface Unit { text: string; sep: string; i: number | null; kind: "keep" | "del" | "add"; rep?: number }

/** Applies `ops` to `text`, clause by clause. `retired` lists the ops whose clause the text no longer has. */
export function weave(text: string, ops: Op[]): { units: Unit[]; retired: number[] } {
  const cl = split(text), keys = cl.map(norm);
  const occ = (key: string, nth = 0) => { for (let i = 0, c = 0; i < keys.length; i++) if (keys[i] === key && c++ === nth) return i; return -1; };
  const rep = new Map<number, string | null>();
  const after = new Map<number, string[]>(), before = new Map<number, string[]>(), head: string[] = [], end: string[] = [];
  const retired: number[] = [];
  const push = (m: Map<number, string[]>, i: number, t: string) => (m.get(i) ?? m.set(i, []).get(i)!).push(t);
  (ops ?? []).forEach((o, k) => {
    if (o.op === "insert") {
      if (o.start) return void head.push(o.text);
      const anchor = o.after ?? o.before;
      if (anchor == null) return void end.push(o.text);
      const i = occ(anchor, o.nth);
      if (i < 0) retired.push(k);
      else push(o.after != null ? after : before, i, o.text);
    } else {
      const i = occ(o.clause, o.nth);
      if (i < 0 || rep.has(i)) retired.push(k);
      else rep.set(i, o.op === "replace" ? o.text : null);
    }
  });
  const units: Unit[] = [];
  const add = (t: string, sep: string, r?: number) => { if (norm(t)) units.push({ text: t.trim(), sep, i: null, kind: "add", ...(r != null ? { rep: r } : {}) }); };
  const firstSep = cl.length ? cl[0].slice(core(cl[0]).length) : "";
  for (const t of head) add(t, firstSep);
  cl.forEach((c, i) => {
    const sep = c.slice(core(c).length);
    for (const t of before.get(i) ?? []) add(t, sep);
    if (rep.has(i)) {
      units.push({ text: core(c), sep, i, kind: "del" });
      const r = rep.get(i);
      if (r != null) add(r, sep, i);
    } else units.push({ text: core(c), sep, i, kind: "keep" });
    for (const t of after.get(i) ?? []) add(t, sep);
  });
  for (const t of end) add(t, "");
  return { units, retired };
}

/** Joins the units that are in the merged text, so that separators read naturally. */
export function join(units: Unit[], original: string): string {
  const seps = split(original).map(c => c.slice(core(c).length)).filter(Boolean);
  const dflt = seps.some(s => s.includes("\n")) && seps.filter(s => s.includes("\n")).length * 2 >= seps.length ? "\n" : " ";
  const vis = units.filter(u => u.kind !== "del");
  const trail = original.slice(core(original).length);
  return vis.map((u, j) => u.text + (j === vis.length - 1 ? trail : u.sep || dflt)).join("");
}

export function patch(text: string, ops: Op[]): { text: string; retired: number[] } {
  if (!ops?.length) return { text, retired: [] };
  const w = weave(text, ops);
  return { text: join(w.units, text), retired: w.retired };
}

// ---------------- diff: new text -> edits ----------------

/**
 * One clause of the code's text, as the template sees it. `fixed` is the id of the run of text that
 * can't be edited (it varies per call, or is locked); editable clauses have none.
 */
export interface Slot { key: string; fixed: number | null }

/** `⟦3⟧` in text stands for fixed run 3. */
export const marker = (id: number) => `⟦${id}⟧`;
const MARK = /⟦(\d+)⟧/;

type Tok = { id: string; key?: string; nth?: number; text?: string; sep?: string; mark?: number };

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  text.split(/(⟦\d+⟧)/).forEach((chunk, k) => {
    if (k % 2) { const id = Number(chunk.match(MARK)![1]); out.push({ id: "m" + id, mark: id }); return; }
    for (const c of split(chunk)) { const key = norm(c); if (key) out.push({ id: "c" + key, key, text: core(c).trim(), sep: c.slice(core(c).length) }); }
  });
  return out;
}

function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length, t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return out;
}

const nth = (t: Tok) => (t.nth ? { nth: t.nth } : {});

/**
 * The edits that turn the code's text (as `slots`) into `target`, where target may contain the
 * markers of fixed runs. Fixed text is never edited: a dropped marker keeps its text.
 */
export function diff(slots: Slot[], target: string): Op[] {
  const a: Tok[] = [], count = new Map<string, number>();
  for (const s of slots) {
    if (!s.key) continue;
    const n = count.get(s.key) ?? 0;
    count.set(s.key, n + 1);
    if (s.fixed == null) a.push({ id: "c" + s.key, key: s.key, nth: n });
    else if (a.at(-1)?.mark !== s.fixed) a.push({ id: "m" + s.fixed, mark: s.fixed });
  }
  const b = tokens(target);
  const pairs = [...lcs(a.map(x => x.id), b.map(x => x.id)), [a.length, b.length] as [number, number]];
  type Anchor = { after: string | null; before: string | null; nth?: number; start?: boolean };
  const after = (t: Tok): Anchor => ({ after: t.key!, before: null, ...nth(t) });
  const before = (t: Tok): Anchor => ({ after: null, before: t.key!, ...nth(t) });
  const ops: Op[] = [];
  let pi = 0, pj = 0;
  for (const [ai, bj] of pairs) {
    const gone = a.slice(pi, ai).filter(x => x.key), come = b.slice(pj, bj).filter(x => x.key);
    // where the gap has no clause of the code's own, anchor on an editable clause right next to it
    // (fixed text varies per call, so it can't be an anchor)
    const p = a[pi - 1], q = a[ai];
    const prev = [...a.slice(0, pi)].reverse().find(x => x.key), next = a.slice(ai).find(x => x.key);
    const edge: Anchor = p?.key ? after(p) : q?.key ? before(q) : !q ? { after: null, before: null }
      : pi === 0 ? { after: null, before: null, start: true }
      : prev ? after(prev) : next ? before(next) : { after: null, before: null };
    let last: Tok | null = null, pending: Tok[] = [];
    const flush = (at: Tok | null) => {
      if (!pending.length) return;
      const text = pending.map((x, i) => x.text + (i < pending.length - 1 ? x.sep || " " : "")).join("");
      ops.push({ op: "insert", ...(last ? after(last) : at ? before(at) : edge), text });
      pending = [];
    };
    for (const st of align(gone.map(x => x.key!), come.map(x => x.key!))) {
      if (st.g == null) { pending.push(come[st.c!]); continue; }
      const g = gone[st.g];
      flush(g);
      ops.push(st.c != null ? { op: "replace", clause: g.key!, text: come[st.c].text!, ...nth(g) } : { op: "delete", clause: g.key!, ...nth(g) });
      last = g;
    }
    flush(null);
    pi = ai + 1; pj = bj + 1;
  }
  return ops;
}

const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
/** How alike two clauses are, 0..1 (Dice over words): a rewritten clause still shares most of its words. */
function similar(a: string, b: string): number {
  const x = words(a), y = words(b);
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return (2 * n) / Math.max(1, x.size + y.size);
}
const ALIKE = 0.4;

/**
 * Lines up a stretch of removed clauses with a stretch of new ones, in order: a new clause that
 * reads like a removed one replaces it; the rest are deletions and insertions where they stand.
 */
function align(g: string[], c: string[]): { g?: number; c?: number }[] {
  const n = g.length, m = c.length;
  if (!n || !m || n * m > 200_000) return [...g.map((_, i) => ({ g: i })), ...c.map((_, j) => ({ c: j }))];
  const sim = Array.from({ length: n }, (_, i) => Float64Array.from(c, x => { const s = similar(g[i], x); return s >= ALIKE ? s : 0; }));
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], sim[i][j] ? sim[i][j] + dp[i + 1][j + 1] : 0);
  const out: { g?: number; c?: number }[] = [];
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && sim[i][j] && dp[i][j] === sim[i][j] + dp[i + 1][j + 1]) out.push({ g: i++, c: j++ });
    else if (i < n && (j >= m || dp[i][j] === dp[i + 1][j])) out.push({ g: i++ });
    else out.push({ c: j++ });
  }
  return out;
}

/**
 * Re-anchors edits written against an older text (`was`: its editable clause keys) onto the code's
 * current one (`now`: the newest call's clause keys), pairing each clause the code rewrote with the
 * most alike new clause. `stable` are clauses nearly every call sends: an edit of one stays as it is
 * (a call that lacks it is no code change), and only they serve as new anchors.
 */
export function rebase(ops: Op[], was: string[], now: string[], stable: Set<string> = new Set(now)): Op[] {
  const map = new Map<string, string>();
  for (const k of now) if (was.includes(k)) map.set(k, k);
  const pairs = [...lcs(was, now), [was.length, now.length] as [number, number]];
  let pi = 0, pj = 0;
  for (const [i, j] of pairs) {
    const come = now.slice(pj, j), taken = new Set<number>();
    for (const g of was.slice(pi, i)) {
      let best = -1, score = ALIKE;
      come.forEach((c, k) => { const s = similar(g, c); if (!taken.has(k) && s >= score) { best = k; score = s; } });
      if (best >= 0) { taken.add(best); map.set(g, come[best]); }
    }
    pi = i + 1; pj = j + 1;
  }
  // where k was: after the closest earlier clause that still stands, else at the start
  const near = (k: string, text: string): Op => {
    for (let i = was.indexOf(k) - 1; i >= 0; i--) {
      const m = map.get(was[i]);
      if (m && stable.has(m)) return { op: "insert", after: m, before: null, text };
    }
    return { op: "insert", after: null, before: null, start: true, text };
  };
  const out: Op[] = [];
  for (const o of ops) {
    if (o.op === "insert") {
      const a = o.after ?? o.before;
      if (a == null || now.includes(a) || stable.has(a)) out.push(o);
      else if (map.has(a)) out.push(o.after != null ? { ...o, after: map.get(a)!, nth: undefined } : { ...o, before: map.get(a)!, nth: undefined });
      else out.push(near(a, o.text));
    } else if (now.includes(o.clause) || stable.has(o.clause)) out.push(o);
    else if (map.has(o.clause)) out.push({ ...o, clause: map.get(o.clause)!, nth: undefined });
    else if (o.op === "replace") out.push(near(o.clause, o.text));
    // a delete of a clause the code already removed: nothing left to do
  }
  return out.map(o => JSON.parse(JSON.stringify(o)));      // drop undefined fields
}
