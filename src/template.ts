/**
 * Which of a decision's text the code sends the same way every time (static: decidus may tune it),
 * and which varies per call (dynamic: an article, a customer's rule, per-company options). Read
 * from the newest calls in a scope, like log-template mining: a clause is static when nearly every
 * call has it. Until a scope has enough calls, decidus only observes.
 */
import { join, marker, norm, split, weave, type Doc, type Op, type Slot } from "./clauses.js";
import { routeOf, textParts } from "./shapes.js";
import type { Store } from "./store.js";

export interface Clause {
  text: string; key: string;
  /** Not in nearly every call: it varies (an article, a customer's rule). Never edited. */
  dyn: boolean;
  /** Static, but people locked it. Never edited. */
  locked: boolean;
  /** The run of non-editable text this clause belongs to, shown as ⟦fixed⟧ to the writer. */
  fixed: number | null;
  /** Share of the observed calls with this part that send this clause, 0..1. */
  share: number;
}
/**
 * `n`: observed calls that have this part. `stable`: static clauses the newest calls still send;
 * a static clause they all lack was just changed by the code.
 */
export interface PartT { part: string; code: string; clauses: Clause[]; static: string[]; stable: string[]; n: number }
export interface Template {
  /** Enough calls seen to tell static from dynamic. */
  ready: boolean; seen: number; need: number;
  /** The decision's text in the newest call, part by part. */
  parts: PartT[];
  sample: number | null;
}

/** A clause is static when at least this share of the calls that have its part have it. */
const SHARE = 0.8;
/** How many of the newest calls show what the code sends now. */
const RECENT = 3;

/** `pin`: show the text of this call instead of the newest one (an edit is saved against the call it was made on). */
export function build(samples: { id: number; spec: string | null; url: string; request: any }[], policy: string,
  locks: Record<string, string[]>, need: number, pin?: number): Template {
  const counts = new Map<string, { n: number; keys: Map<string, number>; recent: Set<string> }>();
  let latest: { id: number; parts: Record<string, string> } | null = null;
  for (const s of samples) {
    const route = s.url ? routeOf(new URL(s.url).pathname) : null;
    const parts = route ? textParts(route, s.request, s.spec ?? policy) : null;
    if (!parts) continue;
    if (pin == null || s.id === pin) latest ??= { id: s.id, parts };
    for (const [part, text] of Object.entries(parts)) {
      const c = counts.get(part) ?? counts.set(part, { n: 0, keys: new Map(), recent: new Set() }).get(part)!;
      c.n++;
      for (const k of new Set(split(text).map(norm).filter(Boolean))) {
        c.keys.set(k, (c.keys.get(k) ?? 0) + 1);
        if (c.n <= RECENT) c.recent.add(k);
      }
    }
  }
  let run = 0;
  const parts: PartT[] = Object.entries(latest?.parts ?? {}).map(([part, code]) => {
    const c = counts.get(part)!, min = Math.max(2, Math.ceil(c.n * SHARE));
    const statics = [...c.keys].filter(([, n]) => n >= min).map(([k]) => k);
    const isStatic = new Set(statics), locked = new Set(locks[part] ?? []);
    let prevFixed = false;
    const clauses = split(code).map(t => {
      const key = norm(t);
      const cl: Clause = { text: t, key, dyn: !!key && !isStatic.has(key), locked: !!key && isStatic.has(key) && locked.has(key), fixed: null,
        share: key ? (c.keys.get(key) ?? 0) / Math.max(1, c.n) : 0 };
      if (key) {
        const f = cl.dyn || cl.locked;
        if (f) cl.fixed = prevFixed ? run : ++run;
        prevFixed = f;
      }
      return cl;
    });
    return { part, code, clauses, static: statics, stable: statics.filter(k => c.recent.has(k)), n: c.n };
  });
  return { ready: samples.length >= need, seen: samples.length, need, parts, sample: latest?.id ?? null };
}

const cache = new WeakMap<Store, Map<string, { at: number; stamp: number; t: Template }>>();

/**
 * The template of a policy in a scope, from its newest `store.observe` calls. Rebuilt when calls
 * arrive; under steady traffic at most every few seconds.
 */
