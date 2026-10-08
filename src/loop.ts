/**
 * The loop: suggest a new policy version from decided cases, replay it against those cases,
 * auto-tune until they pass, accept it as the next live version, for one scope.
 */
import { answers, apply, excerpt, only, rubric, within, type PolicyText, type Route } from "./shapes.js";
import type { CaseRow, PolicyRow, ReplayResult, Store, Suggestion } from "./store.js";

const env = (k: string) => process.env[k] || undefined;
const now = () => new Date().toISOString();
/** Most cases a suggestion is written from and replayed against. */
const MAX_CASES = () => Number(env("DECIDUS_MAX_CASES") ?? 100);

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

interface Written { text: PolicyText; because: Record<string, number[]>; notes?: string }

const SYSTEM = `You maintain the policy for one decision a model makes in production.
The model sees a question and a fixed set of options. The policy is one short description per option that tells the model when to pick it.
People reviewed cases the model was unsure about and recorded the right answer. Rewrite the descriptions so the model reaches the people's answers on these cases and on similar future cases.

Rules:
- Describe patterns, never individual cases: no names, ids, amounts or quotes from the cases.
- Each description: at most 45 words, short clauses separated by semicolons.
- Keep clauses from the current policy that agree with the decisions; change or drop clauses that contradict them.
- Give every option a description, including options no case chose.
- For each option, list the case ids that made you write or change its description; use an empty list when it is unchanged.
- If cases with the same pattern were decided differently, follow the most recent decision and say so in notes.`;

function writeTool(options: string[]) {
  return {
    name: "write_policy",
    description: "Write the next version of the policy.",
    schema: {
      type: "object",
      properties: {
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              option: { type: "string", enum: options },
              text: { type: "string", description: "When the model should pick this option." },
              cases: { type: "array", items: { type: "integer" }, description: "Case ids behind this description." },
            },
            required: ["option", "text", "cases"],
          },
        },
        notes: { type: "string", description: "Anything a reviewer should know, e.g. contradicting decisions." },
      },
      required: ["options"],
    },
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`suggestion model: ${j?.error?.message ?? `HTTP ${r.status}`}`);
  return j;
}
const baseUrl = (k: string, d: string) => (env(k) ?? d).replace(/\/$/, "");

