/**
 * Everything provider-specific lives here. Shared by the interceptor and the server.
 *
 * A decision is one of:
 *   - a fixed-choice field in a structured-output schema (OpenAI Responses text.format, Chat
 *     response_format, Anthropic output_config.format, Gemini responseSchema)   policy = schema name + field path
 *   - a fixed-choice field in the schema of a function call forced to one tool  policy = tool name + field path
 *   - a question in an OpenAI Decisions call (POST .../decisions)               policy = question name
 *   - a question in a TypeSafe Jev call (POST .../v1/systemone)                 policy = question key
 * A fixed-choice field is an enum, const alternatives (anyOf/oneOf), a boolean, or an array of those.
 *
 * A policy's text is a map option -> description. decidus only ever writes that text into the
 * request; options, names and schema stay exactly as the caller wrote them.
 */

export type Route = "decisions" | "systemone" | "chat" | "responses" | "anthropic" | "gemini";
export type Kind = "bool" | "category" | "scale" | "multi";
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
  /** The policy this decision belongs to: `key`, unless the caller's name hook says otherwise. */
  name: string;
  /** decidus's own name for the decision, read from the request: tool or schema name + field path, or the question name. */
  key: string;
  route: Route;
  kind: Kind;
  /** The choices in this call. With per-customer configuration they can differ from call to call. */
  options: string[];
  /** Where the decision lives: a forced tool call, a structured-output schema, or a Decisions/Jev question. */
  source: "tool" | "format" | "question";
  /** Field path inside the schema, for tool and format decisions. */
  path?: string;
  instructions?: string;   // the question / tool / schema description, as the caller wrote it
  codeText?: string;       // descriptions already present in the caller's code (v0 context)
}

/** Maps a decision's key to the policy it belongs to; null leaves the decision alone. */
export type Rename = (key: string, d: { route: Route; kind: Kind; options: string[]; source: Spec["source"]; instructions?: string }) => string | null | undefined;

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

// ---------------- JSON schema: where the fixed choices are ----------------
// A decision field is any field with a closed set of values: an enum, const alternatives (anyOf/oneOf),
// a boolean, or an array of those (multi-select). Nulls are ignored, $refs to $defs are followed.

interface Choice { kind: "bool" | "category" | "multi"; options: string[] }
const types = (t: J): string[] => (Array.isArray(t) ? t : [t]).filter(x => x != null).map(x => String(x).toLowerCase());
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const values = (xs: J[]) => xs.filter(v => v != null).map(v => String(v));

