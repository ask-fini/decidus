/**
 * Everything provider-specific lives here. Shared by the interceptor and the server.
 *
 * A decision call is one of:
 *   - POST .../decisions            OpenAI Decisions API   (policy = question name)
 *   - POST .../v1/systemone         TypeSafe System One    (policy = question key)
 *   - a function call forced to exactly one tool whose schema has an enum or boolean field
 *     (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Gemini generateContent)
 *     (policy = tool name)
 *
 * A policy's text is a map option -> description. Decidus only ever writes that text into the
 * request; options, names and schema stay exactly as the caller wrote them.
 */

export type Route = "decisions" | "systemone" | "chat" | "responses" | "anthropic" | "gemini";
export type Kind = "bool" | "category" | "scale";
export type PolicyText = Record<string, string>;
export interface LivePolicy { version: number; text: PolicyText }
/** What GET /v1/policies returns: the global live versions, and per-scope overrides. */
export interface LiveSet { policies: Record<string, LivePolicy>; scopes?: Record<string, Record<string, LivePolicy>> }

// ---------------- scopes ----------------
// A scope is a path like "acme" or "acme/support-bot". A call made in "acme/support-bot" runs the
// version set for that scope, else for "acme", else the global one ("").

export function normScope(s: unknown): string {
  return typeof s === "string" ? s.split("/").map(x => x.trim()).filter(Boolean).join("/").slice(0, 200) : "";
}
/** "acme/bot" -> ["acme/bot", "acme", ""] */
export function prefixes(scope: string): string[] {
  const parts = scope ? scope.split("/") : [];
  return [...parts.map((_, i) => parts.slice(0, parts.length - i).join("/")), ""];
}
/** Is `scope` the same as `of`, or under it? Everything is under "". */
export const within = (scope: string, of: string) => !of || scope === of || scope.startsWith(of + "/");

/** The live policies a call in `scope` should run: the most specific scope wins, per policy. */
export function resolve(live: LiveSet, scope: string): Record<string, LivePolicy> {
  const out = { ...live.policies };
  for (const p of prefixes(scope).reverse()) if (p && live.scopes?.[p]) Object.assign(out, live.scopes[p]);
  return out;
}

export interface Spec {
  name: string;
  route: Route;
  kind: Kind;
  options: string[];
  field?: string;          // tool routes: the schema property that carries the decision
  instructions?: string;   // the question / tool description, as the caller wrote it
  codeText?: string;       // descriptions already present in the caller's code (v0 context)
}

export interface Answer { value: string | null; confidence: number | null; certain: boolean }

type J = any;

export function routeOf(path: string): Route | null {
  if (path.endsWith("/decisions")) return "decisions";
  if (path.endsWith("/v1/systemone")) return "systemone";
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/responses")) return "responses";
  if (path.endsWith("/messages")) return "anthropic";
  if (path.includes(":generateContent")) return "gemini";
  return null;
}

// ---------------- tool calls ----------------

function forcedTool(route: Route, body: J): { name: string; holder: J; schema: J } | null {
  let name: string | undefined;
  let tools: J[] = [];
  if (route === "gemini") {
    const names = body?.toolConfig?.functionCallingConfig?.allowedFunctionNames ?? [];
    if (names.length === 1) name = names[0];
    tools = (body?.tools ?? []).flatMap((t: J) => t?.functionDeclarations ?? []);
  } else {
    const tc = body?.tool_choice;
    if (tc && typeof tc === "object") name = tc.name ?? tc.function?.name;
    tools = body?.tools ?? [];
  }
  if (!name) return null;
  for (const t of tools) {
    const holder = t?.function ?? t;
    if (holder?.name !== name) continue;
    const schema = holder.input_schema ?? holder.parameters ?? holder.parametersJsonSchema ?? {};
    return { name, holder, schema };
  }
  return null;
}

function decisionField(schema: J): { field: string; kind: Kind; options: string[] } | null {
  for (const [field, p] of Object.entries<J>(schema?.properties ?? {})) {
    if (Array.isArray(p?.enum) && p.enum.length >= 2) return { field, kind: "category", options: p.enum.map(String) };
    if (String(p?.type).toLowerCase() === "boolean") return { field, kind: "bool", options: ["true", "false"] };
  }
  return null;
}