async function callWriter(prompt: string, options: string[]): Promise<Written> {
  const w = writer();
  if (!w) throw new Error("Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY where decidus serve runs; suggestions are written with that provider's model.");
  const key = KEY[w.provider]();
  if (!key) throw new Error(`DECIDUS_SUGGEST_MODEL uses ${w.provider}; set its API key where decidus serve runs.`);
  const tool = writeTool(options);
  let out: any;
  if (w.provider === "anthropic") {
    const j = await post(`${baseUrl("ANTHROPIC_BASE_URL", "https://api.anthropic.com")}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, {
      model: w.model, max_tokens: 4096, system: SYSTEM, messages: [{ role: "user", content: prompt }],
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
  if (!out?.options) throw new Error("suggestion model returned no policy");
  const text: PolicyText = {}, because: Record<string, number[]> = {};
  for (const o of out.options) if (options.includes(o.option) && o.text) { text[o.option] = o.text.trim(); because[o.option] = o.cases ?? []; }
  return { text, because, notes: out.notes || undefined };
}

// ---------------- prompts ----------------

/** A value as people read it: multi-select answers are stored as JSON arrays. */
function shown(v: string | null | undefined): string {
  if (v == null) return "nothing";
  if (v.startsWith("[")) { try { const a = JSON.parse(v); return a.length ? a.join(", ") : "none of the options"; } catch { /* plain */ } }
  return v;
}

function caseBlock(p: PolicyRow, c: CaseRow, modelSaid?: string | null) {
  const said = modelSaid !== undefined ? `${shown(modelSaid)} (this draft)` : `${shown(c.answer)} (v${c.version})`;
  return `#${c.id} · decided: ${shown(c.decision)} · model said: ${said}\n${c.request ? excerpt(p.route as Route, c.request, 1500) : "(input no longer stored)"}`;
}

/**
 * The options a version covers: those of its cases (each call has its own, e.g. per customer) and
 * those already described; the policy's latest options only when nothing else is known.
 */
function optionsOf(p: PolicyRow, cases: CaseRow[], ...texts: PolicyText[]): string[] {
  const o = [...new Set([...cases.flatMap(c => c.options ?? []), ...texts.flatMap(t => Object.keys(t ?? {}))])];
  return o.length ? o : p.options;
}

function basePrompt(p: PolicyRow, current: PolicyText, currentLabel: string, cases: CaseRow[]) {
  const options = optionsOf(p, cases, current);
  return [
    `Decision: ${p.name} (${p.kind})`,
    p.instructions ? `Question: ${p.instructions}` : "",
    `Options: ${options.join(", ")}`,
    p.kind === "multi" ? "The model may pick several options, or none. Each description says when an option applies." : "",
    options.length > p.options.length ? "Calls offer different subsets of these options; a description is only shown when its option is offered." : "",
    `What the calling code already says:\n${p.code_text || "(nothing)"}`,
    `Current policy (${currentLabel}):\n${rubric(current, options) || "(empty)"}`,
    `Decided cases:\n${cases.map(c => caseBlock(p, c)).join("\n---\n")}`,
  ].filter(Boolean).join("\n\n");
}

function need(store: Store, name: string) {
  const p = store.policy(name);
  if (!p) throw new Error(`no policy ${name}`);
  return p;
}
/** Is `now` still the draft `then` was, text and all? Slow work only writes back if so. */
const sameDraft = (now: Suggestion | null, then: Suggestion): now is Suggestion =>
  !!now && now.created_at === then.created_at && JSON.stringify(now.text) === JSON.stringify(then.text);

/**
 * Cases a version for `scope` learns from: in the scope, but not under a narrower scope that runs
 * its own version (those decisions answer a different policy).
 */
function governed(store: Store, name: string, scope: string) {
  const below = store.variants(name).filter(v => v.live != null && v.scope !== scope && within(v.scope, scope)).map(v => v.scope);
  return (c: { scope: string }) => within(c.scope, scope) && !below.some(b => within(c.scope, b));
}

function openSuggestion(store: Store, name: string, scope: string): Suggestion {
  const s = store.variant(name, scope).suggestion;
  if (!s) throw new Error("no suggestion for this scope");
  return s;
}

// ---------------- suggest ----------------

/**
 * Write the next version for `scope` from the cases picked (or all decided ones in the scope),
 * on top of the version that scope runs now. Earlier cases of that version come along, so the
 * new wording is checked against them too.
 */
export async function suggest(store: Store, name: string, scope: string, pick: { cases?: number[]; all?: boolean }): Promise<Suggestion> {
  const p = need(store, name);
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
  const w = await callWriter(basePrompt(p, base.text, `v${eff.n}`, cases), optionsOf(p, cases, base.text));
  const s: Suggestion = { base: eff.n, text: w.text, because: w.because, added: fresh.map(c => c.id), cases: cases.map(c => c.id),
    notes: w.notes, replay: null, tune: [], created_at: now() };
  store.setSuggestion(name, scope, s);
  return s;
}

/** Change the wording by hand. Starts a suggestion from the scope's live version if there is none. */
export function edit(store: Store, name: string, scope: string, text: PolicyText): Suggestion | null {
  const p = need(store, name);
  let s = store.variant(name, scope).suggestion;
  if (!s) {
    const eff = store.effective(name, scope);
    const base = store.version(name, eff.n)!;
    // replay a hand edit against what this scope's people decided: the version's cases and anything decided since
    const ours = governed(store, name, scope);
    const cases = [...new Set([...store.cases(base.cases).filter(ours).map(c => c.id),
      ...store.unprocessed(name, scope, MAX_CASES()).filter(ours).map(c => c.id as number)])].sort((x, y) => x - y);
    s = { base: eff.n, text: { ...base.text }, because: {}, added: [], cases, replay: null, tune: [], created_at: now() };
  }
  const next: PolicyText = {};
  const keys = [...new Set([...p.options, ...Object.keys(s.text), ...Object.keys(text ?? {})])];
  for (const o of keys) { const t = String(text[o] ?? s.text[o] ?? "").trim(); if (t) next[o] = t; }
  const changed = keys.filter(o => (next[o] ?? "") !== (s!.text[o] ?? ""));
  if (!changed.length) return store.variant(name, scope).suggestion;
  const because = { ...s.because };
  for (const o of changed) because[o] = [];
  s = { ...s, text: next, because, replay: null, tune: [...s.tune, { round: s.tune.length + 1, pass: null, n: null, note: `Edited ${changed.join(", ")} by hand` }] };
  store.setSuggestion(name, scope, s);
  return s;
}

// ---------------- replay ----------------

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

async function replayOne(p: PolicyRow, c: CaseRow, text: PolicyText): Promise<ReplayResult> {
  const human = c.decision!;
  if (!c.request || !c.url) return { id: c.id, human, model: null, pass: false, error: "input no longer stored" };
  try {
    const body = structuredClone(c.request);
    const one = only(c.spec ?? c.policy, p.name);
    if (Object.values(text).some(Boolean)) apply(p.route as Route, body, { [p.name]: { version: 1, text } }, one);
    const url = new URL(c.url);
    const r = await fetch(url, {
      method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
      headers: { ...c.headers, "content-type": "application/json", ...auth(url) },
    });
    const j: any = await r.json().catch(() => null);
    if (!r.ok) return { id: c.id, human, model: null, pass: false, error: j?.error?.message ?? `HTTP ${r.status}` };
    const model = answers(p.route as Route, c.request, j, one)[p.name]?.value ?? null;
    return { id: c.id, human, model, pass: model === human };
  } catch (e: any) {
    return { id: c.id, human, model: null, pass: false, error: e?.message ?? String(e) };
  }
}

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k]); } }));
  return out;
}