function deref(node: J, root: J): J {
  for (let i = 0; i < 8 && node && typeof node === "object"; i++) {
    if (typeof node.$ref === "string") {
      const m = node.$ref.match(/^#\/(\$defs|definitions)\/(.+)$/);
      const target = m && root?.[m[1]]?.[m[2].replace(/~1/g, "/").replace(/~0/g, "~")];
      if (!target) return node;
      const { $ref, ...rest } = node;
      node = { ...target, ...rest };
    } else if (Array.isArray(node.allOf) && node.allOf.length === 1) {
      const { allOf, ...rest } = node;
      node = { ...allOf[0], ...rest };
    } else break;
  }
  return node;
}

/** The values a node allows, if it is a closed set of strings/numbers (enum or const alternatives); else null. */
function closed(node: J, root: J): string[] | null {
  const n = deref(node, root);
  if (!n || typeof n !== "object") return null;
  if (Array.isArray(n.enum)) return uniq(values(n.enum));
  const alts = n.anyOf ?? n.oneOf;
  if (!Array.isArray(alts)) return null;
  const o: string[] = [];
  for (const a0 of alts) {
    const a = deref(a0, root);
    if (a?.const !== undefined) { if (a.const !== null) o.push(String(a.const)); }
    else if (Array.isArray(a?.enum)) o.push(...values(a.enum));
    else if (!(types(a?.type).length === 1 && types(a?.type)[0] === "null")) return null;   // an open alternative
  }
  return uniq(o);
}

const isBool = (n: J) => types(n?.type).includes("boolean");

function choice(node: J, root: J): Choice | null {
  const n = deref(node, root);
  if (!n || typeof n !== "object" || n.const !== undefined) return null;
  const c = closed(n, root);
  if (c) return c.length >= 2 ? { kind: "category", options: c } : null;
  const alts = n.anyOf ?? n.oneOf;
  if (Array.isArray(alts)) {      // nullable boolean: anyOf [{type: boolean}, {type: null}]
    const live = alts.map((a: J) => deref(a, root)).filter((a: J) => !(types(a?.type).length === 1 && types(a?.type)[0] === "null"));
    return live.length === 1 && isBool(live[0]) ? { kind: "bool", options: ["true", "false"] } : null;
  }
  if (isBool(n)) return { kind: "bool", options: ["true", "false"] };
  if (types(n.type).includes("array") && n.items) {
    const o = closed(n.items, root);              // multi-select: even one option is a decision (include it or not)
    if (o && o.length >= 1) return { kind: "multi", options: o };
  }
  return null;
}

/** Every decision field in a schema, by path. Doesn't go into arrays of objects. */
function fields(schema: J): { path: string[]; choice: Choice; node: J }[] {
  const out: { path: string[]; choice: Choice; node: J }[] = [];
  const walk = (node: J, path: string[]) => {
    const n = deref(node, schema);
    if (!n || typeof n !== "object" || path.length > 6) return;
    const c = path.length ? choice(n, schema) : null;
    if (c) { out.push({ path, choice: c, node: n }); return; }
    if (n.properties && typeof n.properties === "object") for (const [k, v] of Object.entries<J>(n.properties)) walk(v, [...path, k]);
  };
  walk(schema, []);
  return out;
}

/** The node at `path` in the real request, with $refs on the way copied in place so writing it changes only this field. */
function locate(schema: J, path: string[]): J | null {
  const own = (n: J) => {
    const d = deref(n, schema);
    if (d !== n) { for (const k of Object.keys(n)) delete n[k]; Object.assign(n, structuredClone(d)); }
    return n;
  };
  let n = schema;
  for (const k of path) {
    n = own(n)?.properties?.[k];
    if (!n || typeof n !== "object") return null;
  }
  return own(n);
}

const getPath = (v: J, path: string[]) => path.reduce((x, k) => (x && typeof x === "object" ? x[k] : undefined), v);
const join = (a: J, b: string) => [typeof a === "string" ? a : "", b].filter(Boolean).join("\n\n");

function value(v: J, kind: Kind): string | null {
  if (v === undefined || v === null) return null;
  if (kind === "multi") return Array.isArray(v) ? multi(v) : null;
  return String(v);
}
/** A multi-select answer as stored and compared: sorted, unique, JSON. */
export const multi = (xs: J[]) => JSON.stringify(uniq(xs.filter(x => x != null).map(String)).sort());

// ---------------- where each provider puts tools and schemas ----------------

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
    const schema = holder.input_schema ?? holder.parameters ?? holder.parametersJsonSchema;
    return schema && typeof schema === "object" ? { name, holder, schema } : null;
  }
  return null;
}

/** The structured-output schema of a request, and its name. */
function format(route: Route, body: J): { name: string; schema: J } | null {
  let f: J = null, name: string | undefined;
  if (route === "responses" && body?.text?.format?.type === "json_schema") { f = body.text.format.schema; name = body.text.format.name; }
  else if (route === "chat" && body?.response_format?.type === "json_schema") { f = body.response_format.json_schema?.schema; name = body.response_format.json_schema?.name; }
  else if (route === "anthropic") {
    const o = body?.output_config?.format ?? body?.output_format;
    if (o?.type === "json_schema") f = o.schema;
  } else if (route === "gemini") {
    const g = body?.generationConfig ?? body?.generation_config;
    f = g?.responseJsonSchema ?? g?.responseSchema ?? g?.response_json_schema ?? g?.response_schema;
  }
  if (!f || typeof f !== "object") return null;
  return { name: name || (typeof f.title === "string" && f.title) || "response", schema: f };
}

function toolArgs(route: Route, name: string, r: J): J {
  if (route === "chat") return parse(r?.choices?.[0]?.message?.tool_calls?.find((c: J) => c?.function?.name === name)?.function?.arguments);
  if (route === "responses") return parse((r?.output ?? []).find((o: J) => o?.type === "function_call" && o?.name === name)?.arguments);
  if (route === "anthropic") return (r?.content ?? []).find((c: J) => c?.type === "tool_use" && c?.name === name)?.input ?? null;
  if (route === "gemini") return (r?.candidates?.[0]?.content?.parts ?? []).find((p: J) => p?.functionCall?.name === name)?.functionCall?.args ?? null;
  return null;
}