// ---------------- specs: which policies does this request carry ----------------

export function specs(route: Route, body: J): Spec[] {
  if (!body || typeof body !== "object") return [];
  if (route === "decisions") {
    return (Array.isArray(body.questions) ? body.questions : []).flatMap((q: J): Spec[] => {
      if (!q?.name) return [];
      if (q.type === "predicate") return [{ name: q.name, route, kind: "bool", options: ["true", "false"], instructions: q.instructions }];
      if (q.type === "choice") return [{ name: q.name, route, kind: "category", options: (q.choices ?? []).map((c: J) => String(c.value)), instructions: q.instructions,
        codeText: describe(Object.fromEntries((q.choices ?? []).filter((c: J) => c.description).map((c: J) => [String(c.value), c.description]))) }];
      if (q.type === "score") return [{ name: q.name, route, kind: "scale", options: (q.levels ?? []).map((l: J) => String(l.label)), instructions: q.instructions,
        codeText: describe(Object.fromEntries((q.levels ?? []).filter((l: J) => l.description).map((l: J) => [String(l.label), l.description]))) }];
      return [];
    });
  }
  if (route === "systemone") {
    return Object.entries<J>(body.questions && !Array.isArray(body.questions) ? body.questions : {}).flatMap(([name, q]): Spec[] => {
      const crit = q?.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? q.criteria : {};
      if (q?.type === "noul") return [{ name, route, kind: "bool", options: ["true", "false"], instructions: str(q.instructions), codeText: describe(crit) }];
      if (q?.type === "choice") return [{ name, route, kind: "category", options: Object.keys(crit), instructions: str(q.instructions), codeText: describe(crit) }];
      return []; // score criteria are the level descriptions themselves; not managed in v0
    });
  }
  const tool = forcedTool(route, body);
  if (!tool) return [];
  const f = decisionField(tool.schema);
  if (!f) return [];
  return [{ name: tool.name, route, kind: f.kind, options: f.options, field: f.field, instructions: tool.holder.description,
    codeText: tool.schema.properties[f.field]?.description }];
}

// ---------------- apply: write live policy text into the request (mutates body) ----------------

export const rubric = (text: PolicyText, options?: string[]) =>
  (options ?? Object.keys(text)).filter(o => text[o]).map(o => `${o}: ${text[o]}`).join("\n");

/** Returns {policy: version} for every policy whose text was written. */
export function apply(route: Route, body: J, live: Record<string, LivePolicy>): Record<string, number> {
  const used: Record<string, number> = {};
  for (const s of specs(route, body)) {
    const p = live[s.name];
    if (!p || !p.version || !Object.values(p.text).some(Boolean)) continue;
    const t = p.text;
    if (route === "decisions") {
      const q = body.questions.find((x: J) => x?.name === s.name);
      for (const c of q.choices ?? []) if (t[String(c.value)]) c.description = t[String(c.value)];
      for (const l of q.levels ?? []) if (t[String(l.label)]) l.description = t[String(l.label)];
      if (q.type === "predicate") q.instructions = `${q.instructions}\n\nPolicy:\n${rubric(t, s.options)}`;
    } else if (route === "systemone") {
      const q = body.questions[s.name];
      q.criteria = { ...(q.criteria ?? {}) };
      for (const o of s.options) if (t[o]) q.criteria[o] = t[o];
    } else {
      const prop = forcedTool(route, body)!.schema.properties[s.field!];
      prop.description = [prop.description, rubric(t, s.options)].filter(Boolean).join("\n\n");
    }
    used[s.name] = p.version;
  }
  return used;
}

// ---------------- answers: what did the model decide ----------------

const certainP = (p: number) => p >= 0.8 || p <= 0.2;
const parse = (s: J) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };

