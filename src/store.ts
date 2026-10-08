import { DatabaseSync } from "node:sqlite";
import { prefixes, type PolicyText, type Spec, type LivePolicy, type LiveSet } from "./shapes.js";

export interface Suggestion {
  base: number;
  text: PolicyText;
  because: Record<string, number[]>;
  added: number[];
  cases: number[];
  notes?: string;
  replay: ReplayResult[] | null;
  tune: LogEntry[];
  created_at: string;
}
export interface LogEntry { round: number; pass: number | null; n: number | null; note: string }
export interface ReplayResult { id: number; human: string; model: string | null; pass: boolean; error?: string }

export interface PolicyRow {
  name: string; route: Spec["route"]; kind: Spec["kind"]; options: string[]; field: string | null;
  instructions: string | null; code_text: string | null; model: string | null; created_at: string;
}
/** A scope's pointer into the policy's versions. live = null: the scope runs its parent's version. */
export interface VariantRow { policy: string; scope: string; live: number | null; suggestion: Suggestion | null }
export interface VersionRow {
  policy: string; n: number; scope: string; base: number | null; text: PolicyText; because: Record<string, number[]>;
  cases: number[]; replay: ReplayResult[] | null; log: { notes?: string; tune: LogEntry[] } | null; created_at: string;
}
export interface CaseRow {
  id: number; policy: string; scope: string; version: number; model: string | null;
  answer: string | null; confidence: number | null; escalated: boolean; decision: string | null;
  decided_at: string | null; used_in: number | null; status: number; ms: number; created_at: string;
  trace_id: string | null; conversation_id: string | null; event_id: string | null; headline: string; metadata: Record<string, unknown>;
  // bodies; null once pruned
  url: string; headers: Record<string, string>; request: any; response: any;
}
export type NewCase = Omit<CaseRow, "id" | "decision" | "decided_at" | "used_in" | "created_at">;
export interface CallFilter { answer?: string; version?: number; decided?: "yes" | "no"; queued?: boolean; maxConf?: number; minConf?: number; text?: string }

const now = () => new Date().toISOString();
const j = (s: unknown) => (s == null ? null : JSON.parse(String(s)));
/** Rows in lists: everything but the bodies. */
const LIGHT = "id, scope, version, model, answer, confidence, escalated, decision, decided_at, used_in, status, ms, created_at, trace_id, conversation_id, event_id, headline";
/** " and <cases in scope S or under it>", as an index range; S = "" is everything. */
function inScope(s: string): [string, string[]] {
  // one index range [s, s + "0"), "0" sorting right after "/", then drop look-alikes such as "acme-eu" for "acme"
  return s ? [" and scope >= ? and scope < ? and (scope = ? or substr(scope, 1, ?) = ?)", [s, s + "0", s, String(s.length + 1), s + "/"]] : ["", []];
}
/** The queue window is drawn from this many of the newest waiting calls. */
const POOL = 5000;
/** Newest rows read before falling back to the scope index (see `newest`). */
const SCAN = 20000;
const band = (c: number | null) => c == null ? -1 : c < 0.5 ? 0 : c < 0.65 ? 1 : c < 0.8 ? 2 : 3;

