/**
 * The loop, per policy and scope: write a draft of the decision's text from decided cases (or by
 * hand), replay it for an accuracy score, then try it on live traffic: shadow (re-run a share of
 * calls on the side), canary (serve it to a share of calls), live. Roll back any time.
 */
import { answers, apply, evidence, excerpt, only, prefixes, textParts, within, type Doc, type Route } from "./shapes.js";
import { diff, rebase as rebaseOps, type Op } from "./clauses.js";
import type { CaseRow, Draft, PolicyRow, ReplayResult, Store } from "./store.js";
import { slots, staticKeys, templateOf, varying, view, type Template } from "./template.js";

const env = (k: string) => process.env[k] || undefined;
const now = () => new Date().toISOString();
/** Most cases the writer sees at once (disagreements first). */
const MAX_CASES = () => Number(env("DECIDUS_MAX_CASES") ?? 40);
/** Most decided cases a version is replayed against for its accuracy. */
const REPLAY_CASES = () => Number(env("DECIDUS_REPLAY_CASES") ?? 300);

// ---------------- the model that writes policies ----------------

export type Provider = "openai" | "anthropic" | "gemini";
const DEFAULT_MODEL: Record<Provider, string> = { openai: "gpt-6.1-sol", anthropic: "claude-sonnet-5-5", gemini: "gemini-3.8-flash" };
const KEY: Record<Provider, () => string | undefined> = {
  openai: () => env("OPENAI_API_KEY"),
  anthropic: () => env("ANTHROPIC_API_KEY"),
  gemini: () => env("GEMINI_API_KEY") ?? env("GOOGLE_API_KEY"),
};

/**
 * DECIDUS_SUGGEST_MODEL=provider/model, e.g. openai/gpt-6.1-sol, anthropic/claude-sonnet-5-5, gemini/gemini-3.8-flash.
 * Unset: OpenAI, else Anthropic, else Gemini, whichever key is present.
 */
export function writer(): { provider: Provider; model: string } | null {
  const set = env("DECIDUS_SUGGEST_MODEL")?.trim();
  if (set) {
    const m = set.match(/^(openai|anthropic|gemini|google)\/(.+)$/);
    if (m) return { provider: (m[1] === "google" ? "gemini" : m[1]) as Provider, model: m[2] };
    return { provider: set.startsWith("claude") ? "anthropic" : set.startsWith("gemini") ? "gemini" : "openai", model: set };
  }
  for (const p of ["openai", "anthropic", "gemini"] as Provider[]) if (KEY[p]()) return { provider: p, model: DEFAULT_MODEL[p] };
  return null;
}

interface Written { parts: Record<string, string>; because: Record<string, number[]>; notes?: string }

const SYSTEM = `You maintain the text of one decision a model makes in production: the descriptions and instructions the calling code sends with a question that has a fixed set of answers.
People reviewed calls and recorded the right answer. Rewrite the text so the model reaches the people's answers on these cases and on similar future cases.
Text like this often grew by appending for years. Simplify it as you go: drop what is redundant, contradicted or never matters, merge duplicates, prefer short plain rules.

Rules:
- The text comes in named parts. Return only the parts you change, each as its complete new text.
- ⟦n⟧ stands for text you cannot change: it varies from call to call (per customer, per item) or people locked it. Keep every marker of a part in that part's new text, where it belongs.
- Describe patterns, never individual cases: no names, ids, amounts or quotes from the cases.
- Keep what agrees with the decisions; change or drop what contradicts them.
- For each part you change, list the case ids that made you change it.
- If cases with the same pattern were decided differently, follow the most recent decision and say so in notes.`;

function writeTool(parts: string[]) {
  return {
    name: "write_policy",
    description: "Write the next version of the decision's text.",
    schema: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              part: { type: "string", enum: parts },
              text: { type: "string", description: "The complete new text of this part, with each of its ⟦n⟧ markers kept." },
              cases: { type: "array", items: { type: "integer" }, description: "Case ids behind this change." },
            },
            required: ["part", "text", "cases"],
          },
        },
        notes: { type: "string", description: "Anything a reviewer should know, e.g. contradicting decisions." },
      },
      required: ["parts"],
    },
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`writer model: ${j?.error?.message ?? `HTTP ${r.status}`}`);
  return j;
}
const baseUrl = (k: string, d: string) => (env(k) ?? d).replace(/\/$/, "");