/** The structured output a response carries, parsed. */
function output(route: Route, r: J): J {
  if (route === "responses") {
    const text = r?.output_text ?? (r?.output ?? []).flatMap((o: J) => (o?.type === "message" ? o.content ?? [] : []))
      .find((c: J) => c?.type === "output_text")?.text;
    return parse(text);
  }
  if (route === "chat") {
    const m = r?.choices?.[0]?.message;
    return m?.parsed ?? parse(typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p: J) => p?.text ?? "").join(""));
  }
  if (route === "anthropic") return parse((r?.content ?? []).find((c: J) => c?.type === "text")?.text);
  if (route === "gemini") return parse((r?.candidates?.[0]?.content?.parts ?? []).map((p: J) => (p?.thought ? "" : p?.text ?? "")).join(""));
  return null;
}

// ---------------- decisions: what a request decides, how to write a policy into it, how to read the answer ----------------

interface Found extends Omit<Spec, "name"> {
  write(text: PolicyText): void;      // into the request it was found in
  read(response: J): Answer;
}

const certainP = (p: number) => p >= 0.8 || p <= 0.2;
const parse = (s: J) => { try { return typeof s === "string" ? JSON.parse(s) : s ?? null; } catch { return null; } };
const plain = (v: string | null): Answer => ({ value: v, confidence: null, certain: false });

function found(route: Route, body: J): Found[] {
  if (!body || typeof body !== "object") return [];
  const out: Found[] = [];
  if (route === "decisions") {
    for (const q of Array.isArray(body.questions) ? body.questions : []) {
      if (!q?.name) continue;
      const key = String(q.name), base = { key, route, source: "question" as const, instructions: q.instructions };
      const pick = (r: J) => (r?.answers ?? []).find((y: J) => y?.name === key);
      if (q.type === "predicate") out.push({ ...base, kind: "bool", options: ["true", "false"],
        write: t => { q.instructions = `${q.instructions}\n\nPolicy:\n${rubric(t, ["true", "false"])}`; },
        read: r => { const x = pick(r); return typeof x?.probability === "number" ? { value: String(x.probability >= 0.5), confidence: x.probability, certain: certainP(x.probability) } : plain(null); } });
      else if (q.type === "choice") out.push({ ...base, kind: "category", options: (q.choices ?? []).map((c: J) => String(c.value)),
        codeText: describe(Object.fromEntries((q.choices ?? []).filter((c: J) => c.description).map((c: J) => [String(c.value), c.description]))),
        write: t => { for (const c of q.choices ?? []) if (t[String(c.value)]) c.description = t[String(c.value)]; },
        read: r => { const x = pick(r); return x?.choice != null ? { value: String(x.choice), confidence: x.confidence ?? null, certain: (x.confidence ?? 0) >= 0.8 } : plain(null); } });
      else if (q.type === "score") {
        const options = (q.levels ?? []).map((l: J) => String(l.label));
        out.push({ ...base, kind: "scale", options,
          codeText: describe(Object.fromEntries((q.levels ?? []).filter((l: J) => l.description).map((l: J) => [String(l.label), l.description]))),
          write: t => { for (const l of q.levels ?? []) if (t[String(l.label)]) l.description = t[String(l.label)]; },
          read: r => {
            const x = pick(r);
            if (!x) return plain(null);
            const best = [...(x.probabilities ?? [])].sort((p: J, q: J) => q.probability - p.probability)[0];
            return { value: best ? String(best.label ?? best.value) : options[Math.round(x.score)] ?? null, confidence: x.confidence ?? null, certain: (x.confidence ?? 0) >= 0.8 };
          } });
      }
    }
    return out;
  }
  if (route === "systemone") {
    for (const [key, q] of Object.entries<J>(body.questions && !Array.isArray(body.questions) ? body.questions : {})) {
      const crit = q?.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? q.criteria : {};
      const base = { key, route, source: "question" as const, instructions: str(q?.instructions), codeText: describe(crit) };
      const write = (opts: string[]) => (t: PolicyText) => { q.criteria = { ...(q.criteria ?? {}) }; for (const o of opts) if (t[o]) q.criteria[o] = t[o]; };
      if (q?.type === "noul") out.push({ ...base, kind: "bool", options: ["true", "false"], write: write(["true", "false"]),
        read: r => { const x = r?.answers?.[key]; return typeof x?.noul === "number" ? { value: String(x.noul >= 0.5), confidence: x.noul, certain: certainP(x.noul) } : plain(null); } });
      else if (q?.type === "choice") out.push({ ...base, kind: "category", options: Object.keys(crit), write: write(Object.keys(crit)),
        read: r => { const x = r?.answers?.[key]; return x?.choice != null ? { value: String(x.choice), confidence: x.confidence ?? null, certain: (x.confidence ?? 0) >= 0.8 } : plain(null); } });
      // score criteria are the level descriptions themselves; not managed
    }
    return out;
  }
  const schemaDecisions = (prefix: string, schema: J, source: "tool" | "format", instructions: string | undefined, read: (r: J) => J) => {
    for (const f of fields(schema)) out.push({
      key: `${prefix}.${f.path.join(".")}`, route, kind: f.choice.kind, options: f.choice.options, source, path: f.path.join("."),
      instructions, codeText: typeof f.node.description === "string" ? f.node.description : undefined,
      write: t => { const n = locate(schema, f.path); if (n) n.description = join(n.description, rubric(t, f.choice.options)); },
      read: r => plain(value(getPath(read(r), f.path), f.choice.kind)),
    });
  };
  const tool = forcedTool(route, body);
  if (tool) schemaDecisions(tool.name, tool.schema, "tool", tool.holder.description, r => toolArgs(route, tool.name, r));
  const fmt = format(route, body);
  if (fmt) schemaDecisions(fmt.name, fmt.schema, "format", typeof fmt.schema.description === "string" ? fmt.schema.description : undefined, r => output(route, r));
  return out;
}

