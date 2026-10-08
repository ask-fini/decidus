import http from "node:http";
import { readFileSync } from "node:fs";
import { answers, apply, headline, normScope, prefixes, routeOf, specs, type Route } from "./shapes.js";
import { Store, type CallFilter } from "./store.js";
import { accept, edit, replay, suggest, tune } from "./loop.js";

export interface ServeOptions {
  port?: number;
  db?: string;
  /** If set, /v1 and /api require `Authorization: Bearer <apiKey>`. Defaults to DECIDUS_API_KEY. */
  apiKey?: string;
  /** Every call is reviewable until a policy has this many in a scope. Default 20. */
  warmup?: number;
  /** After warm-up, the share of confident or unscored calls that are reviewable too. Default 0.1. */
  sample?: number;
  /** How many calls the queue shows at a time. Default 50. */
  queueSize?: number;
  /** Days to keep the bodies of calls nobody decided. Default 30; 0 keeps them forever. */
  retentionDays?: number;
  quiet?: boolean;
}

/**
 * Reviewable ("eligible") calls: every call the model was unsure about, the first `warmup` of each
 * scope, and a `sample` of the rest, so confident mistakes and function calls (no confidence) show up too.
 * The queue then shows a balanced window over them.
 */
function eligible(store: Store, policy: string, scope: string, a: { value: string | null; confidence: number | null; certain: boolean }, warmup: number, sample: number) {
  if (a.value == null) return true;
  if (a.confidence != null && !a.certain) return true;
  return store.eligibleCount(policy, scope, warmup) < warmup || Math.random() < sample;
}

function modelOf(url: URL, body: any): string | null {
  return body?.model ?? url.pathname.match(/models\/([^/:]+):/)?.[1] ?? null;
}
const str = (x: unknown) => (x == null || x === "" ? null : String(x).slice(0, 200));
const int = (x: unknown) => { const n = Math.trunc(Number(x)); return Number.isFinite(n) && n >= 0 ? n : 0; };

export function ingest(store: Store, rec: any, warmup = 20, sample = 0.1): number[] {
  const url = new URL(rec.url);
  const route = routeOf(url.pathname);
  if (!route) return [];
  const ids: number[] = [];
  const model = modelOf(url, rec.request);
  const scope = normScope(rec.scope);
  const status = int(rec.status);
  const said = answers(route, rec.request, rec.response);
  for (const s of specs(route, rec.request)) {
    store.seen(s, model);
    const a = said[s.name];
    ids.push(store.addCase({
      policy: s.name, scope, version: int(rec.versions?.[s.name]), model,
      answer: a.value, confidence: a.confidence, escalated: status < 400 && eligible(store, s.name, scope, a, warmup, sample),
      status, ms: int(rec.ms),
      trace_id: str(rec.trace_id), conversation_id: str(rec.conversation_id), event_id: str(rec.event_id),
      headline: headline(route, rec.request), metadata: rec.metadata ?? {},
      url: rec.url, headers: rec.headers ?? {}, request: rec.request, response: rec.response,
    }));
  }
  return ids;
}

function overview(store: Store) {
  return store.policies().map(p => {
    const t = store.tally(p.name, "");
    const variants = store.variants(p.name);
    const live = variants.find(v => !v.scope)?.live ?? 0;
    const r = store.version(p.name, live)?.replay;
    return {
      name: p.name, kind: p.kind, route: p.route, model: p.model, instructions: p.instructions, live,
      overrides: variants.filter(v => v.scope && v.live != null).length,
      suggestions: variants.filter(v => v.suggestion).length,
      calls: t.calls, queue: t.queue, unprocessed: t.unprocessed,
      replay: r ? { pass: r.filter(x => x.pass).length, n: r.length } : null,
      agreement: Object.entries(store.agreement(p.name, "")).map(([v, a]) => ({ v: Number(v), ...a })).sort((a, b) => a.v - b.v),
      daily: store.daily(p.name, 14),
    };
  });
}

function detail(store: Store, name: string, scope: string, queueSize: number) {
  const p = store.policy(name);
  if (!p) return null;
  const lineage = new Set(prefixes(scope));
  const v = store.variant(name, scope);
  return {
    policy: p, scope, effective: store.effective(name, scope), own: v.live, suggestion: v.suggestion,
    versions: store.versions(name).filter(x => lineage.has(x.scope)),
    scopes: store.scopes(name),
    overrides: store.variants(name).filter(x => x.scope).map(x => ({ scope: x.scope, live: x.live, suggestion: !!x.suggestion })),
    tally: store.tally(name, scope),
    queue: store.queue(name, scope, queueSize),
    unprocessed: store.unprocessed(name, scope, 500),
    processed: store.processed(name, scope, 300),
    agreement: store.agreement(name, scope),
    maxCases: Number(process.env.DECIDUS_MAX_CASES ?? 100),
    next: store.nextVersion(name),
  };
}

/** `answer:billing v:2 conf:<0.6 decided:no queue conv_8f2c1` */
export function parseFilter(q: string): CallFilter {
  const f: CallFilter = {}, words: string[] = [];
  for (const tok of q.trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(\w+):(.+)$/);
    const k = (m?.[1] ?? tok).toLowerCase(), v = m?.[2] ?? "";
    if (m && (k === "answer" || k === "a")) f.answer = v === "yes" ? "true" : v === "no" ? "false" : v;
    else if (m && (k === "v" || k === "version")) f.version = Number(v.replace(/^v/, ""));
    else if (m && k === "decided") f.decided = v === "no" ? "no" : "yes";
    else if (m && k === "conf") { const c = v.match(/^([<>]=?)?(\d*\.?\d+)$/); if (c) c[1]?.startsWith(">") ? (f.minConf = +c[2]) : (f.maxConf = +c[2]); }
    else if (!m && (k === "queue" || k === "queued")) f.queued = true;
    else words.push(tok);
  }
  if (words.length) f.text = words.join(" ");
  return f;
}

