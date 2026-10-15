import { DatabaseSync } from "node:sqlite";
import { prefixes, type Doc, type Spec, type LivePolicy, type LiveSet } from "./shapes.js";

/** The next version, being written and tried. Edits are against the code's text (see clauses.ts). */
export interface Draft {
  base: number;                          // the version it was written on top of
  ops: Doc;
  keys: Record<string, string[]>;        // per part, the editable clauses of the code's text it was written against
  because: Record<string, number[]>;     // per part, the cases behind its wording
  added: number[];                       // decided cases it learned from that no version used yet
  cases: number[];                       // every case the writer saw
  notes?: string;
  replay: ReplayResult[] | null;
  tune: LogEntry[];
  created_at: string;
  /** How it came about: written from decided cases, auto-tuned, edited by hand. */
  origin?: Origin;
}
export type Origin = "generated" | "tuned" | "hand" | "rebased";
/**
 * A version tried on live traffic next to the live one: shadow (re-run on the side on pct% of calls, its
 * answer only compared) or canary (served to pct% of conversations). A scope can try several at once.
 */
export interface Candidate { n: number; mode: "shadow" | "canary"; pct: number; since: string; /** canary: where its slice of conversation buckets starts */ at?: number }
export interface LogEntry { round: number; pass: number | null; n: number | null; note: string }
export interface ReplayResult { id: number; human: string; model: string | null; pass: boolean; error?: string }

export interface PolicyRow {
  name: string; route: Spec["route"]; kind: Spec["kind"]; options: string[]; field: string | null;   // field: path in the schema
  instructions: string | null; code_text: string | null; model: string | null; created_at: string;
}
/**
 * A scope's pointer into the policy's versions (live = null: the scope runs its parent's version),
 * its draft, the versions being tried, and the clauses people locked (per part, normalized clause text).
 */
export interface VariantRow { policy: string; scope: string; live: number | null; draft: Draft | null; candidates: Candidate[]; locks: Record<string, string[]> }
export interface VersionRow {
  policy: string; n: number; scope: string; base: number | null; ops: Doc; keys: Record<string, string[]>; because: Record<string, number[]>;
  cases: number[]; replay: ReplayResult[] | null; log: { notes?: string; tune: LogEntry[]; rebased?: number; origin?: Origin } | null; created_at: string;
  /** Written by decidus 0.3 as option descriptions; it no longer changes calls. */
  legacy?: boolean;
}
export interface CaseRow {
  id: number; policy: string; scope: string; version: number; model: string | null;
  answer: string | null; confidence: number | null; escalated: boolean; decision: string | null;
  decided_at: string | null; used_in: number | null; status: number; ms: number; created_at: string;
  trace_id: string | null; conversation_id: string | null; event_id: string | null; headline: string; metadata: Record<string, unknown>;
  /** The decision's own key in the request (see Spec.key), and the options this call had. */
  spec: string | null; options: string[] | null;
  /** Edits of the version it ran that no longer applied: the code had changed the clause they edit. */
  retired: number;
  /** Shadow: the candidate version this call was re-run with, and its answer. */
  shadow_version: number | null; shadow_answer: string | null;
  // bodies; null once pruned
  url: string; headers: Record<string, string>; request: any; response: any;
}
export type NewCase = Omit<CaseRow, "id" | "decision" | "decided_at" | "used_in" | "created_at" | "shadow_version" | "shadow_answer">;
export interface CallFilter {
  answer?: string; version?: number; decided?: "yes" | "no"; queued?: boolean; maxConf?: number; minConf?: number; text?: string;
  /** Calls where a shadow answered differently from the live version (of that version, if a number). */
  differs?: number | true;
}

const now = () => new Date().toISOString();
const j = (s: unknown) => (s == null ? null : JSON.parse(String(s)));
/** Rows in lists: everything but the bodies. */
const LIGHT = "id, scope, version, model, answer, confidence, escalated, decision, decided_at, used_in, status, ms, created_at, trace_id, conversation_id, event_id, headline, retired, shadow_version, shadow_answer";
/** " and <cases in scope S or under it>", as an index range; S = "" is everything. */
function inScope(s: string): [string, string[]] {
  // one index range [s, s + "0"), "0" sorting right after "/", then drop look-alikes such as "acme-eu" for "acme"
  return s ? [" and scope >= ? and scope < ? and (scope = ? or substr(scope, 1, ?) = ?)", [s, s + "0", s, String(s.length + 1), s + "/"]] : ["", []];
}
/** The review list is drawn from this many of the newest waiting calls. */
const POOL = 5000;
/** Newest rows read before falling back to the scope index (see `newest`). */
const SCAN = 20000;