function named(f: Found, rename?: Rename): string | null {
  if (!rename) return f.key;
  const n = rename(f.key, { route: f.route, kind: f.kind, options: f.options, source: f.source, instructions: f.instructions });
  return n === undefined ? f.key : n ? String(n) : null;
}

/** The decisions a request carries. */
export function specs(route: Route, body: J, rename?: Rename): Spec[] {
  return found(route, body).flatMap(({ write, read, ...f }) => {
    const name = named({ ...f, write, read }, rename);
    return name ? [{ ...f, name }] : [];
  });
}

// ---------------- apply: write live policy text into the request (mutates body) ----------------

export const rubric = (text: PolicyText, options?: string[]) =>
  (options ?? Object.keys(text)).filter(o => text[o]).map(o => `${o}: ${text[o]}`).join("\n");

/** Writes each decision's live text, describing only the options this call has. Returns {policy: version}. */
export function apply(route: Route, body: J, live: Record<string, LivePolicy>, rename?: Rename): Record<string, number> {
  const used: Record<string, number> = {};
  for (const f of found(route, body)) {
    const name = named(f, rename);
    const p = name ? live[name] : undefined;
    if (!name || !p || !p.version || !f.options.some(o => p.text?.[o])) continue;
    f.write(p.text);
    used[name] = p.version;
  }
  return used;
}

// ---------------- answers: what did the model decide ----------------

/** Every decision in a call with the model's answer, one entry per decision (two keys can share a policy). */
export function decided(route: Route, request: J, response: J, rename?: Rename): (Spec & { answer: Answer })[] {
  return found(route, request).flatMap(f => {
    const name = named(f, rename);
    const { write, read, ...rest } = f;
    return name ? [{ ...rest, name, answer: read(response) }] : [];
  });
}

/** Rename that keeps exactly one decision of a request, under its policy name: for replaying a recorded case. */
export const only = (key: string, policy: string): Rename => k => (k === key ? policy : null);

export function answers(route: Route, request: J, response: J, rename?: Rename): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const f of found(route, request)) {
    const name = named(f, rename);
    if (name && !out[name]) out[name] = f.read(response);
  }
  return out;
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