/** The request as it was sent: the code's request with that version's text applied. */
function caseView(store: Store, id: number) {
  const c = store.case(id);
  if (!c) return null;
  let sent = null;
  if (c.request && c.url) {
    sent = structuredClone(c.request);
    const v = store.version(c.policy, c.version);
    if (v && c.version > 0) apply(routeOf(new URL(c.url).pathname) as Route, sent, { [c.policy]: { version: c.version, text: v.text } });
  }
  return { ...c, sent };
}

export function createServer(opts: ServeOptions = {}) {
  const store = new Store(opts.db ?? ":memory:");
  const key = opts.apiKey ?? process.env.DECIDUS_API_KEY;
  const warmup = opts.warmup ?? Number(process.env.DECIDUS_WARMUP ?? 20);
  const sample = opts.sample ?? Number(process.env.DECIDUS_SAMPLE_RATE ?? 0.1);
  const queueSize = opts.queueSize ?? Number(process.env.DECIDUS_QUEUE_SIZE ?? 50);
  const retention = opts.retentionDays ?? Number(process.env.DECIDUS_RETENTION_DAYS ?? 30);
  const ui = new URL("../ui/index.html", import.meta.url);
  let cached: { at: number; body: unknown } | null = null;       // the overview counts every call; once per 5s is plenty
  if (retention > 0) {
    const n = store.prune(retention);
    if (n && !opts.quiet) console.log(`retention: removed the input and output of ${n} undecided calls older than ${retention} days (DECIDUS_RETENTION_DAYS)`);
    setInterval(() => store.prune(retention), 3_600_000).unref();
  }

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(ui));
      }
      if (req.method === "GET" && path === "/healthz") return send(200, { ok: true });
      if (key && (path.startsWith("/v1/") || path.startsWith("/api/")) && req.headers.authorization !== `Bearer ${key}`)
        return send(401, { error: "missing or wrong API key" });

      let body: any = null;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const ch of req) chunks.push(ch as Buffer);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      }
      const m = (re: RegExp) => path.match(re);
      let r: RegExpMatchArray | null;
      const scope = normScope(body?.scope ?? url.searchParams.get("scope"));

      // ---- interceptor ----
      if (req.method === "GET" && path === "/v1/policies") return send(200, store.live());
      if (req.method === "POST" && path === "/v1/records") return send(202, { cases: ingest(store, body, warmup, sample) });

      // ---- UI ----
      if (req.method === "GET" && path === "/api/overview") {
        if (!cached || Date.now() - cached.at > 5000) cached = { at: Date.now(), body: overview(store) };
        return send(200, cached.body);
      }
      if (req.method === "GET" && (r = m(/^\/api\/policies\/([^/]+)$/))) {
        const d = detail(store, decodeURIComponent(r[1]), scope, queueSize);
        return d ? send(200, d) : send(404, { error: "no such policy" });
      }
      if (req.method === "GET" && (r = m(/^\/api\/policies\/([^/]+)\/calls$/))) {
        const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get("limit"))) || 100));
        const rows = store.calls(decodeURIComponent(r[1]), scope, parseFilter(url.searchParams.get("q") ?? ""),
          Number(url.searchParams.get("before")) || null, limit) as any[];
        return send(200, { calls: rows, next: rows.length === limit ? rows.at(-1).id : null });
      }
      if (req.method === "GET" && (r = m(/^\/api\/cases\/(\d+)$/))) {
        const c = caseView(store, Number(r[1]));
        return c ? send(200, c) : send(404, { error: "no such case" });
      }
      if (req.method === "POST" && (r = m(/^\/api\/cases\/(\d+)\/decide$/))) {
        store.decide(Number(r[1]), body.value ?? null);
        return send(200, { ok: true });
      }
      if (req.method === "POST" && (r = m(/^\/api\/policies\/([^/]+)\/(suggest|edit|replay|tune|accept|discard|live)$/))) {
        const name = decodeURIComponent(r[1]);
        if (!store.policy(name)) return send(404, { error: "no such policy" });
        switch (r[2]) {
          case "suggest": return send(200, await suggest(store, name, scope, { cases: body.cases, all: !!body.all }));
          case "edit": return send(200, edit(store, name, scope, body.text ?? {}));
          case "replay": return send(200, await replay(store, name, scope, body.target ?? "suggestion"));
          case "tune": return send(200, await tune(store, name, scope));
          case "accept": return send(200, { live: accept(store, name, scope) });
          case "discard": store.setSuggestion(name, scope, null); return send(200, { ok: true });
          case "live": {
            if (body.version == null) {
              if (!scope) return send(400, { error: "the global policy always has a live version" });
              store.setLive(name, scope, null);
              return send(200, { live: null, effective: store.effective(name, scope) });
            }
            const n = Number(body.version), v = store.version(name, n);
            if (!v) return send(404, { error: "no such version" });
            if (!prefixes(scope).includes(v.scope)) return send(400, { error: `v${n} belongs to ${v.scope}, not to ${scope || "global"} or above it` });
            store.setLive(name, scope, n);
            return send(200, { live: n });
          }
        }
      }
      send(404, { error: "not found" });
    } catch (e: any) {
      if (!opts.quiet) console.error(e);
      send(500, { error: e?.message ?? String(e) });
    }
  });
  return { server, store };
}
