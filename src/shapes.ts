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
 * A policy is the decision's own text: every string that belongs to it (the field's description,
 * the question's instructions, each criterion), versioned as clause edits against what the code
 * sends (see clauses.ts). decidus only ever changes that text; options, names, objects and the
 * rest of the schema stay exactly as the caller wrote them.
 */
import { patch, type Doc } from "./clauses.js";
export type { Doc, Op } from "./clauses.js";

export type Route = "decisions" | "systemone" | "chat" | "responses" | "anthropic" | "gemini";
export type Kind = "bool" | "category" | "scale" | "multi";
/** What a call runs: a version's edits, and maybe a candidate version served to a share of calls. */
export interface LivePolicy { version: number; ops: Doc; canary?: { version: number; ops: Doc; pct: number } }
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

// ---------------- decisions: what a request decides, its text, and how to read the answer ----------------

/**
 * A decision found in a request. `parts` is its text as the code wrote it, by part:
 *   schema field:  "description", and "items.description" for a multi-select that has one
 *   Jev question:  "instructions" (or "instructions.<key>" for each string in an instructions object), "criteria.<option>"
 *   Decisions:     "instructions", "choices.<value>", "levels.<label>"
 * Only strings are parts: objects (an article card), arrays (examples) and option sets are never written.
 */
interface Found extends Omit<Spec, "name"> {
  parts(): Record<string, string>;
  set(part: string, text: string): void;     // into the request it was found in
  read(response: J): Answer;
  /** Free text the model wrote next to its answer (a reasoning field), for reviewers and the writer. */
  said(response: J): Record<string, string>;
  /** What this decision is about in this call, beyond its text: an article card, a rule's examples. */
  about(): string | null;
}

const certainP = (p: number) => p >= 0.8 || p <= 0.2;
const parse = (s: J) => { try { return typeof s === "string" ? JSON.parse(s) : s ?? null; } catch { return null; } };
const plain = (v: string | null): Answer => ({ value: v, confidence: null, certain: false });
const text0 = (x: J) => (typeof x === "string" ? x : "");
const rest = (part: string, prefix: string) => (part.startsWith(prefix + ".") ? part.slice(prefix.length + 1) : null);
/** String fields of an answer object other than the answer itself (Decisions and Jev can return a reasoning). */
const strings = (x: J, skip: string[] = []): Record<string, string> =>
  x && typeof x === "object" ? Object.fromEntries(Object.entries<J>(x).filter(([k, v]) => typeof v === "string" && v.trim() && !skip.includes(k))) : {};
const brief = (x: J) => { const s = JSON.stringify(x); return s.length > 1200 ? s.slice(0, 1200) + "…" : s; };