async function callWriter(prompt: string, parts: string[]): Promise<Written> {
  const w = writer();
  if (!w) throw new Error("Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY where decidus serve runs; drafts are written with that provider's model.");
  const key = KEY[w.provider]();
  if (!key) throw new Error(`DECIDUS_SUGGEST_MODEL uses ${w.provider}; set its API key where decidus serve runs.`);
  const tool = writeTool(parts);
  let out: any;
  if (w.provider === "anthropic") {
    const j = await post(`${baseUrl("ANTHROPIC_BASE_URL", "https://api.anthropic.com")}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, {
      model: w.model, max_tokens: 16000, system: SYSTEM, messages: [{ role: "user", content: prompt }],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }], tool_choice: { type: "tool", name: tool.name },
    });
    out = (j.content ?? []).find((c: any) => c.type === "tool_use")?.input;
  } else if (w.provider === "gemini") {
    const j = await post(`${baseUrl("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com")}/v1beta/models/${w.model}:generateContent`, { "x-goog-api-key": key }, {
      systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parametersJsonSchema: tool.schema }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } },
    });
    out = (j.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.functionCall)?.functionCall?.args;
  } else {
    const j = await post(`${baseUrl("OPENAI_BASE_URL", "https://api.openai.com/v1")}/chat/completions`, { authorization: `Bearer ${key}` }, {
      model: w.model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
      tool_choice: { type: "function", function: { name: tool.name } },
    });
    try { out = JSON.parse(j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments ?? "null"); } catch { out = null; }
  }
  if (!Array.isArray(out?.parts)) throw new Error("the writer model returned no text");
  const res: Written = { parts: {}, because: {}, notes: out.notes || undefined };
  for (const p of out.parts) if (parts.includes(p?.part) && typeof p.text === "string") { res.parts[p.part] = p.text; res.because[p.part] = (p.cases ?? []).map(Number).filter(Number.isFinite); }
  return res;
}

// ---------------- prompts ----------------

/** A value as people read it: multi-select answers are stored as JSON arrays. */
function shown(v: string | null | undefined): string {
  if (v == null) return "nothing";
  if (v.startsWith("[")) { try { const a = JSON.parse(v); return a.length ? a.join(", ") : "none of the options"; } catch { /* plain */ } }
  return v;
}
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** One decided case as the writer sees it: the input, what varied in this decision's own text, and what the model wrote. */
function caseBlock(p: PolicyRow, t: Template, c: CaseRow, modelSaid?: string | null) {
  const said = modelSaid !== undefined ? `${shown(modelSaid)} (this draft)` : `${shown(c.answer)} (v${c.version})`;
  const lines = [`#${c.id} · decided: ${shown(c.decision)} · model said: ${said}`];
  if (!c.request) return [...lines, "(input no longer stored)"].join("\n");
  const route = p.route as Route, key = c.spec ?? c.policy;
  lines.push(excerpt(route, c.request, 1500));
  const v = varying(t, textParts(route, c.request, key));
  if (Object.keys(v).length) lines.push(`This call's own text: ${Object.entries(v).map(([k, x]) => `${k}: "${cut(x, 500)}"`).join(" · ")}`);
  const e = evidence(route, c.request, c.response, key);
  if (e.about) lines.push(`About: ${cut(e.about, 800)}`);
  const s = Object.entries(e.said);
  if (s.length) lines.push(`The model wrote: ${s.map(([k, x]) => `${k}: "${cut(x, 600)}"`).join(" · ")}`);
  return lines.join("\n");
}

function prompt(p: PolicyRow, t: Template, ops: Doc, label: string, cases: CaseRow[]) {
  const v = view(t, ops);
  const options = [...new Set([...cases.flatMap(c => c.options ?? []), ...p.options])];
  const fixed = Object.entries(v.fixed).map(([id, f]) => `⟦${id}⟧ ${f.dyn ? "varies per call; in the newest call" : "locked"}: "${cut(f.text, 400)}"`);
  return [
    `Decision: ${p.name} (${p.kind})`,
    p.instructions ? `Question: ${cut(p.instructions, 2000)}` : "",
    `Options: ${options.join(", ")}`,
    p.kind === "multi" ? "The model may pick several options, or none." : "",
    `The decision's text (${label}):\n` + Object.entries(v.edit).map(([part, text]) => `### ${part}\n${text || "(empty)"}`).join("\n\n"),
    fixed.length ? `Fixed text, for reference:\n${fixed.join("\n")}` : "",
    `Decided cases:\n${cases.map(c => caseBlock(p, t, c)).join("\n---\n")}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * New text per part (from the writer or an edit) as edits against the code's text; parts left out
 * keep `ops`. The text shows the newest call, so edits it can't show stay as they are: those of a
 * clause that call lacks or that is fixed now, and inserts anchored on a clause that call lacks.
 */
function toOps(t: Template, ops: Doc, w: Written): { ops: Doc; changed: string[] } {
  const next: Doc = { ...ops }, changed: string[] = [];
  for (const [part, text] of Object.entries(w.parts)) {
    const pt = t.parts.find(x => x.part === part);
    if (!pt) continue;
    const sl = slots(pt), present = new Set(sl.map(x => x.key).filter(Boolean));
    const editable = new Set(sl.filter(x => x.key && x.fixed == null).map(x => x.key));
    const unseen = (ops[part] ?? []).filter(o => o.op === "insert" ? (o.after ?? o.before) != null && !present.has((o.after ?? o.before)!) : !editable.has(o.clause));
    const o = [...diff(sl, text), ...unseen];
    if (JSON.stringify(o) === JSON.stringify(ops[part] ?? [])) continue;
    if (o.length) next[part] = o; else delete next[part];
    changed.push(part);
  }
  return { ops: next, changed };
}

function need(store: Store, name: string) {
  const p = store.policy(name);
  if (!p) throw new Error(`no policy ${name}`);
  return p;
}
/** The template as of now (or as of the call an edit was made on), or why there isn't one yet. */
function ready(store: Store, name: string, scope: string, pin?: number): Template {
  const t = templateOf(store, name, scope, true, pin);
  if (!t.ready) throw new Error(`Still observing: ${t.seen} of ${t.need} calls${scope ? ` in ${scope}` : ""}. decidus tunes text once it can tell what the code sends every time from what varies per call.`);
  return t;
}
/** Is `now` still the draft `then` was? Slow work only writes back if so. */
const sameDraft = (now: Draft | null, then: Draft): now is Draft =>
  !!now && now.created_at === then.created_at && JSON.stringify(now.ops) === JSON.stringify(then.ops);

/**
 * Cases a version for `scope` learns from: in the scope, but not under a narrower scope that runs
 * its own version (those decisions answer a different policy).
 */
function governed(store: Store, name: string, scope: string) {
  const below = store.variants(name).filter(v => v.live != null && v.scope !== scope && within(v.scope, scope)).map(v => v.scope);
  return (c: { scope: string }) => within(c.scope, scope) && !below.some(b => within(c.scope, b));
}

function openDraft(store: Store, name: string, scope: string): Draft {
  const d = store.variant(name, scope).draft;
  if (!d) throw new Error("no draft for this scope");
  return d;
}

// ---------------- suggest / edit ----------------

/**
 * Write a draft for `scope` from the cases picked (or all decided ones in the scope, disagreements
 * first), on top of the version that scope runs now. Earlier cases of that version come along.
 */
export async function suggest(store: Store, name: string, scope: string, pick: { cases?: number[]; all?: boolean }): Promise<Draft> {
  const p = need(store, name);
  const t = ready(store, name, scope);
  const eff = store.effective(name, scope);
  const base = store.version(name, eff.n)!;
  const max = MAX_CASES();
  const ours = governed(store, name, scope);
  const ids = pick.all ? store.unprocessed(name, scope, max * 3).filter(ours).map(c => c.id) : [...new Set(pick.cases ?? [])];
  const fresh = store.cases(ids).filter(c => c.policy === name && c.decision != null && c.used_in == null && within(c.scope, scope)).slice(0, max);
  if (!fresh.length) throw new Error("pick at least one decided case that isn't in a version yet");
  const freshIds = new Set(fresh.map(c => c.id));
  const carried = store.cases(base.cases).filter(c => c.decision != null && ours(c) && !freshIds.has(c.id))
    .sort((a, b) => b.id - a.id).slice(0, Math.max(0, max - fresh.length));
  const cases = [...fresh, ...carried].sort((a, b) => a.id - b.id);
  const w = await callWriter(prompt(p, t, base.ops, `v${eff.n}`, cases), t.parts.map(x => x.part));
  const { ops, changed } = toOps(t, base.ops, w);
  if (!changed.length) throw new Error("The writer changed nothing: the decided cases already agree with this text, or need a person.");
  const d: Draft = { base: eff.n, ops, keys: staticKeys(t), because: Object.fromEntries(changed.map(k => [k, w.because[k] ?? []])),
    added: fresh.map(c => c.id), cases: cases.map(c => c.id), notes: w.notes, replay: null, tune: [], created_at: now() };
  store.setDraft(name, scope, d);
  return d;
}

/**
 * Change the text by hand: parts as edited, ⟦n⟧ markers for fixed text, against the call the text
 * was shown from (`sample`, from the view). Starts a draft from the live version if there is none.
 */
export function edit(store: Store, name: string, scope: string, parts: Record<string, string>, sample?: number): Draft | null {
  need(store, name);
  const t = ready(store, name, scope, sample);
  let d = store.variant(name, scope).draft;
  if (!d) {
    const eff = store.effective(name, scope);
    const base = store.version(name, eff.n)!;
    d = { base: eff.n, ops: { ...base.ops }, keys: staticKeys(t), because: {}, added: [], cases: [], replay: null, tune: [], created_at: now() };
  }
  const { ops, changed } = toOps(t, d.ops, { parts: parts ?? {}, because: {} });
  if (!changed.length) return store.variant(name, scope).draft;
  const because = { ...d.because };
  for (const k of changed) because[k] = [];
  d = { ...d, ops, keys: staticKeys(t), because, replay: null, tune: [...d.tune, { round: d.tune.length + 1, pass: null, n: null, note: `Edited ${changed.join(", ")} by hand` }] };
  store.setDraft(name, scope, d);
  return d;
}

// ---------------- replay: accuracy on decided cases ----------------

/** Provider credentials on the machine running `decidus serve`, by host. */
function auth(url: URL): Record<string, string> {
  const gw = env("DECIDUS_GATEWAY_URL")?.replace(/\/$/, "");
  if (gw && env("DECIDUS_GATEWAY_KEY") && (url.href === gw || url.href.startsWith(gw + "/")))
    return { authorization: `Bearer ${env("DECIDUS_GATEWAY_KEY")}` };     // LiteLLM, OpenRouter, Portkey and other gateways in front of providers
  const h = url.hostname;
  if (h === "api.openai.com" && KEY.openai()) return { authorization: `Bearer ${KEY.openai()}` };
  if (h === "api.anthropic.com" && KEY.anthropic()) return { "x-api-key": KEY.anthropic()! };
  if (h === "generativelanguage.googleapis.com" && KEY.gemini()) return { "x-goog-api-key": KEY.gemini()! };
  if (h === "api.typesafe.ai" && env("TYPESAFE_API_KEY")) return { authorization: `Bearer ${env("TYPESAFE_API_KEY")}` };
  return {};
}

/** Re-sends a recorded call with `ops` merged into its text, and reads this decision's answer. */
async function rerun(p: PolicyRow, c: CaseRow, ops: Doc): Promise<{ model: string | null; error?: string }> {
  if (!c.request || !c.url) return { model: null, error: "input no longer stored" };
  try {
    const body = structuredClone(c.request);
    const one = only(c.spec ?? c.policy, p.name);
    apply(p.route as Route, body, { [p.name]: { version: 1, ops } }, one);
    const url = new URL(c.url);
    const r = await fetch(url, {
      method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      headers: { ...c.headers, "content-type": "application/json", ...auth(url) },
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok) return { model: null, error: j?.error?.message ?? `HTTP ${r.status}` };
    return { model: answers(p.route as Route, c.request, j, one)[p.name]?.value ?? null };
  } catch (e: any) {
    return { model: null, error: e?.message ?? String(e) };
  }
}

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } }));
  return out;
}

/** Replays the draft or a version against the scope's newest decided cases: its accuracy. */
export async function replay(store: Store, name: string, scope: string, target: "draft" | number): Promise<ReplayResult[]> {
  const p = need(store, name);
  const src = target === "draft" ? openDraft(store, name, scope) : store.version(name, target);
  if (!src) throw new Error("nothing to replay");
  const ours = governed(store, name, scope), max = REPLAY_CASES();
  const cases = store.decidedCases(name, scope, max * 2).filter(ours).slice(0, max);
  if (!cases.length) throw new Error("decide a few cases first: replay checks a version against people's decisions");
  const results = await pool(cases, Number(env("DECIDUS_REPLAY_CONCURRENCY") ?? 4), async c => {
    const r = await rerun(p, c, src.ops);
    return { id: c.id, human: c.decision!, model: r.model, pass: !r.error && r.model === c.decision, ...(r.error ? { error: r.error } : {}) };
  });
  results.sort((a, b) => a.id - b.id);
  if (target !== "draft") store.setVersionReplay(name, target, results);
  else {
    const d = store.variant(name, scope).draft;
    if (sameDraft(d, src as Draft)) store.setDraft(name, scope, { ...d, replay: results });
  }
  return results;
}

// ---------------- auto-tune ----------------

export async function tune(store: Store, name: string, scope: string, rounds = 3): Promise<Draft> {
  const p = need(store, name);
  const t = ready(store, name, scope);
  let d = openDraft(store, name, scope);
  let results = d.replay ?? await replay(store, name, scope, "draft");
  const log = [...d.tune];
  const started = d.created_at;
  const save = () => {
    const cur = store.variant(name, scope).draft;
    if (cur?.created_at === started) store.setDraft(name, scope, { ...cur, tune: log });
  };
  const passed = () => results.filter(r => r.pass).length;

  for (let i = 0; i < rounds; i++) {
    const failing = results.filter(r => !r.pass);
    if (!failing.length) break;
    if (failing.every(r => r.error)) {
      log.push({ round: log.length + 1, pass: passed(), n: results.length, note: "Replay calls failed; check the provider or gateway keys where decidus serve runs" });
      break;
    }
    d = openDraft(store, name, scope);
    const failed = store.cases(failing.filter(r => !r.error).slice(0, MAX_CASES()).map(r => r.id));
    const passing = store.cases(results.filter(r => r.pass).slice(-Math.max(0, MAX_CASES() - failed.length)).map(r => r.id));
    const text = prompt(p, t, d.ops, "draft", [...failed, ...passing].sort((a, b) => a.id - b.id)) +
      `\n\nThis draft was replayed. These cases still fail:\n` +
      failed.map(c => caseBlock(p, t, c, failing.find(r => r.id === c.id)?.model ?? null)).join("\n---\n") +
      `\n\nRevise only what is needed so these pass without breaking the others. In "cases", list the failing case ids you fixed.`;
    const w = await callWriter(text, t.parts.map(x => x.part));
    const cur = store.variant(name, scope).draft;
    if (!sameDraft(cur, d)) throw new Error("The draft changed while tuning; run auto-tune again.");
    d = cur;
    const { ops, changed } = toOps(t, d.ops, w);
    if (!changed.length) {
      log.push({ round: log.length + 1, pass: passed(), n: results.length, note: "No rewording helps; the failing cases need a person" });
      break;
    }
    const because = { ...d.because };
    for (const k of changed) because[k] = [...new Set([...(d.because[k] ?? []), ...(w.because[k] ?? [])])];
    store.setDraft(name, scope, { ...d, ops, keys: staticKeys(t), because, notes: w.notes ?? d.notes, replay: null });
    results = await replay(store, name, scope, "draft");
    log.push({ round: log.length + 1, pass: passed(), n: results.length,
      note: `Reworded ${changed.join(", ")}` + (passed() === results.length ? " · all cases pass" : "") });
    save();
  }
  save();
  return openDraft(store, name, scope);
}

// ---------------- stages: draft -> shadow / canary -> live ----------------

/** The draft becomes the next version (not live yet). */
function promote(store: Store, name: string, scope: string): number {
  const d = openDraft(store, name, scope);
  const eff = store.effective(name, scope);
  if (d.base !== eff.n) throw new Error(`this scope now runs v${eff.n}, not v${d.base} as when this draft was written; write the draft again`);
  const n = store.nextVersion(name);
  store.addVersion({ policy: name, n, scope, base: d.base, ops: d.ops, keys: d.keys, because: d.because, cases: d.cases, replay: d.replay,
    log: { notes: d.notes, tune: d.tune } });
  store.markUsed(d.added, n);
  store.setDraft(name, scope, null);
  return n;
}

/**
 * Moves the draft (or the candidate being tried) one stage: shadow or canary on `pct`% of calls, or live.
 * Changing the share of a running candidate keeps its comparison going.
 */
export function stage(store: Store, name: string, scope: string, mode: "shadow" | "canary" | "live", pct?: number, target?: "draft" | number): { n: number; mode: string } {
  need(store, name);
  const v = store.variant(name, scope);
  let n: number | undefined;
  if (target === "draft" || (target == null && v.draft)) n = promote(store, name, scope);
  else {
    n = target ?? v.candidate?.n;
    const ver = n == null ? null : store.version(name, n);
    if (n != null && (!ver || !prefixes(scope).includes(ver.scope))) throw new Error(`v${n} isn't a version of ${scope || "global"} or above it`);
  }
  if (n == null) throw new Error("nothing to stage: write a draft first");
  if (mode === "live") {
    store.setLive(name, scope, n);
    store.setCandidate(name, scope, null);
    return { n, mode };
  }
  const share = Math.max(0.1, Math.min(100, Number(pct) || 10));
  const same = v.candidate && v.candidate.n === n && v.candidate.mode === mode;
  store.setCandidate(name, scope, { n, mode, pct: share, since: same ? v.candidate!.since : now() });
  return { n, mode };
}

// ---------------- shadow: re-run a share of calls with the candidate ----------------

/**
 * Re-runs calls with the candidate on the side and records its answer next to the live one. Calls
 * where they disagree go to the review queue: that's where the two versions differ.
 */
export class Shadow {
  private q: { id: number; n: number }[] = [];
  private running = 0;
  private waiters: (() => void)[] = [];
  constructor(private store: Store, private cap = 200, private concurrency = 2) {}
  push(id: number, n: number) {
    if (this.q.length >= this.cap) return;            // behind: skip rather than pile up
    this.q.push({ id, n });
    this.pump();
  }
  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> { return !this.q.length && !this.running ? Promise.resolve() : new Promise(r => this.waiters.push(r)); }
  private pump() {
    while (this.running < this.concurrency && this.q.length) {
      const job = this.q.shift()!;
      this.running++;
      this.run(job).catch(() => {}).finally(() => {
        this.running--;
        this.pump();
        if (!this.q.length && !this.running) this.waiters.splice(0).forEach(r => r());
      });
    }
  }
  private async run({ id, n }: { id: number; n: number }) {
    const c = this.store.case(id), p = c && this.store.policy(c.policy), v = c && this.store.version(c.policy, n);
    if (!c || !p || !v) return;
    const r = await rerun(p, c, v.ops);
    if (r.error) return;
    this.store.setShadow(id, n, r.model, r.model !== c.answer);
  }
}

// ---------------- the code changed under a version ----------------

/** Edits of the version a scope runs that the newest call no longer has the clause for. */
export function retired(store: Store, name: string, scope: string): { version: number; calls: number; of: number; ops: (Op & { part: string })[] } | null {
  const eff = store.effective(name, scope);
  if (!eff.n) return null;
  const r = store.retiredOn(name, scope, eff.n);
  if (!r.latest || r.latest !== r.newest) return null;          // the newest call applied everything: nothing to warn about
  const t = templateOf(store, name, scope), v = store.version(name, eff.n)!;
  const w = view(t, v.ops);
  const ops = w.parts.flatMap(p => p.retired.map(o => ({ ...o, part: p.part })));
  return ops.length ? { version: eff.n, calls: r.calls, of: r.of, ops } : null;
}

/**
 * "Keep decidus's text": re-anchors the running version's edits onto the code's new text, as this
 * scope's live version. Other scopes keep what they run.
 */
export function rebase(store: Store, name: string, scope: string): number {
  need(store, name);
  const eff = store.effective(name, scope);
  if (!eff.n) throw new Error("this scope runs the code's own text");
  const v = store.version(name, eff.n)!;
  const t = templateOf(store, name, scope, true);
  const ops: Doc = { ...v.ops };
  for (const p of t.parts) {
    if (!v.ops[p.part]?.length) continue;
    ops[p.part] = rebaseOps(v.ops[p.part], v.keys[p.part] ?? [], p.clauses.map(c => c.key).filter(Boolean), new Set(p.stable));
  }
  const n = store.nextVersion(name);
  store.addVersion({ policy: name, n, scope, base: eff.n, ops, keys: staticKeys(t), because: {}, cases: v.cases, replay: null,
    log: { notes: `v${eff.n}'s text, kept on top of the code's new text`, tune: [], rebased: eff.n } });
  store.setLive(name, scope, n);
  return n;
}