export function answers(route: Route, request: J, response: J): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  const none = { value: null, confidence: null, certain: false };
  for (const s of specs(route, request)) {
    let a: Answer = none;
    if (route === "decisions") {
      const x = (response?.answers ?? []).find((y: J) => y?.name === s.name);
      if (x?.type === "predicate" && typeof x.probability === "number") a = { value: String(x.probability >= 0.5), confidence: x.probability, certain: certainP(x.probability) };
      else if (x?.type === "choice") a = { value: String(x.choice), confidence: x.confidence ?? null, certain: (x.confidence ?? 0) >= 0.8 };
      else if (x?.type === "score") {
        const best = [...(x.probabilities ?? [])].sort((p: J, q: J) => q.probability - p.probability)[0];
        a = { value: best ? String(best.label ?? best.value) : s.options[Math.round(x.score)] ?? null, confidence: x.confidence ?? null, certain: (x.confidence ?? 0) >= 0.8 };
      }
    } else if (route === "systemone") {
      const x = response?.answers?.[s.name];
      if (x?.type === "noul" && typeof x.noul === "number") a = { value: String(x.noul >= 0.5), confidence: x.noul, certain: certainP(x.noul) };
      else if (x?.type === "choice") a = { value: String(x.choice), confidence: x.confidence ?? null, certain: (x.confidence ?? 0) >= 0.8 };
    } else {
      const args = toolArgs(route, s.name, response);
      const v = args?.[s.field!];
      if (v !== undefined && v !== null) a = { value: String(v), confidence: null, certain: false };
    }
    out[s.name] = a;
  }
  return out;
}

function toolArgs(route: Route, name: string, r: J): J {
  if (route === "chat") return parse(r?.choices?.[0]?.message?.tool_calls?.find((c: J) => c?.function?.name === name)?.function?.arguments);
  if (route === "responses") return parse((r?.output ?? []).find((o: J) => o?.type === "function_call" && o?.name === name)?.arguments);
  if (route === "anthropic") return (r?.content ?? []).find((c: J) => c?.type === "tool_use" && c?.name === name)?.input ?? null;
  if (route === "gemini") return (r?.candidates?.[0]?.content?.parts ?? []).find((p: J) => p?.functionCall?.name === name)?.functionCall?.args ?? null;
  return null;
}

// ---------------- excerpt: the human-readable input, for the queue and the suggestion prompt ----------------

export function excerpt(route: Route, body: J, max = 2400): string {
  const text = (c: J): string => typeof c === "string" ? c
    : Array.isArray(c) ? c.map(p => p?.text ?? p?.input_text ?? (typeof p === "string" ? p : "")).filter(Boolean).join(" ")
    : c?.text ?? "";
  let lines: string[] = [];
  if (route === "chat") lines = (body.messages ?? []).map((m: J) => `${m.role}: ${text(m.content)}`);
  else if (route === "responses" || route === "decisions") lines = typeof body.input === "string" ? [body.input] : (body.input ?? []).map((m: J) => `${m.role ?? "user"}: ${text(m.content)}`);
  else if (route === "anthropic") lines = [body.system ? `system: ${text(body.system)}` : "", ...(body.messages ?? []).map((m: J) => `${m.role}: ${text(m.content)}`)];
  else if (route === "gemini") lines = (body.contents ?? []).map((c: J) => `${c.role ?? "user"}: ${(c.parts ?? []).map((p: J) => p.text ?? "").join(" ")}`);
  else if (route === "systemone") lines = [typeof body.state === "string" ? body.state : JSON.stringify(body.state)];
  const joined = lines.filter(Boolean).map(l => l.length > 800 ? l.slice(0, 800) + "…" : l).join("\n");
  return joined.length > max ? "…" + joined.slice(-max) : joined;
}

/** The last customer-ish message, for list rows. */
export function headline(route: Route, body: J): string {
  const ex = excerpt(route, body, 4000).split("\n").filter(l => !l.startsWith("system:") && !l.startsWith("developer:"));
  const user = ex.filter(l => l.startsWith("user:")).pop() ?? ex.pop() ?? "";
  return user.replace(/^user:\s*/, "").slice(0, 160);
}

function str(x: J): string | undefined { return x == null ? undefined : typeof x === "string" ? x : JSON.stringify(x); }
function describe(m: Record<string, J>): string | undefined {
  const e = Object.entries(m).filter(([, v]) => v);
  return e.length ? e.map(([k, v]) => `${k}: ${v}`).join("\n") : undefined;
}
