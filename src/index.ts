/**
 * decidus: one option on the client you already use.
 *
 *   new OpenAI({ fetch: decidus.fetch() })
 *   new Anthropic({ fetch: decidus.fetch() })
 *   new GoogleGenAI({ apiKey, httpOptions: { fetch: decidus.fetch() } })
 *   new TypeSafeClient({ fetch: decidus.fetch() })
 *
 * On a decision call it writes the live policy text into the request, sends it on unchanged
 * otherwise, and copies request + response to Decidus in the background. Everything else passes
 * straight through. Decidus never blocks a call and never changes the answer; if it is unreachable,
 * calls go out exactly as your code wrote them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { apply, normScope, resolve, routeOf, specs, type LiveSet } from "./shapes.js";

export type { LivePolicy, LiveSet, PolicyText, Spec, Route, Kind, Answer } from "./shapes.js";

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
}

const als = new AsyncLocalStorage<TraceContext>();

/** Tag every decision made inside fn: decidus.trace({ scope: "acme/support-bot", conversationId }, () => ...) */
export function trace<T>(ctx: TraceContext, fn: () => T): T {
  const outer = als.getStore() ?? {};
  return als.run({ ...outer, ...ctx, metadata: { ...outer.metadata, ...ctx.metadata } }, fn);
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

    let body: any, original: any;
    try {
      const raw = typeof init?.body === "string" ? init.body : await new Request(input, init).clone().text();
      body = JSON.parse(raw);
      original = JSON.parse(raw);           // as the code wrote it; replay applies each version to this
      if (!specs(route, body).length) return inner(input, init);
    } catch { return inner(input, init); }

    const ctx = als.getStore() ?? {};
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const h = (k: string) => headers.get(`x-decidus-${k}`);
    const scope = normScope(h("scope") ?? ctx.scope ?? opts.scope);
    const ids = { trace_id: h("trace-id") ?? ctx.traceId ?? null, conversation_id: h("conversation-id") ?? ctx.conversationId ?? null, event_id: h("event-id") ?? ctx.eventId ?? null };
    for (const k of [...headers.keys()]) if (k.startsWith("x-decidus-")) headers.delete(k);
    headers.delete("content-length");

    let versions: Record<string, number> = {};
    try { versions = apply(route, body, resolve(await link.policies(), scope)); } catch { /* fail open: send as written */ }

    const t0 = Date.now();
    const res = await inner(url, { ...init, method, headers, body: JSON.stringify(body), signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) });

    if (!body.stream && res.headers.get("content-type")?.includes("json")) {
      const clean = new URL(url);
      clean.searchParams.delete("key");      // Gemini accepts the API key as ?key=
      res.clone().json().then(response => link.record({
        url: clean.toString(), status: res.status, ms: Date.now() - t0, versions, scope, ...ids, metadata: ctx.metadata ?? {},
        headers: Object.fromEntries([...headers].filter(([k]) => !SECRET.test(k))),
        request: original, response,
      })).catch(() => {});
    }
    return res;
  }) as Fetch;
}