const SCHEMA = `
  create table if not exists policies (
    name text primary key, route text, kind text, options text, field text, instructions text,
    code_text text, model text, created_at text);
  create table if not exists variants (
    policy text, scope text, live integer, suggestion text, primary key (policy, scope));
  create table if not exists versions (
    policy text, n integer, scope text not null default '', base integer, text text, because text, cases text,
    replay text, log text, created_at text, primary key (policy, n));
  create table if not exists cases (
    id integer primary key autoincrement, policy text, scope text not null default '', version integer, model text,
    answer text, confidence real, escalated integer, decision text, decided_at text, used_in integer,
    status integer, ms integer, created_at text, trace_id text, conversation_id text, event_id text, headline text, metadata text);
  drop index if exists cases_review;
  create index if not exists cases_wait on cases (policy, escalated, decision);
  create index if not exists cases_decided on cases (policy, used_in, scope, version, decision, answer) where decision is not null;
  drop index if exists cases_scope;
  create index if not exists cases_scoped on cases (policy, scope, escalated, decision);
  create index if not exists cases_recent on cases (policy, id);
  create index if not exists cases_time on cases (policy, created_at);
  create index if not exists cases_trace on cases (policy, trace_id);
  create index if not exists cases_conversation on cases (policy, conversation_id);
  create index if not exists cases_event on cases (policy, event_id);
  create table if not exists bodies (id integer primary key, url text, headers text, request text, response text);
`;

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    const old = (this.db.prepare("pragma table_info(cases)").all() as any[]).some(c => c.name === "request");
    if (old) this.migrate01();
    this.db.exec(SCHEMA);
  }

  /** 0.1 kept bodies in `cases` and one live pointer per policy. */
  private migrate01() {
    this.db.exec(`begin;
      alter table policies rename to policies_01; alter table versions rename to versions_01; alter table cases rename to cases_01;
      ${SCHEMA}
      insert into policies select name, route, kind, options, field, instructions, code_text, model, created_at from policies_01;
      insert into variants select name, '', live, suggestion from policies_01;
      insert into versions select policy, n, '', case when n > 0 then n - 1 end, text, because, cases, replay, null, created_at from versions_01;
      insert into cases select id, policy, '', version, model, answer, confidence, escalated, decision, decided_at, used_in,
        status, ms, created_at, trace_id, null, null, headline, metadata from cases_01;
      insert into bodies select id, url, headers, request, response from cases_01;
      drop table policies_01; drop table versions_01; drop table cases_01;
      commit;`);
  }

  // ---------- policies ----------
  private policyRow(r: any): PolicyRow { return { ...r, options: j(r.options) }; }
  policy(name: string): PolicyRow | null {
    const r = this.db.prepare("select * from policies where name = ?").get(name);
    return r ? this.policyRow(r) : null;
  }
  policies(): PolicyRow[] {
    return this.db.prepare("select * from policies order by created_at").all().map(r => this.policyRow(r));
  }
  /** First sight creates the policy at v0; later sightings keep its shape current with the code. */
  seen(s: Spec, model: string | null) {
    this.db.prepare(`insert into policies (name, route, kind, options, field, instructions, code_text, model, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (name) do update set route = excluded.route, kind = excluded.kind, options = excluded.options,
      field = excluded.field, instructions = excluded.instructions, code_text = excluded.code_text, model = coalesce(excluded.model, model)`)
      .run(s.name, s.route, s.kind, JSON.stringify(s.options), s.field ?? null, s.instructions ?? null, s.codeText ?? null, model, now());
    if (!this.version(s.name, 0)) {
      this.addVersion({ policy: s.name, n: 0, scope: "", base: null, text: {}, because: {}, cases: [], replay: null, log: null });
      this.setLive(s.name, "", 0);
    }
  }

  // ---------- variants: per-scope live pointer + open suggestion ----------
  private variantRow(r: any): VariantRow { return { ...r, suggestion: j(r.suggestion) }; }
  variant(policy: string, scope: string): VariantRow {
    const r = this.db.prepare("select * from variants where policy = ? and scope = ?").get(policy, scope);
    return r ? this.variantRow(r) : { policy, scope, live: null, suggestion: null };
  }
  variants(policy: string): VariantRow[] {
    return this.db.prepare("select * from variants where policy = ? order by scope").all(policy).map(r => this.variantRow(r));
  }
  private putVariant(v: VariantRow) {
    if (v.scope && v.live == null && !v.suggestion) {
      this.db.prepare("delete from variants where policy = ? and scope = ?").run(v.policy, v.scope);
      return;
    }
    this.db.prepare(`insert into variants (policy, scope, live, suggestion) values (?, ?, ?, ?)
      on conflict (policy, scope) do update set live = excluded.live, suggestion = excluded.suggestion`)
      .run(v.policy, v.scope, v.live, v.suggestion ? JSON.stringify(v.suggestion) : null);
  }
  setSuggestion(policy: string, scope: string, s: Suggestion | null) { this.putVariant({ ...this.variant(policy, scope), suggestion: s }); }
  /** n = null: the scope goes back to running its parent's version. */
  setLive(policy: string, scope: string, n: number | null) { this.putVariant({ ...this.variant(policy, scope), live: scope ? n : (n ?? 0) }); }
  /** The version a call in `scope` runs, and which scope set it. */
  effective(policy: string, scope: string): { n: number; from: string } {
    for (const p of prefixes(scope)) {
      const v = this.variant(policy, p);
      if (v.live != null) return { n: v.live, from: p };
    }
    return { n: 0, from: "" };
  }
  live(): LiveSet {
    const out: LiveSet = { policies: {}, scopes: {} };
    const rows = this.db.prepare(`select a.policy, a.scope, a.live, v.text from variants a
      join versions v on v.policy = a.policy and v.n = a.live where a.live is not null`).all() as any[];
    for (const r of rows) {
      const lp: LivePolicy = { version: r.live, text: j(r.text) };
      if (!r.scope) { if (r.live > 0) out.policies[r.policy] = lp; }
      else (out.scopes![r.scope] ??= {})[r.policy] = lp;     // v0 too: a scope pinned to the code as written
    }
    return out;
  }

  // ---------- versions ----------
  private versionRow(r: any): VersionRow {
    return { ...r, text: j(r.text), because: j(r.because), cases: j(r.cases), replay: j(r.replay), log: j(r.log) };
  }
  versions(policy: string): VersionRow[] {
    return this.db.prepare("select * from versions where policy = ? order by n").all(policy).map(r => this.versionRow(r));
  }
  version(policy: string, n: number): VersionRow | null {
    const r = this.db.prepare("select * from versions where policy = ? and n = ?").get(policy, n);
    return r ? this.versionRow(r) : null;
  }
  nextVersion(policy: string): number {
    return ((this.db.prepare("select max(n) as n from versions where policy = ?").get(policy) as any).n ?? -1) + 1;
  }
  addVersion(v: Omit<VersionRow, "created_at">) {
    this.db.prepare("insert into versions (policy, n, scope, base, text, because, cases, replay, log, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.policy, v.n, v.scope, v.base, JSON.stringify(v.text), JSON.stringify(v.because), JSON.stringify(v.cases),
        v.replay ? JSON.stringify(v.replay) : null, v.log ? JSON.stringify(v.log) : null, now());
  }
  setVersionReplay(policy: string, n: number, replay: ReplayResult[]) {
    this.db.prepare("update versions set replay = ? where policy = ? and n = ?").run(JSON.stringify(replay), policy, n);
  }

  // ---------- cases ----------
  private caseRow(r: any): CaseRow {
    return { ...r, metadata: j(r.metadata) ?? {}, headers: j(r.headers) ?? {}, request: j(r.request), response: j(r.response), escalated: !!r.escalated };
  }
  addCase(c: NewCase): number {
    const r = this.db.prepare(`insert into cases (policy, scope, version, model, answer, confidence, escalated, status, ms, created_at,
      trace_id, conversation_id, event_id, headline, metadata) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.policy, c.scope, c.version, c.model, c.answer, c.confidence, c.escalated ? 1 : 0, c.status, c.ms, now(),
        c.trace_id, c.conversation_id, c.event_id, c.headline, JSON.stringify(c.metadata));
    const id = Number(r.lastInsertRowid);
    this.seenScopes.get(c.policy)?.add(c.scope);
    this.db.prepare("insert into bodies (id, url, headers, request, response) values (?, ?, ?, ?, ?)")
      .run(id, c.url, JSON.stringify(c.headers), JSON.stringify(c.request), JSON.stringify(c.response));
    return id;
  }
  case(id: number): CaseRow | null {
    const r = this.db.prepare("select c.*, b.url, b.headers, b.request, b.response from cases c left join bodies b on b.id = c.id where c.id = ?").get(id);
    return r ? this.caseRow(r) : null;
  }
  cases(ids: number[]): CaseRow[] { return ids.map(id => this.case(id)).filter((c): c is CaseRow => !!c); }

  /** Reviewable calls seen so far in exactly this scope, up to `cap` (enough to know if warm-up is over). */
  eligibleCount(policy: string, scope: string, cap: number): number {
    return (this.db.prepare("select count(*) as n from (select 1 from cases where policy = ? and scope = ? and escalated = 1 limit ?)").get(policy, scope, cap) as any).n;
  }

  /**
   * The queue: a window over everything waiting for review, picked round-robin across
   * scope x version x answer x confidence band, newest first in each, newer versions first.
   * A million waiting calls still show as a representative 50.
   */
  queue(policy: string, scope: string, limit: number) {
    const pool = this.newest("policy = ? and escalated = 1 and decision is null", [policy], scope, POOL, "cases_wait");
    const seen = new Map<string, number>();
    return pool.map(c => {                                   // pool is newest first, so rank 1 is the newest of its kind
      const k = `${c.scope}|${c.version}|${c.answer}|${band(c.confidence)}`, rank = (seen.get(k) ?? 0) + 1;
      seen.set(k, rank);
      return { c, rank };
    }).sort((x, y) => x.rank - y.rank || y.c.version - x.c.version || y.c.id - x.c.id).slice(0, limit).map(x => x.c);
  }
  /**
   * Newest matching rows in a scope. Reading the policy's newest SCAN rows finds them fast when the scope
   * is a big share of traffic; when it isn't, that's exactly when the scope index is cheap.
   */
  private newest(where: string, args: unknown[], scope: string, want: number, index: string): any[] {
    if (!scope) return this.db.prepare(`select ${LIGHT} from cases indexed by ${index} where ${where} order by id desc limit ?`).all(...(args as any[]), want);
    const [w, a] = inScope(scope);
    const fast = this.db.prepare(`select * from (select ${LIGHT} from cases indexed by ${index} where ${where} order by id desc limit ${SCAN}) where 1${w} limit ?`)
      .all(...(args as any[]), ...a, want);
    if (fast.length >= want) return fast;
    return this.db.prepare(`select ${LIGHT} from cases indexed by cases_scoped where ${where}${w} order by id desc limit ?`).all(...(args as any[]), ...a, want);
  }
  /** Decided cases not yet in a version, disagreements with the model first. */
  unprocessed(policy: string, scope: string, limit: number) {
    const [w, a] = inScope(scope);
    return this.db.prepare(`select ${LIGHT} from cases where policy = ? and used_in is null and decision is not null${w}
      order by (decision is not answer) desc, id desc limit ?`).all(policy, ...a, limit) as any[];
  }
  processed(policy: string, scope: string, limit: number) {
    const [w, a] = inScope(scope);
    return this.db.prepare(`select ${LIGHT} from cases where policy = ? and used_in is not null and decision is not null${w} order by used_in desc, id desc limit ?`)
      .all(policy, ...a, limit);
  }
  tally(policy: string, scope: string) {
    const [w, a] = inScope(scope);
    const n = (where: string) => (this.db.prepare(`select count(*) as n from cases where policy = ?${where}${w}`).get(policy, ...a) as any).n as number;
    return {
      calls: n(""),
      queue: n(" and escalated = 1 and decision is null"),
      unprocessed: n(" and used_in is null and decision is not null"),
      processed: n(" and used_in is not null and decision is not null"),
    };
  }
  /** Every call, newest first, with filters; page with `before` = the last id you got. */
  calls(policy: string, scope: string, f: CallFilter, before: number | null, limit: number): any[] {
    const where = ["policy = ?"], args: any[] = [policy];
    if (before) { where.push("id < ?"); args.push(before); }
    if (f.answer != null) { where.push("answer = ?"); args.push(f.answer); }
    if (f.version != null) { where.push("version = ?"); args.push(f.version); }
    if (f.decided === "yes") where.push("decision is not null");
    if (f.decided === "no") where.push("decision is null");
    if (f.queued) where.push("escalated = 1 and decision is null");
    if (f.maxConf != null) { where.push("confidence < ?"); args.push(f.maxConf); }
    if (f.minConf != null) { where.push("confidence >= ?"); args.push(f.minConf); }
    if (f.text && !/\s/.test(f.text)) {                      // one of your ids, through their indexes
      const [w, a] = inScope(scope);
      const hit = this.db.prepare(`select ${LIGHT} from cases where ${where.join(" and ")} and (trace_id = ? or conversation_id = ? or event_id = ?)${w}
        order by id desc limit ?`).all(...args, f.text, f.text, f.text, ...a, limit);
      if (hit.length) return hit;
    }
    if (f.text) { where.push("instr(lower(headline), lower(?)) > 0"); args.push(f.text); }
    return this.newest(where.join(" and "), args, scope, limit, "cases_recent");
  }
  private seenScopes = new Map<string, Set<string>>();
  /** Every scope seen, with its parents: ["acme", "acme/bot", "zeta"]. */
  scopes(policy: string): string[] {
    let seen = this.seenScopes.get(policy);
    if (!seen) {
      seen = new Set((this.db.prepare("select distinct scope from cases where policy = ?").all(policy) as any[]).map(r => r.scope));
      this.seenScopes.set(policy, seen);
    }
    const s = new Set<string>();
    for (const sc of [...seen, ...this.variants(policy).map(v => v.scope)]) for (const p of prefixes(sc)) if (p) s.add(p);
    return [...s].sort();
  }
  /** How often people agreed with the model, per version it ran. */
  agreement(policy: string, scope: string): Record<number, { n: number; agree: number }> {
    const out: Record<number, { n: number; agree: number }> = {};
    const [w, a] = inScope(scope);
    for (const r of this.db.prepare(`select version, count(*) as n, sum(decision = answer) as agree from cases
        where policy = ? and decision is not null${w} group by version`).all(policy, ...a) as any[])
      out[r.version] = { n: r.n, agree: r.agree ?? 0 };
    return out;
  }
  /** Calls per day for the last `days` days, oldest first. */
  daily(policy: string, days: number): number[] {
    const start = Date.parse(new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10));
    const st = this.db.prepare("select count(*) as n from cases where policy = ? and created_at >= ? and created_at < ?");
    const day = (i: number) => new Date(start + i * 86_400_000).toISOString();
    return Array.from({ length: days }, (_, i) => (st.get(policy, day(i), day(i + 1)) as any).n);
  }
  decide(id: number, value: string | null) {
    this.db.prepare("update cases set decision = ?, decided_at = ? where id = ? and used_in is null").run(value, value == null ? null : now(), id);
  }
  /** Only cases still decided and not already in another version. */
  markUsed(ids: number[], n: number) {
    const st = this.db.prepare("update cases set used_in = ? where id = ? and used_in is null and decision is not null");
    for (const id of ids) st.run(n, id);
  }
  /**
   * Keep full bodies only where they're needed: decided cases keep theirs (replay uses them);
   * calls nobody decided within `days` keep their row but lose the bodies and leave the queue.
   */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let n = 0;
    for (const { name } of this.db.prepare("select name from policies").all() as any[]) {
      n += Number(this.db.prepare(`delete from bodies where id in (select id from cases where policy = ? and created_at < ? and decision is null)`).run(name, cutoff).changes);
      this.db.prepare("update cases set escalated = 0 where policy = ? and created_at < ? and decision is null and escalated = 1").run(name, cutoff);
    }
    return n;
  }
}