const SCHEMA = `
  create table if not exists policies (
    name text primary key, route text, kind text, options text, field text, instructions text,
    code_text text, model text, created_at text);
  create table if not exists variants (
    policy text, scope text, live integer, suggestion text, primary key (policy, scope));   -- suggestion: the draft
  create table if not exists versions (
    policy text, n integer, scope text not null default '', base integer, text text, because text, cases text,
    replay text, log text, created_at text, primary key (policy, n));
  create table if not exists cases (
    id integer primary key autoincrement, policy text, scope text not null default '', version integer, model text,
    answer text, confidence real, escalated integer, decision text, decided_at text, used_in integer,
    status integer, ms integer, created_at text, trace_id text, conversation_id text, event_id text, headline text, metadata text,
    spec text, options text);
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
  /** Calls a scope needs before decidus tells static text from dynamic and may tune it. */
  observe = 20;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    const old = (this.db.prepare("pragma table_info(cases)").all() as any[]).some(c => c.name === "request");
    if (old) this.migrate01();
    this.db.exec(SCHEMA);
    const add = (table: string, cols: Record<string, string>) => {                                   // 0.2, 0.4
      const has = new Set((this.db.prepare(`pragma table_info(${table})`).all() as any[]).map(c => c.name));
      for (const [c, type] of Object.entries(cols)) if (!has.has(c)) this.db.exec(`alter table ${table} add column ${c} ${type}`);
    };
    add("cases", { spec: "text", options: "text", retired: "integer not null default 0", shadow_version: "integer", shadow_answer: "text" });
    add("versions", { doc: "text" });
    add("variants", { candidate: "text", locks: "text" });
    this.db.exec("create index if not exists cases_shadow on cases (policy, shadow_version) where shadow_version is not null");
  }

  /** 0.1 kept bodies in `cases` and one live pointer per policy. */
  private migrate01() {
    this.db.exec(`begin;
      alter table policies rename to policies_01; alter table versions rename to versions_01; alter table cases rename to cases_01;
      ${SCHEMA}
      insert into policies select name, route, kind, options, field, instructions, code_text, model, created_at from policies_01;
      insert into variants select name, '', live, suggestion from policies_01;
      insert into versions select policy, n, '', case when n > 0 then n - 1 end, text, because, cases, replay, null, created_at from versions_01;
      insert into cases (id, policy, scope, version, model, answer, confidence, escalated, decision, decided_at, used_in,
        status, ms, created_at, trace_id, conversation_id, event_id, headline, metadata)
        select id, policy, '', version, model, answer, confidence, escalated, decision, decided_at, used_in,
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
      .run(s.name, s.route, s.kind, JSON.stringify(s.options), s.path ?? null, s.instructions ?? null, null, model, now());
    if (!this.version(s.name, 0)) {
      this.addVersion({ policy: s.name, n: 0, scope: "", base: null, ops: {}, keys: {}, because: {}, cases: [], replay: null, log: null });
      this.setLive(s.name, "", 0);
    }
  }

  // ---------- variants: per-scope live pointer, draft, candidates, locks ----------
  private variantRow(r: any): VariantRow {
    const draft = j(r.suggestion), c = j(r.candidate);                       // 0.4 kept one candidate, as an object
    return { policy: r.policy, scope: r.scope, live: r.live, draft: draft?.ops ? draft : null, candidates: Array.isArray(c) ? c : c ? [c] : [], locks: j(r.locks) ?? {} };
  }
  variant(policy: string, scope: string): VariantRow {
    const r = this.db.prepare("select * from variants where policy = ? and scope = ?").get(policy, scope);
    return r ? this.variantRow(r) : { policy, scope, live: null, draft: null, candidates: [], locks: {} };
  }
  variants(policy: string): VariantRow[] {
    return this.db.prepare("select * from variants where policy = ? order by scope").all(policy).map(r => this.variantRow(r));
  }
  private putVariant(v: VariantRow) {
    this.liveCache = null;
    if (v.scope && v.live == null && !v.draft && !v.candidates.length && !Object.keys(v.locks).length) {
      this.db.prepare("delete from variants where policy = ? and scope = ?").run(v.policy, v.scope);
      return;
    }
    const js = (x: unknown) => (x ? JSON.stringify(x) : null);
    this.db.prepare(`insert into variants (policy, scope, live, suggestion, candidate, locks) values (?, ?, ?, ?, ?, ?)
      on conflict (policy, scope) do update set live = excluded.live, suggestion = excluded.suggestion, candidate = excluded.candidate, locks = excluded.locks`)
      .run(v.policy, v.scope, v.live, js(v.draft), v.candidates.length ? JSON.stringify(v.candidates) : null, Object.keys(v.locks).length ? JSON.stringify(v.locks) : null);
  }
  setDraft(policy: string, scope: string, d: Draft | null) { this.putVariant({ ...this.variant(policy, scope), draft: d }); }
  /** Kept in version order, so a conversation's canary bucket maps to the same version on every client. */
  setCandidates(policy: string, scope: string, list: Candidate[]) {
    this.putVariant({ ...this.variant(policy, scope), candidates: [...list].sort((a, b) => a.n - b.n || a.mode.localeCompare(b.mode)) });
  }
  setLocks(policy: string, scope: string, locks: Record<string, string[]>) { this.putVariant({ ...this.variant(policy, scope), locks }); }
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
  /**
   * The versions being tried on calls in `scope`, and the scope they were set for: the nearest scope up the
   * path that tries any, unless a narrower scope on the way runs its own version.
   */
  candidatesFor(policy: string, scope: string): (Candidate & { scope: string })[] {
    const live = this.effective(policy, scope).n;
    for (const p of prefixes(scope)) {
      const v = this.variant(policy, p);
      if (v.candidates.length) return v.candidates.filter(c => c.n !== live).map(c => ({ ...c, scope: p }));
      if (v.live != null) return [];
    }
    return [];
  }
  /** Union of the clauses locked in `scope` and the scopes above it. */
  locks(policy: string, scope: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const p of prefixes(scope)) for (const [part, keys] of Object.entries(this.variant(policy, p).locks)) out[part] = [...new Set([...(out[part] ?? []), ...keys])];
    return out;
  }
  private liveCache: LiveSet | null = null;
  live(): LiveSet {
    if (this.liveCache) return this.liveCache;
    const out: LiveSet = { policies: {}, scopes: {} };
    for (const v of this.db.prepare("select * from variants").all().map(r => this.variantRow(r))) {
      // a scope with trials of its own answers with those, not its parent's (as candidatesFor reports)
      if (v.live == null && !v.candidates.length) continue;
      const n = v.live ?? this.effective(v.policy, v.scope).n;
      const canaries = v.candidates.filter(c => c.mode === "canary" && c.pct > 0 && c.n !== n);
      const lp: LivePolicy = { version: n, ops: this.version(v.policy, n)?.ops ?? {} };
      if (canaries.length) {
        lp.canaries = canaries.map(c => ({ version: c.n, ops: this.version(v.policy, c.n)?.ops ?? {}, pct: c.pct, ...(c.at != null ? { at: c.at } : {}) }));
        lp.canary = lp.canaries[0];                           // clients before 0.5 serve one
      }
      if (!v.scope) { if (n > 0 || canaries.length || v.candidates.length) out.policies[v.policy] = lp; }
      else (out.scopes![v.scope] ??= {})[v.policy] = lp;     // v0 too: a scope pinned to the code as written
    }
    return (this.liveCache = out);
  }

  // ---------- versions ----------
  private versionRow(r: any): VersionRow {
    const doc = j(r.doc);
    return { policy: r.policy, n: r.n, scope: r.scope, base: r.base, ops: doc?.ops ?? {}, keys: doc?.keys ?? {}, because: j(r.because) ?? {},
      cases: j(r.cases) ?? [], replay: j(r.replay), log: j(r.log), created_at: r.created_at, ...(!doc && r.n > 0 ? { legacy: true } : {}) };
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
  addVersion(v: Omit<VersionRow, "created_at" | "legacy">) {
    this.db.prepare("insert into versions (policy, n, scope, base, text, doc, because, cases, replay, log, created_at) values (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)")
      .run(v.policy, v.n, v.scope, v.base, JSON.stringify({ ops: v.ops, keys: v.keys }), JSON.stringify(v.because), JSON.stringify(v.cases),
        v.replay ? JSON.stringify(v.replay) : null, v.log ? JSON.stringify(v.log) : null, now());
  }
  setVersionReplay(policy: string, n: number, replay: ReplayResult[]) {
    this.db.prepare("update versions set replay = ? where policy = ? and n = ?").run(JSON.stringify(replay), policy, n);
  }

  // ---------- cases ----------
  private caseRow(r: any): CaseRow {
    return { ...r, metadata: j(r.metadata) ?? {}, headers: j(r.headers) ?? {}, request: j(r.request), response: j(r.response), escalated: !!r.escalated,
      options: j(r.options) };
  }
  addCase(c: NewCase): number {
    const r = this.db.prepare(`insert into cases (policy, scope, version, model, answer, confidence, escalated, status, ms, created_at,
      trace_id, conversation_id, event_id, headline, metadata, spec, options, retired) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.policy, c.scope, c.version, c.model, c.answer, c.confidence, c.escalated ? 1 : 0, c.status, c.ms, now(),
        c.trace_id, c.conversation_id, c.event_id, c.headline, JSON.stringify(c.metadata), c.spec, c.options ? JSON.stringify(c.options) : null, c.retired);
    const id = Number(r.lastInsertRowid);
    this.seenScopes.get(c.policy)?.add(c.scope);
    this.stamps.set(c.policy, id);
    this.db.prepare("insert into bodies (id, url, headers, request, response) values (?, ?, ?, ?, ?)")
      .run(id, c.url, JSON.stringify(c.headers), JSON.stringify(c.request), JSON.stringify(c.response));
    return id;
  }
  case(id: number): CaseRow | null {
    const r = this.db.prepare("select c.*, b.url, b.headers, b.request, b.response from cases c left join bodies b on b.id = c.id where c.id = ?").get(id);
    return r ? this.caseRow(r) : null;
  }
  cases(ids: number[]): CaseRow[] { return ids.map(id => this.case(id)).filter((c): c is CaseRow => !!c); }
  private stamps = new Map<string, number>();
  /** The newest case id of a policy: changes whenever a call arrives. */
  stamp(policy: string): number {
    if (!this.stamps.has(policy)) this.stamps.set(policy, (this.db.prepare("select max(id) as n from cases where policy = ?").get(policy) as any).n ?? 0);
    return this.stamps.get(policy)!;
  }
  /** The newest calls in a scope that still have their bodies: what the code sends now. */
  samples(policy: string, scope: string, n: number): { id: number; spec: string | null; url: string; request: any }[] {
    const ids = this.newest("policy = ?", [policy], scope, n * 2, "cases_recent").map(r => r.id);
    if (!ids.length) return [];
    return (this.db.prepare(`select c.id, c.spec, b.url, b.request from cases c join bodies b on b.id = c.id where c.id in (${ids.map(() => "?").join(",")})
      and b.request is not null order by c.id desc limit ?`).all(...ids, n) as any[]).map(r => ({ ...r, request: j(r.request) }));
  }
  /** Decided cases in a scope, newest first, with bodies: what a version is replayed against. */
  decidedCases(policy: string, scope: string, limit: number): CaseRow[] {
    const [w, a] = inScope(scope);
    const ids = (this.db.prepare(`select id from cases where policy = ? and decision is not null${w} order by id desc limit ?`).all(policy, ...a, limit) as any[]).map(r => r.id);
    return this.cases(ids);
  }
  setShadow(id: number, version: number, answer: string | null, escalate: boolean) {
    this.db.prepare(`update cases set shadow_version = ?, shadow_answer = ?, escalated = case when ? and decision is null then 1 else escalated end where id = ?`)
      .run(version, answer, escalate ? 1 : 0, id);
  }

  /** Reviewable calls seen so far in exactly this scope, up to `cap` (enough to know if warm-up is over). */
  eligibleCount(policy: string, scope: string, cap: number): number {
    return (this.db.prepare("select count(*) as n from (select 1 from cases where policy = ? and scope = ? and escalated = 1 limit ?)").get(policy, scope, cap) as any).n;
  }

  /**
   * To review: calls waiting for a decision, the ones the model was least sure of first. Calls a shadow
   * answered differently come first; then the model's own doubt (a yes/no probability closest to a coin
   * flip, else the lowest confidence in the answer it gave); for calls without one, how often people correct
   * that answer; then the newest.
   */
  review(policy: string, scope: string, limit: number, f?: CallFilter) {
    const pool = f && Object.keys(f).length ? this.calls(policy, scope, { ...f, queued: true }, null, POOL)
      : this.newest("policy = ? and escalated = 1 and decision is null", [policy], scope, POOL, "cases_wait");
    const [w, a] = inScope(scope);
    const rate = new Map<string | null, number>();
    for (const r of this.db.prepare(`select answer, count(*) as n, sum(decision is not answer) as wrong from cases
        where policy = ? and decision is not null${w} group by answer`).all(policy, ...a) as any[]) rate.set(r.answer, ((r.wrong ?? 0) + 1) / (r.n + 2));
    const yesNo = this.policy(policy)?.kind === "bool";
    const doubt = (c: any) => c.confidence == null ? rate.get(c.answer) ?? 0.5 : yesNo ? 1 - Math.abs(2 * c.confidence - 1) : 1 - c.confidence;
    const differs = (c: any) => (c.shadow_version != null && c.shadow_answer !== c.answer ? 1 : 0);
    return pool.map(c => ({ c, d: differs(c), u: doubt(c) }))
      .sort((x, y) => y.d - x.d || y.u - x.u || y.c.id - x.c.id).slice(0, limit).map(x => x.c);
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
    if (f.differs === true) where.push("shadow_version is not null and shadow_answer is not answer");
    else if (f.differs != null) { where.push("shadow_version = ? and shadow_answer is not answer"); args.push(f.differs); }
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
  /**
   * Live version vs candidate since the candidate started: answer distribution, how often reviewers
   * agreed with each, and for shadow, how often the two disagreed on the same call.
   */
  compare(policy: string, scope: string, live: number, c: Candidate) {
    const [w, a] = inScope(scope);
    const q = (sql: string, ...args: unknown[]) => this.db.prepare(sql).all(policy, c.since, ...(args as any[]), ...a) as any[];
    const dist = (rows: any[]) => Object.fromEntries(rows.map(r => [r.answer ?? "", r.n]));
    const base = "from cases where policy = ? and created_at >= ?";
    const liveDist = dist(q(`select answer, count(*) as n ${base} and version = ?${w} group by answer`, live));
    const candDist = c.mode === "canary"
      ? dist(q(`select answer, count(*) as n ${base} and version = ?${w} group by answer`, c.n))
      : dist(q(`select shadow_answer as answer, count(*) as n ${base} and shadow_version = ?${w} group by shadow_answer`, c.n));
    const agree = (sql: string, v: number) => { const r = q(sql, v)[0]; return { n: r?.n ?? 0, agree: r?.agree ?? 0 }; };
    const liveAgree = agree(`select count(*) as n, sum(decision = answer) as agree ${base} and version = ? and decision is not null${w}`, live);
    const candAgree = c.mode === "canary"
      ? agree(`select count(*) as n, sum(decision = answer) as agree ${base} and version = ? and decision is not null${w}`, c.n)
      : agree(`select count(*) as n, sum(decision = shadow_answer) as agree ${base} and shadow_version = ? and decision is not null${w}`, c.n);
    const paired = c.mode === "shadow" ? q(`select count(*) as n, sum(shadow_answer is not answer) as differ ${base} and shadow_version = ?${w}`, c.n)[0] : null;
    return { live: { n: live, answers: liveDist, reviewed: liveAgree }, candidate: { n: c.n, answers: candDist, reviewed: candAgree },
      paired: paired ? { n: paired.n ?? 0, differ: paired.differ ?? 0 } : null };
  }
  /** Of the newest calls that ran version n in a scope: how many had edits that no longer applied, and the newest such call. */
  retiredOn(policy: string, scope: string, n: number, last = 100): { calls: number; of: number; latest: number | null; newest: number | null } {
    const [w, a] = inScope(scope);
    const rows = this.db.prepare(`select id, retired from cases where policy = ? and version = ?${w} order by id desc limit ?`).all(policy, n, ...a, last) as any[];
    return { calls: rows.filter(r => r.retired > 0).length, of: rows.length, latest: rows.find(r => r.retired > 0)?.id ?? null, newest: rows[0]?.id ?? null };
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