export async function replay(store: Store, name: string, scope: string, target: "suggestion" | number): Promise<ReplayResult[]> {
  const p = need(store, name);
  const src = target === "suggestion" ? openSuggestion(store, name, scope) : store.version(name, target);
  if (!src) throw new Error("nothing to replay");
  const cases = store.cases(src.cases).filter(c => c.decision != null);
  const results = await pool(cases, Number(env("DECIDUS_REPLAY_CONCURRENCY") ?? 4), c => replayOne(p, c, src.text));
  if (target !== "suggestion") store.setVersionReplay(name, target, results);
  else {
    const now = store.variant(name, scope).suggestion;
    if (sameDraft(now, src as Suggestion)) store.setSuggestion(name, scope, { ...now, replay: results });
  }
  return results;
}

// ---------------- auto-tune ----------------

export async function tune(store: Store, name: string, scope: string, rounds = 3): Promise<Suggestion> {
  const p = need(store, name);
  let s = openSuggestion(store, name, scope);
  let results = s.replay ?? await replay(store, name, scope, "suggestion");
  const log = [...s.tune];
  const started = s.created_at;
  const save = () => {
    const now = store.variant(name, scope).suggestion;
    if (now?.created_at === started) store.setSuggestion(name, scope, { ...now, tune: log });
  };
  const passed = () => results.filter(r => r.pass).length;

  for (let i = 0; i < rounds; i++) {
    const failing = results.filter(r => !r.pass);
    if (!failing.length) break;
    if (failing.every(r => r.error)) {
      log.push({ round: log.length + 1, pass: passed(), n: results.length, note: "Replay calls failed; check the provider or gateway keys where decidus serve runs" });
      break;
    }
    s = openSuggestion(store, name, scope);
    const cases = store.cases(s.cases).filter(c => c.decision != null);
    const prompt = basePrompt(p, s.text, "draft", cases) +
      `\n\nThis draft was replayed. These cases still fail:\n` +
      failing.filter(r => !r.error).map(r => caseBlock(p, cases.find(c => c.id === r.id)!, r.model)).join("\n---\n") +
      `\n\nRevise only what is needed so these pass without breaking the others. In "cases", list the failing case ids you fixed.`;
    const options = optionsOf(p, cases, s.text);
    const w = await callWriter(prompt, options);
    const now = store.variant(name, scope).suggestion;
    if (!sameDraft(now, s)) throw new Error("The suggestion changed while tuning; run auto-tune again.");
    s = now;
    const changed = options.filter(o => w.text[o] && w.text[o] !== s.text[o]);
    if (!changed.length) {
      log.push({ round: log.length + 1, pass: passed(), n: results.length, note: "No rewording helps; the failing cases need a person" });
      break;
    }
    const because = { ...s.because };
    for (const o of changed) because[o] = [...new Set([...(s.because[o] ?? []), ...(w.because[o] ?? [])])];
    store.setSuggestion(name, scope, { ...s, text: { ...s.text, ...w.text }, because, notes: w.notes ?? s.notes, replay: null });
    results = await replay(store, name, scope, "suggestion");
    log.push({ round: log.length + 1, pass: passed(), n: results.length,
      note: `Reworded ${changed.join(", ")}` + (passed() === results.length ? " · all cases pass" : "") });
    save();
  }
  save();
  return openSuggestion(store, name, scope);
}

// ---------------- accept / rollback ----------------

export function accept(store: Store, name: string, scope: string): number {
  need(store, name);
  const s = openSuggestion(store, name, scope);
  const eff = store.effective(name, scope);
  if (s.base !== eff.n) throw new Error(`this scope now runs v${eff.n}, not v${s.base} as when this suggestion was written; suggest again`);
  const n = store.nextVersion(name);
  store.addVersion({ policy: name, n, scope, base: s.base, text: s.text, because: s.because, cases: s.cases, replay: s.replay,
    log: { notes: s.notes, tune: s.tune } });
  store.markUsed(s.added, n);
  store.setLive(name, scope, n);
  store.setSuggestion(name, scope, null);
  return n;
}
