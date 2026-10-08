// Scopes (company/bot policies with global fallback), hand edits, the three writer providers,
// the review queue at volume, call filters, retention and the 0.1 -> 0.2 database migration.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import OpenAI from "openai";
import * as decidus from "../dist/index.js";
import { createServer, ingest, parseFilter } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { writer } from "../dist/loop.js";
import { prefixes, normScope, resolve } from "../dist/shapes.js";

// ---------- mock provider: a "model" that only knows what the policy text tells it, plus writer endpoints ----------
const seen = [];
const KNOWS = [["charge", "billing"], ["crash", "technical"], ["damaged", "shipping"], ["parcel", "shipping"]];
const decide = (d = "", t = "") => { for (const [k, v] of KNOWS) if (d.includes(k) && t.includes(k)) return v; return "billing"; };
const WRITTEN = [{ option: "billing", text: "unexpected or duplicate charges", cases: [] }, { option: "technical", text: "app crash", cases: [] },
  { option: "shipping", text: "parcel late, lost or damaged", cases: [] }];

const provider = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  seen.push({ path: req.url, headers: req.headers, body });
  const json = o => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url.includes("/slow/")) await new Promise(r => setTimeout(r, 250));
  if (req.url.endsWith("/decisions")) return json({ answers: [{ type: "choice", name: body.questions[0].name, choice: "b", confidence: 0.9 }] });
  if (req.url.includes(":generateContent")) {
    return json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "write_policy", args: { options: WRITTEN, notes: "gemini wrote this" } } }] } }] });
  }
  if (req.url.endsWith("/chat/completions")) {
    const tool = body.tools[0].function;
    const args = tool.name === "write_policy" ? { options: WRITTEN, notes: "openai wrote this" }
      : { team: decide(tool.parameters.properties.team.description, JSON.stringify(body.messages)) };
    return json({ id: "c", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: tool.name, arguments: JSON.stringify(args) } }] } }] });
  }
  res.writeHead(404); res.end("{}");
});

