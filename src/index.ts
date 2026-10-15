/**
 * decidus: one option on the client you already use.
 *
 *   new OpenAI({ fetch: decidus.fetch() })
 *   new Anthropic({ fetch: decidus.fetch() })
 *   new GoogleGenAI({ apiKey, httpOptions: { fetch: decidus.fetch() } })
 *   new TypeSafeClient({ fetch: decidus.fetch() })
 *
 * A decision call is a structured output, or a function call forced to one tool, whose schema has a
 * fixed-choice field (enum, const alternatives, boolean, or an array of those); or an OpenAI
 * Decisions or Jev call. It merges the live version of the decision's text into the request (the
 * code's own text is the base), sends it on unchanged otherwise, and copies request + response to
 * decidus in the background. Everything else passes
 * straight through. decidus never blocks a call and never changes the answer; if it is unreachable,
 * calls go out exactly as your code wrote them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { apply, normScope, resolve, routeOf, specs, type Kind, type LivePolicy, type LiveSet, type Rename, type Route } from "./shapes.js";

export type { LivePolicy, LiveSet, Doc, Op, Spec, Route, Kind, Answer } from "./shapes.js";

/** A decision decidus found in a request, as the `name` option sees it. */
export interface Decision {
  /** decidus's own name: schema or tool name + field path (`select_tags.chosen_tags.Intent`), or the question name. */
  name: string;
  kind: Kind;
  options: string[];
  source: "tool" | "format" | "question";
  route: Route;
  instructions?: string;
}

type Fetch = typeof globalThis.fetch;
export interface TraceContext {
  /**
   * Where the call comes from, as a path: "acme" or "acme/support-bot". A scope can have its own
   * policy versions; without one it runs its parent's, and in the end the global policy.
   */
  scope?: string;
  /** Your ids, to find a call later. They never change which policy runs. */
  traceId?: string;
  conversationId?: string;
  eventId?: string;
  metadata?: Record<string, unknown>;
  /**
   * Policy names for decisions whose key says nothing stable, such as a generated `rule_1`:
   *   decidus.trace({ names: { rule_1: `guardrail_${rule.id}` } }, () => ...)
   * Use an id that's stable for that rule (and customer), like its database uuid. Applied before `name`.
   */
  names?: Record<string, string>;
}
export interface Options {
  /** Hosted API key. Defaults to DECIDUS_API_KEY. */
  apiKey?: string;
  /** Defaults to DECIDUS_BASE_URL, else https://api.decidus.ai with a key, else http://localhost:7700. */
  baseUrl?: string;
  /** The fetch to wrap. Defaults to globalThis.fetch. */
  fetch?: Fetch;
  /** How long live policies are cached, in ms. Default 30s. */
  ttlMs?: number;
  /** Scope for every call made with this client, unless trace() or a header says otherwise. */
  scope?: string;
  /**
   * Rename a decision, or return null to leave it alone. Useful when keys are generated per item
   * (`articles_1`, `articles_2` -> `articles_n`) or a field isn't really a decision.
   *   name: d => d.name.replace(/\d+/g, "n")
   */
  name?: (d: Decision) => string | null | undefined;
}

const als = new AsyncLocalStorage<TraceContext>();

/** Tag every decision made inside fn: decidus.trace({ scope: "acme/support-bot", conversationId }, () => ...) */
export function trace<T>(ctx: TraceContext, fn: () => T): T {
  const outer = als.getStore() ?? {};
  return als.run({ ...outer, ...ctx, metadata: { ...outer.metadata, ...ctx.metadata }, names: { ...outer.names, ...ctx.names } }, fn);
}

/** 0-100, the same for the same policy and conversation, so a conversation stays on one version. */
function bucket(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return ((h >>> 0) % 10000) / 100;
}
/** The version a call runs: the candidate for its share of calls (per conversation when there is one), else live. */
function serve(name: string, p: LivePolicy, conversation: string | null) {
  const c = p.canary;
  if (c && c.pct > 0 && (conversation ? bucket(`${name}|${conversation}`) : Math.random() * 100) < c.pct) return { version: c.version, ops: c.ops };
  return { version: p.version, ops: p.ops };
}

const SECRET = /authorization|api-key|apikey|token|secret|cookie|^x-decidus-/i;

class Link {
  live: LiveSet = { policies: {} };
  private at = 0;
  private inflight?: Promise<void>;
  constructor(readonly base: string, readonly key: string | undefined, readonly net: Fetch, readonly ttl: number) {}

  private auth(): Record<string, string> { return this.key ? { authorization: `Bearer ${this.key}` } : {}; }