export function templateOf(store: Store, name: string, scope: string, fresh = false, pin?: number): Template {
  const m = cache.get(store) ?? cache.set(store, new Map()).get(store)!;
  const k = `${name}\u0000${scope}`, hit = m.get(k), stamp = store.stamp(name);
  if (pin == null && hit && !fresh && (hit.stamp === stamp || (hit.t.ready && Date.now() - hit.at < 3000))) return hit.t;
  const samples = store.samples(name, scope, store.observe);
  if (pin != null && !samples.some(x => x.id === pin)) {
    const c = store.case(pin);
    if (c?.policy === name && c.request && c.url) samples.push({ id: c.id, spec: c.spec, url: c.url, request: c.request });
  }
  const t = build(samples, name, store.locks(name, scope), store.observe, pin);
  if (pin == null) m.set(k, { at: Date.now(), stamp, t });
  return t;
}
export const forget = (store: Store) => cache.delete(store);

export const slots = (p: PartT): Slot[] => p.clauses.map(c => ({ key: c.key, fixed: c.fixed }));
/** Per part, the static clauses of the code's text: what a version's edits were written against. */
export const staticKeys = (t: Template) => Object.fromEntries(t.parts.map(p => [p.part, p.clauses.filter(c => c.key && !c.dyn).map(c => c.key)]));

export interface ViewUnit { text: string; sep: string; kind: "keep" | "del" | "add"; dyn?: boolean; locked?: boolean; key?: string; share?: number }
export interface View {
  parts: { part: string; n: number; units: ViewUnit[]; retired: Op[] }[];
  /** The text as sent in the newest call, per part. */
  merged: Record<string, string>;
  /** The same with fixed runs as ⟦n⟧ markers: what people and the writer edit. */
  edit: Record<string, string>;
  /** What each marker stands for in the newest call. */
  fixed: Record<number, { text: string; dyn: boolean }>;
}

/** A version's edits applied to the newest call's text, as units to show, and as text. */
export function view(t: Template, ops: Doc): View {
  const out: View = { parts: [], merged: {}, edit: {}, fixed: {} };
  for (const p of t.parts) {
    const w = weave(p.code, ops[p.part] ?? []);
    const units: ViewUnit[] = w.units.map(u => {
      const c = u.i != null ? p.clauses[u.i] : null;
      return { text: u.text, sep: u.sep, kind: u.kind, ...(c?.key ? { key: c.key, share: Math.round(c.share * 100) / 100 } : {}),
        ...(c?.dyn && u.kind !== "add" ? { dyn: true } : {}), ...(c?.locked && u.kind !== "add" ? { locked: true } : {}) };
    });
    // edits whose clause the newest call lacks; a clause nearly every call sends is no code change
    const stable = new Set(p.stable);
    const gone = w.retired.map(i => ops[p.part][i]).filter(o => !stable.has((o.op === "insert" ? o.after ?? o.before : o.clause) ?? ""));
    out.parts.push({ part: p.part, n: p.n, units, retired: gone });
    out.merged[p.part] = join(w.units, p.code);
    // the edit text: fixed runs collapse into their marker, even where a version edited a clause that is fixed now
    const pieces: { text: string; sep: string }[] = [];
    let open: number | null = null;
    for (const u of w.units) {
      if (u.kind === "add" && u.rep != null && p.clauses[u.rep].fixed != null) continue;
      if (u.kind === "del" && (u.i == null || p.clauses[u.i].fixed == null)) continue;
      const f = u.kind !== "add" && u.i != null ? p.clauses[u.i].fixed : null;
      if (f != null) {
        const c = p.clauses[u.i!];
        const fx = out.fixed[f] ?? (out.fixed[f] = { text: "", dyn: false });
        fx.text += c.text; fx.dyn ||= c.dyn;
        if (open === f) { pieces[pieces.length - 1].sep = u.sep; continue; }
        pieces.push({ text: marker(f), sep: u.sep });
      } else pieces.push({ text: u.text, sep: u.sep });
      open = f;
    }
    out.edit[p.part] = join(pieces.map(x => ({ ...x, i: null, kind: "add" as const })), p.code);
  }
  for (const f of Object.values(out.fixed)) f.text = f.text.trim();
  return out;
}

/** What varies in one call's text of this decision (its article, its rule): context for reviewers and the writer. */
export function varying(t: Template, parts: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [part, text] of Object.entries(parts ?? {})) {
    const st = new Set(t.parts.find(p => p.part === part)?.static ?? []);
    const dyn = split(text).filter(c => norm(c) && !st.has(norm(c))).join("").trim();
    if (dyn) out[part] = dyn;
  }
  return out;
}