let srv, base, mock, openai;
const api = async (path, body) => {
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const until = async (f, ms = 3000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise(r => setTimeout(r, 30)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOOL = { type: "function", function: { name: "route_conversation", description: "Which team should handle this conversation?",
  parameters: { type: "object", properties: { team: { type: "string", enum: ["billing", "technical", "shipping"] } }, required: ["team"] } } };
const route = content => openai.chat.completions.create({ model: "gpt-6-luna", messages: [{ role: "user", content }], tools: [TOOL],
  tool_choice: { type: "function", function: { name: "route_conversation" } } });
const lastSent = () => seen.filter(s => s.path.endsWith("/chat/completions") && s.body.tools[0].function.name === "route_conversation").at(-1).body.tools[0].function.parameters.properties.team.description ?? "";
const teamOf = r => JSON.parse(r.choices[0].message.tool_calls[0].function.arguments).team;

before(async () => {
  await new Promise(r => provider.listen(0, r));
  mock = `http://127.0.0.1:${provider.address().port}`;
  for (const k of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) delete process.env[k];
  Object.assign(process.env, { OPENAI_API_KEY: "sk-writer", OPENAI_BASE_URL: mock + "/v1", DECIDUS_SUGGEST_MODEL: "" });
  ({ server: srv } = createServer({ quiet: true, warmup: 1000 }));
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
  openai = new OpenAI({ apiKey: "sk-test", baseURL: mock + "/v1", fetch: decidus.fetch({ baseUrl: base, ttlMs: 0 }) });
});
after(() => { srv.close(); provider.close(); });

test("scope paths", () => {
  assert.equal(normScope(" /acme//support-bot/ "), "acme/support-bot");
  assert.deepEqual(prefixes("acme/support-bot"), ["acme/support-bot", "acme", ""]);
  const live = { policies: { p: { version: 1, text: { a: "g" } } }, scopes: { acme: { p: { version: 2, text: { a: "acme" } } }, "acme/b": { p: { version: 0, text: {} } } } };
  assert.equal(resolve(live, "acme/x").p.version, 2);
  assert.equal(resolve(live, "acme/b").p.version, 0, "a bot pinned to the code as written");
  assert.equal(resolve(live, "zeta").p.version, 1);
});

test("a company gets its own version; its bots inherit it; everyone else stays on global", async () => {
  await route("hello, first sight");
  await until(() => api("/api/policies/route_conversation").catch(() => null));

  // global v1, written by hand
  await api("/api/policies/route_conversation/edit", { text: { billing: "charges", technical: "crash", shipping: "parcel" } });
  assert.equal((await api("/api/policies/route_conversation/accept", {})).live, 1);

  // acme edits on top of what it runs (global v1) and accepts: v2 belongs to acme
  const s = await api("/api/policies/route_conversation/edit", { scope: "acme", text: { shipping: "parcel; damaged items" } });
  assert.equal(s.base, 1);
  assert.equal(s.text.billing, "charges", "untouched options carry over");
  assert.match(s.tune.at(-1).note, /Edited shipping by hand/);
  assert.equal((await api("/api/policies/route_conversation/accept", { scope: "acme" })).live, 2);

  const live = await api("/v1/policies");
  assert.equal(live.policies.route_conversation.version, 1);
  assert.equal(live.scopes.acme.route_conversation.version, 2);

  await route("warm-up"); await sleep(80);
  const acme = await decidus.trace({ scope: "acme/support-bot", conversationId: "conv_a1" }, () => route("the box arrived damaged"));
  assert.equal(teamOf(acme), "shipping");
  assert.match(lastSent(), /damaged items/);
  const zeta = await decidus.trace({ scope: "zeta/web" }, () => route("the box arrived damaged"));
  assert.equal(teamOf(zeta), "billing", "zeta runs global v1, which knows nothing about damage");
  assert.doesNotMatch(lastSent(), /damaged/);

  const calls = await until(async () => { const d = await api("/api/policies/route_conversation/calls?scope=acme"); return d.calls.length === 1 && d; });
  assert.equal(calls.calls[0].scope, "acme/support-bot");
  assert.equal(calls.calls[0].version, 2);
  assert.equal(calls.calls[0].conversation_id, "conv_a1");

  const bot = await api("/api/policies/route_conversation?scope=acme/support-bot");
  assert.deepEqual(bot.effective, { n: 2, from: "acme" });
  assert.deepEqual(bot.versions.map(v => [v.n, v.scope]), [[0, ""], [1, ""], [2, "acme"]]);
  assert.deepEqual((await api("/api/policies/route_conversation")).versions.map(v => v.n), [0, 1], "global shows only its own line");
  assert.deepEqual((await api("/api/policies/route_conversation")).scopes, ["acme", "acme/support-bot", "zeta", "zeta/web"]);

  // v2 is acme's; zeta can't run it. acme can go back to inheriting.
  await assert.rejects(api("/api/policies/route_conversation/live", { scope: "zeta", version: 2 }), /belongs to acme/);
  await api("/api/policies/route_conversation/live", { scope: "acme", version: null });
  assert.deepEqual((await api("/api/policies/route_conversation?scope=acme")).effective, { n: 1, from: "" });
  assert.equal((await api("/v1/policies")).scopes.acme, undefined);
  await api("/api/policies/route_conversation/live", { scope: "acme", version: 2 });
});

test("a scope's suggestion only learns from that scope; OpenAI writes it by default", async () => {
  await decidus.trace({ scope: "acme/support-bot" }, () => route("my charge is wrong"));
  await decidus.trace({ scope: "zeta/web" }, () => route("my parcel is late"));
  const calls = await until(async () => { const d = await api("/api/policies/route_conversation/calls?q=decided:no"); return d.calls.length >= 6 && d; });
  const acmeCase = calls.calls.find(c => c.scope === "acme/support-bot" && c.headline.includes("charge"));
  const zetaCase = calls.calls.find(c => c.scope === "zeta/web" && c.headline.includes("parcel"));
  await api(`/api/cases/${acmeCase.id}/decide`, { value: "billing" });
  await api(`/api/cases/${zetaCase.id}/decide`, { value: "shipping" });

  await assert.rejects(api("/api/policies/route_conversation/suggest", { scope: "acme", cases: [zetaCase.id] }), /pick at least one/);
  const s = await api("/api/policies/route_conversation/suggest", { scope: "acme", all: true });
  assert.deepEqual(s.added, [acmeCase.id]);
  assert.equal(s.base, 2);
  assert.equal(s.notes, "openai wrote this");
  const w = seen.filter(x => x.path.endsWith("/chat/completions") && x.body.tools[0].function.name === "write_policy").at(-1);
  assert.equal(w.body.model, "gpt-6.1-sol");
  assert.equal(w.headers.authorization, "Bearer sk-writer");
  assert.deepEqual(w.body.tool_choice, { type: "function", function: { name: "write_policy" } });
  assert.match(w.body.messages[1].content, /my charge is wrong/);
  assert.doesNotMatch(w.body.messages[1].content, /my parcel is late/);
  await api("/api/policies/route_conversation/discard", { scope: "acme" });
});

test("Gemini writes suggestions too, and writer() reads provider/model", async () => {
  Object.assign(process.env, { DECIDUS_SUGGEST_MODEL: "gemini/gemini-3.8-flash", GEMINI_API_KEY: "g-key", GEMINI_BASE_URL: mock });
  try {
    const s = await api("/api/policies/route_conversation/suggest", { scope: "zeta", all: true });
    assert.equal(s.notes, "gemini wrote this");
    const g = seen.filter(x => x.path.includes(":generateContent")).at(-1);
    assert.equal(g.path, "/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(g.headers["x-goog-api-key"], "g-key");
    assert.deepEqual(g.body.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["write_policy"] } });
    assert.ok(g.body.tools[0].functionDeclarations[0].parametersJsonSchema.properties.options);
    await api("/api/policies/route_conversation/discard", { scope: "zeta" });
  } finally {
    process.env.DECIDUS_SUGGEST_MODEL = "";
  }
  assert.deepEqual(writer(), { provider: "openai", model: "gpt-6.1-sol" }, "OpenAI first when its key is there");
  const keep = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  assert.deepEqual(writer(), { provider: "gemini", model: "gemini-3.8-flash" });
  process.env.ANTHROPIC_API_KEY = "a";
  assert.deepEqual(writer(), { provider: "anthropic", model: "claude-sonnet-5-5" });
  process.env.DECIDUS_SUGGEST_MODEL = "claude-opus-5-5";
  assert.deepEqual(writer(), { provider: "anthropic", model: "claude-opus-5-5" });
  process.env.DECIDUS_SUGGEST_MODEL = "openai/gpt-6-astra";
  assert.deepEqual(writer(), { provider: "openai", model: "gpt-6-astra" });
  Object.assign(process.env, { OPENAI_API_KEY: keep, DECIDUS_SUGGEST_MODEL: "" }); delete process.env.ANTHROPIC_API_KEY;
});

// ---------- volume: decisions API records straight into a store ----------
const decisionRec = (choice, confidence, scope = "") => ({
  url: "https://api.openai.com/v1/decisions", status: 200, ms: 40, scope, versions: {},
  request: { model: "gpt-6-luna", input: `ticket about ${choice}`, questions: [{ type: "choice", name: "triage", instructions: "Which queue?", choices: [{ value: "a" }, { value: "b" }, { value: "c" }] }] },
  response: { answers: [{ type: "choice", name: "triage", choice, confidence }] },
});

test("the queue is a balanced window, not a log", () => {
  const store = new Store(":memory:");
  for (let i = 0; i < 3; i++) ingest(store, decisionRec("b", 0.55), 0, 0);
  for (let i = 0; i < 2; i++) ingest(store, decisionRec("c", 0.7), 0, 0);
  for (let i = 0; i < 40; i++) ingest(store, decisionRec("a", 0.5), 0, 0);       // the newest 40 all say "a"
  for (let i = 0; i < 20; i++) ingest(store, decisionRec("a", 0.97), 0, 0);      // confident: not reviewable with sample 0
  assert.equal(store.tally("triage", "").queue, 45);
  const q = store.queue("triage", "", 6);
  assert.equal(q.length, 6);
  assert.deepEqual(new Set(q.map(c => c.answer)), new Set(["a", "b", "c"]), "every answer shows up in the first six");

  for (let i = 0; i < 50; i++) ingest(store, decisionRec("a", 0.97), 0, 1);      // sample everything: confident calls are reviewable too
  assert.ok(store.queue("triage", "", 8).some(c => c.confidence === 0.97), "confident calls get their own band");
});

test("calls: filters and cursor paging", () => {
  assert.deepEqual(parseFilter("answer:yes v:2 conf:<0.6 decided:no queue conv_1"),
    { answer: "true", version: 2, maxConf: 0.6, decided: "no", queued: true, text: "conv_1" });
  assert.deepEqual(parseFilter("conf:>=0.8"), { minConf: 0.8 });
  const store = new Store(":memory:");
  for (let i = 0; i < 25; i++) ingest(store, { ...decisionRec(i % 2 ? "a" : "b", 0.5, i < 5 ? "acme/bot" : "zeta"), conversation_id: `conv_${i}` }, 0, 0);
  const p1 = store.calls("triage", "", {}, null, 10), p2 = store.calls("triage", "", {}, p1.at(-1).id, 10);
  assert.equal(p1.length, 10); assert.ok(p2[0].id < p1.at(-1).id);
  assert.equal(store.calls("triage", "acme", {}, null, 100).length, 5);
  assert.equal(store.calls("triage", "", { answer: "a" }, null, 100).length, 12);
  assert.equal(store.calls("triage", "", { text: "conv_7" }, null, 100)[0].conversation_id, "conv_7");
  assert.equal(store.calls("triage", "", { text: "about b" }, null, 100).length, 13);
});

test("agreement per version and calls per day", () => {
  const store = new Store(":memory:");
  const ids = [0, 1, 2, 3].flatMap(() => ingest(store, decisionRec("a", 0.5), 0, 0));
  ["a", "a", "a", "b"].forEach((v, i) => store.decide(ids[i], v));
  assert.deepEqual(store.agreement("triage", ""), { 0: { n: 4, agree: 3 } });
  const d = store.daily("triage", 14);
  assert.equal(d.length, 14); assert.equal(d.at(-1), 4);
});

test("retention drops the bodies of calls nobody decided", () => {
  const store = new Store(":memory:");
  const [kept, gone] = [ingest(store, decisionRec("a", 0.5), 0, 0)[0], ingest(store, decisionRec("a", 0.5), 0, 0)[0]];
  store.decide(kept, "a");
  store.db.prepare("update cases set created_at = '2020-01-01T00:00:00.000Z'").run();
  assert.equal(store.prune(30), 1);
  assert.ok(store.case(kept).request, "decided cases keep their input for replay");
  assert.equal(store.case(gone).request, null);
  assert.equal(store.case(gone).escalated, false, "and leave the queue");
});

test("a 0.1 database opens and keeps its policies, versions and cases", () => {
  const path = join(mkdtempSync(join(tmpdir(), "decidus-")), "old.db");
  const db = new DatabaseSync(path);
  db.exec(`
    create table policies (name text primary key, route text, kind text, options text, field text, instructions text,
      code_text text, model text, live integer not null default 0, suggestion text, created_at text);
    create table versions (policy text, n integer, text text, because text, cases text, replay text, created_at text, primary key (policy, n));
    create table cases (id integer primary key autoincrement, policy text, version integer, model text, trace_id text, metadata text,
      url text, headers text, request text, response text, headline text, answer text, confidence real,
      escalated integer, decision text, decided_at text, used_in integer, status integer, ms integer, created_at text);
    create index cases_policy on cases (policy, escalated);
    insert into policies values ('triage', 'decisions', 'category', '["a","b"]', null, 'Which?', null, 'gpt-6-luna', 1, null, '2026-10-01T00:00:00Z');
    insert into versions values ('triage', 0, '{}', '{}', '[]', null, '2026-10-01T00:00:00Z'), ('triage', 1, '{"a":"x"}', '{"a":[1]}', '[1]', null, '2026-10-02T00:00:00Z');
    insert into cases values (1, 'triage', 0, 'gpt-6-luna', 'tr_1', '{}', 'https://api.openai.com/v1/decisions', '{}', '{"input":"hi"}', '{}', 'hi', 'a', 0.5, 1, 'a', '2026-10-01T00:00:00Z', 1, 200, 30, '2026-10-01T00:00:00Z');`);
  db.close();
  const store = new Store(path);
  assert.deepEqual(store.effective("triage", "anything"), { n: 1, from: "" });
  assert.deepEqual(store.live().policies.triage, { version: 1, text: { a: "x" } });
  assert.equal(store.version("triage", 1).base, 0);
  const c = store.case(1);
  assert.equal(c.scope, ""); assert.equal(c.trace_id, "tr_1"); assert.deepEqual(c.request, { input: "hi" }); assert.equal(c.used_in, 1);
});

test("review fixes: cases counted once, never taken from another version, stale results dropped, input coerced", async () => {
  const rec = (text, scope) => ({ url: mock + "/slow/v1/decisions", status: 200, ms: 5, scope, versions: {},
    request: { model: "gpt-6-luna", input: text, questions: [{ type: "choice", name: "triage2", instructions: "Which?", choices: [{ value: "a" }, { value: "b" }] }] },
    response: { answers: [{ type: "choice", name: "triage2", choice: "a", confidence: 0.5 }] } });
  const add = async (text, scope = "") => (await api("/v1/records", rec(text, scope))).cases[0];
  const ids = [await add("one", "acme"), await add("two", "acme"), await add("three")];
  for (const id of ids) await api(`/api/cases/${id}/decide`, { value: "b" });

  // a hand edit replays against decided cases without using them up; the next suggestion lists each case once
  const e = await api("/api/policies/triage2/edit", { text: { a: "x", b: "y" } });
  assert.deepEqual(e.cases, ids);
  await api("/api/policies/triage2/accept", {});
  const s = await api("/api/policies/triage2/suggest", { all: true });
  assert.deepEqual(s.cases, ids, "each case once");
  await api("/api/policies/triage2/discard", {});

  // two suggestions take the same case; the first accepted keeps it
  await api("/api/policies/triage2/suggest", { scope: "acme", cases: [ids[0]] });
  await api("/api/policies/triage2/suggest", { cases: [ids[0], ids[2]] });
  const va = (await api("/api/policies/triage2/accept", { scope: "acme" })).live;
  const vg = (await api("/api/policies/triage2/accept", {})).live;
  assert.equal((await api(`/api/cases/${ids[0]}`)).used_in, va);
  assert.equal((await api(`/api/cases/${ids[2]}`)).used_in, vg);

  // acme runs its own version now, so its decisions don't shape the global one
  const ac = await add("four", "acme/bot"), gl = await add("five");
  await api(`/api/cases/${ac}/decide`, { value: "b" }); await api(`/api/cases/${gl}/decide`, { value: "b" });
  assert.deepEqual((await api("/api/policies/triage2/suggest", { all: true })).added, [gl]);
  await api("/api/policies/triage2/discard", {});

  // a replay that finishes after the text changed doesn't attach its results to the new text
  await api("/api/policies/triage2/edit", { text: { a: "first" } });
  const pending = api("/api/policies/triage2/replay", { target: "suggestion" });
  await sleep(60);
  await api("/api/policies/triage2/edit", { text: { a: "second" } });
  assert.equal((await pending).length > 0, true);
  const d = await api("/api/policies/triage2");
  assert.equal(d.suggestion.text.a, "second");
  assert.equal(d.suggestion.replay, null);
  await api("/api/policies/triage2/discard", {});

  // records are data, not markup
  const bad = (await api("/v1/records", { ...rec("six", ""), versions: { triage2: "<img src=x onerror=alert(1)>" }, ms: "<b>", status: "200" })).cases[0];
  const c = await api(`/api/cases/${bad}`);
  assert.deepEqual([c.version, c.ms, c.status], [0, 0, 200]);
  assert.ok((await api("/api/policies/triage2/calls?limit=0")).calls.length > 0);
  assert.equal((await api("/api/policies/triage2/calls?limit=-1")).calls.length, 1);
});