  async policies(): Promise<LiveSet> {
    if (Date.now() - this.at > this.ttl && !this.inflight) {
      this.inflight = this.net(`${this.base}/v1/policies`, { headers: this.auth(), signal: AbortSignal.timeout(1500) })
        .then(r => r.ok ? r.json() : null)
        .then((j: any) => { if (j?.policies) this.live = { policies: j.policies, scopes: j.scopes ?? {} }; })
        .catch(() => {})
        .finally(() => { this.at = Date.now(); this.inflight = undefined; });
    }
    if (!this.at && this.inflight) await Promise.race([this.inflight, new Promise(r => setTimeout(r, 300))]);
    return this.live;
  }

  record(rec: unknown) {
    this.net(`${this.base}/v1/records`, {
      method: "POST", headers: { "content-type": "application/json", ...this.auth() }, body: JSON.stringify(rec),
    }).then(r => r.body?.cancel()).catch(() => {});
  }
}

const links = new Map<string, Link>();

export function fetch(opts: Options = {}): Fetch {
  const inner: Fetch = opts.fetch ?? ((i, n) => globalThis.fetch(i, n));
  if (process.env.DECIDUS_DISABLED) return inner;
  const key = opts.apiKey ?? process.env.DECIDUS_API_KEY;
  const base = (opts.baseUrl ?? process.env.DECIDUS_BASE_URL ?? (key ? "https://api.decidus.ai" : "http://localhost:7700")).replace(/\/$/, "");
  const id = `${base}|${key ?? ""}`;
  if (!links.has(id)) links.set(id, new Link(base, key, (i, n) => globalThis.fetch(i, n), opts.ttlMs ?? 30_000));
  const link = links.get(id)!;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = input instanceof Request ? input.url : String(input);
    const route = method === "POST" ? routeOf(new URL(url).pathname) : null;
    if (!route) return inner(input, init);

    // trace names and the name hook, kept to send along so the server files each decision the same way
    const ctx = als.getStore() ?? {};
    const names: Record<string, string | null> = {};
    const given = ctx.names ?? {};
    const rename: Rename | undefined = (opts.name || Object.keys(given).length) ? ((key, d) => {
      let n: string | null | undefined = given[key] ? String(given[key]) : undefined;
      if (n === undefined && opts.name) { try { n = opts.name({ name: key, ...d }); } catch { n = undefined; } }
      if (n !== undefined && n !== key) names[key] = n || null;
      return n;
    }) : undefined;

    let body: any, original: any;
    try {
      const raw = typeof init?.body === "string" ? init.body : await new Request(input, init).clone().text();
      body = JSON.parse(raw);
      original = JSON.parse(raw);           // as the code wrote it; replay applies each version to this
      if (!specs(route, body, rename).length) return inner(input, init);
    } catch { return inner(input, init); }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const h = (k: string) => headers.get(`x-decidus-${k}`);
    const scope = normScope(h("scope") ?? ctx.scope ?? opts.scope);
    const ids = { trace_id: h("trace-id") ?? ctx.traceId ?? null, conversation_id: h("conversation-id") ?? ctx.conversationId ?? null, event_id: h("event-id") ?? ctx.eventId ?? null };
    for (const k of [...headers.keys()]) if (k.startsWith("x-decidus-")) headers.delete(k);
    headers.delete("content-length");

    let used: ReturnType<typeof apply> = { versions: {}, retired: {} };
    try {
      const live = resolve(await link.policies(), scope);
      const run = Object.fromEntries(Object.entries(live).map(([n, p]) => [n, serve(n, p, ids.conversation_id)]));
      used = apply(route, body, run, rename);
    } catch { /* fail open: send as written */ }

    const t0 = Date.now();
    const res = await inner(url, { ...init, method, headers, body: JSON.stringify(body), signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) });

    if (!body.stream && res.headers.get("content-type")?.includes("json")) {
      const clean = new URL(url);
      clean.searchParams.delete("key");      // Gemini accepts the API key as ?key=
      res.clone().json().then(response => link.record({
        url: clean.toString(), status: res.status, ms: Date.now() - t0, versions: used.versions, scope, ...ids, metadata: ctx.metadata ?? {},
        ...(Object.keys(names).length ? { names } : {}), ...(Object.keys(used.retired).length ? { retired: used.retired } : {}),
        headers: Object.fromEntries([...headers].filter(([k]) => !SECRET.test(k))),
        request: original, response,
      })).catch(() => {});
    }
    return res;
  }) as Fetch;
}