function found(route: Route, body: J): Found[] {
  if (!body || typeof body !== "object") return [];
  const out: Found[] = [];
  if (route === "decisions") {
    for (const q of Array.isArray(body.questions) ? body.questions : []) {
      if (!q?.name) continue;
      const key = String(q.name);
      const pick = (r: J) => (r?.answers ?? []).find((y: J) => y?.name === key);
      const list: J[] = q.type === "choice" ? q.choices ?? [] : q.type === "score" ? q.levels ?? [] : [];
      const field = q.type === "choice" ? "value" : "label", prefix = q.type === "choice" ? "choices" : "levels";
      const base = {
        key, route, source: "question" as const, instructions: text0(q.instructions) || undefined,
        parts: () => ({ instructions: text0(q.instructions), ...Object.fromEntries(list.map(c => [`${prefix}.${c?.[field]}`, text0(c?.description)])) }),
        set: (part: string, t: string) => {
          if (part === "instructions") q.instructions = t;
          const o = rest(part, prefix), c = o != null && list.find(c => String(c?.[field]) === o);
          if (c) { if (t) c.description = t; else delete c.description; }
        },
        said: (r: J) => strings(pick(r), ["name", "type", "choice", "label", "value"]),
        about: () => null,
      };
      if (q.type === "predicate") out.push({ ...base, kind: "bool", options: ["true", "false"],
        read: r => { const x = pick(r); return typeof x?.probability === "number" ? { value: String(x.probability >= 0.5), confidence: x.probability, certain: certainP(x.probability) } : plain(null); } });
      else if (q.type === "choice") out.push({ ...base, kind: "category", options: list.map(c => String(c.value)),
        read: r => { const x = pick(r); return x?.choice != null ? { value: String(x.choice), confidence: x.confidence ?? null, certain: (x.confidence ?? 0) >= 0.8 } : plain(null); } });
      else if (q.type === "score") {
        const options = list.map(l => String(l.label));
        out.push({ ...base, kind: "scale", options,
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
      if (!q || typeof q !== "object") continue;
      const crit = () => (q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? q.criteria : {});
      const ins = () => (q.instructions && typeof q.instructions === "object" && !Array.isArray(q.instructions) ? q.instructions : null);
      const base = {
        key, route, source: "question" as const,
        instructions: typeof q.instructions === "string" ? q.instructions : text0(ins()?.question) || str(q.instructions),
        parts: () => {
          const o: Record<string, string> = {};
          if (typeof q.instructions === "string") o.instructions = q.instructions;
          for (const [k, v] of Object.entries<J>(ins() ?? {})) if (typeof v === "string") o[`instructions.${k}`] = v;
          for (const [k, v] of Object.entries<J>(crit())) if (typeof v === "string") o[`criteria.${k}`] = v;
          return o;
        },
        set: (part: string, t: string) => {
          if (part === "instructions") q.instructions = t;
          const i = rest(part, "instructions"), c = rest(part, "criteria");
          if (i != null && ins() && typeof ins()[i] === "string") q.instructions = { ...ins(), [i]: t };
          if (c != null && typeof crit()[c] === "string") q.criteria = { ...crit(), [c]: t };
        },
        said: (r: J) => strings(r?.answers?.[key], ["type", "choice"]),
        about: () => {
          const objects = [...Object.entries<J>(ins() ?? {}), ...Object.entries<J>(crit())].filter(([, v]) => v != null && typeof v === "object");
          return objects.length ? objects.map(([k, v]) => `${k}: ${brief(v)}`).join("\n") : null;
        },
      };
      if (q.type === "noul") out.push({ ...base, kind: "bool", options: ["true", "false"],
        read: r => { const x = r?.answers?.[key]; return typeof x?.noul === "number" ? { value: String(x.noul >= 0.5), confidence: x.noul, certain: certainP(x.noul) } : plain(null); } });
      else if (q.type === "choice") out.push({ ...base, kind: "category", options: Object.keys(crit()),
        read: r => { const x = r?.answers?.[key]; return x?.choice != null ? { value: String(x.choice), confidence: x.confidence ?? null, certain: (x.confidence ?? 0) >= 0.8 } : plain(null); } });
      // score criteria are the level descriptions themselves; not managed
    }
    return out;
  }
  const schemaDecisions = (prefix: string, schema: J, source: "tool" | "format", instructions: string | undefined, read: (r: J) => J) => {
    const all = fields(schema), decisionPaths = new Set(all.map(f => f.path.join(".")));
    for (const f of all) {
      const items = () => (f.choice.kind === "multi" ? deref(f.node.items, schema) : null);
      out.push({
        key: `${prefix}.${f.path.join(".")}`, route, kind: f.choice.kind, options: f.choice.options, source, path: f.path.join("."), instructions,
        parts: () => ({ description: text0(f.node.description), ...(typeof items()?.description === "string" ? { "items.description": items().description } : {}) }),
        set: (part, t) => {
          const n = locate(schema, f.path);
          if (!n) return;
          if (part === "description") { if (t || n.description !== undefined) n.description = t; }
          else if (part === "items.description" && n.items) { n.items = structuredClone(deref(n.items, schema)); n.items.description = t; }
        },
        read: r => plain(value(getPath(read(r), f.path), f.choice.kind)),
        said: r => {             // every free-text field of the output: "reasoning", "chosen_tags.why", ...
          const o: Record<string, string> = {};
          const walk = (v: J, path: string[]) => {
            if (typeof v === "string" && v.trim() && !decisionPaths.has(path.join("."))) o[path.join(".")] = v;
            else if (v && typeof v === "object" && !Array.isArray(v) && path.length < 6) for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
          };
          walk(read(r), []);
          return o;
        },
        about: () => null,
      });
    }
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
const spec = ({ parts, set, read, said, about, ...f }: Found, name: string): Spec => ({ ...f, name });

/** The decisions a request carries. */
export function specs(route: Route, body: J, rename?: Rename): Spec[] {
  return found(route, body).flatMap(f => {
    const name = named(f, rename);
    return name ? [spec(f, name)] : [];
  });
}

/** One decision's text in a request, by part (see Found). Null if the request has no such decision. */
export function textParts(route: Route, body: J, key: string): Record<string, string> | null {
  return found(route, body).find(f => f.key === key)?.parts() ?? null;
}

// ---------------- apply: write a version's text into the request (mutates body) ----------------

/**
 * Applies each decision's version to its text, part by part, merged with what the code sends now.
 * Returns the version each policy ran, and how many of its edits no longer apply because the
 * code changed the clause they edit (the code wins).
 */
export function apply(route: Route, body: J, live: Record<string, { version: number; ops: Doc }>, rename?: Rename):
  { versions: Record<string, number>; retired: Record<string, number> } {
  const versions: Record<string, number> = {}, retired: Record<string, number> = {};
  for (const f of found(route, body)) {
    const name = named(f, rename);
    const p = name ? live[name] : undefined;
    if (!name || !p?.version || !p.ops) continue;          // no edits (or a pre-0.4 server): the call goes out as written
    const parts = f.parts();
    let gone = 0;
    for (const [part, ops] of Object.entries(p.ops ?? {})) {
      if (!(part in parts) || !Array.isArray(ops) || !ops.length) continue;      // a part this call doesn't have
      const r = patch(parts[part], ops);
      if (r.text !== parts[part]) f.set(part, r.text);
      gone += r.retired.length;
    }
    versions[name] = p.version;
    if (gone) retired[name] = (retired[name] ?? 0) + gone;
  }
  return { versions, retired };
}

// ---------------- answers: what did the model decide ----------------

/** Every decision in a call with the model's answer, one entry per decision (two keys can share a policy). */
export function decided(route: Route, request: J, response: J, rename?: Rename): (Spec & { answer: Answer })[] {
  return found(route, request).flatMap(f => {
    const name = named(f, rename);
    return name ? [{ ...spec(f, name), answer: f.read(response) }] : [];
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

/** For one decision of a recorded call: the model's free text next to its answer, and what the decision was about. */
export function evidence(route: Route, request: J, response: J, key: string): { said: Record<string, string>; about: string | null } {
  const f = found(route, request).find(x => x.key === key);
  return f ? { said: f.said(response), about: f.about() } : { said: {}, about: null };
}

// ---------------- excerpt: the human-readable input, for the queue and the writer ----------------

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
  if (route === "systemone" && body?.state && typeof body.state === "object") {
    const e = Object.entries<J>(body.state).filter(([, v]) => typeof v === "string" && v.trim());
    const best = e.find(([k]) => /message|question|reply|text|input/i.test(k)) ?? e[0];
    if (best) return String(best[1]).replace(/\s+/g, " ").slice(0, 160);
  }
  const ex = excerpt(route, body, 4000).split("\n").filter(l => !l.startsWith("system:") && !l.startsWith("developer:"));
  const user = ex.filter(l => l.startsWith("user:")).pop() ?? ex.pop() ?? "";
  return user.replace(/^user:\s*/, "").slice(0, 160);
}

function str(x: J): string | undefined { return x == null ? undefined : typeof x === "string" ? x : JSON.stringify(x); }
