// Scopes (company/bot policies with global fallback), hand edits, the three writer providers,
// the review queue at volume, call filters, retention and database migrations from 0.1 on.
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
import { edit, rebase, save, stage, traffic, tune, writer } from "../dist/loop.js";
import { prefixes, normScope, resolve } from "../dist/shapes.js";

// ---------- mock provider: a "model" that only knows what the policy text tells it, plus writer endpoints ----------
const seen = [];
const KNOWS = [["charge", "billing"], ["crash", "technical"], ["damaged", "shipping"], ["parcel", "shipping"]];
const decide = (d = "", t = "") => { for (const [k, v] of KNOWS) if (d.includes(k) && t.includes(k)) return v; return "billing"; };
// the writer: whatever parts the decision has, it writes each one, a little differently each time
let writes = 0;
const written = (tool, notes) => (writes++, { notes, parts: tool.parameters.properties.parts.items.properties.part.enum.map(part => ({ part, cases: [],
  text: part === "description" ? `billing: unexpected or duplicate charges. technical: app crash. shipping: parcel late, lost or damaged. Draft ${writes}.` : `${part} as the writer sees it, take ${writes}.` })) });

const provider = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  seen.push({ path: req.url, headers: req.headers, body });
  const json = o => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url.includes("/slow/")) await new Promise(r => setTimeout(r, 250));
  if (req.url.endsWith("/decisions")) return json({ answers: [{ type: "choice", name: body.questions[0].name, choice: "b", confidence: 0.9 }] });
  if (req.url.includes(":generateContent")) {
    const fn = body.tools[0].functionDeclarations[0];
    return json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "write_policy", args: written({ parameters: fn.parametersJsonSchema }, "gemini wrote this") } }] } }] });
  }
  if (req.url.endsWith("/chat/completions")) {
    const tool = body.tools[0].function;
    const args = tool.name === "write_policy" ? written(tool, "openai wrote this")
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
  ({ server: srv } = createServer({ quiet: true, warmup: 1000, observe: 2 }));
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
  openai = new OpenAI({ apiKey: "sk-test", baseURL: mock + "/v1", fetch: decidus.fetch({ baseUrl: base, ttlMs: 0 }) });
});
after(() => { srv.close(); provider.close(); });

test("scope paths", () => {
  assert.equal(normScope(" /acme//support-bot/ "), "acme/support-bot");
  assert.deepEqual(prefixes("acme/support-bot"), ["acme/support-bot", "acme", ""]);
  const live = { policies: { p: { version: 1, ops: {} } }, scopes: { acme: { p: { version: 2, ops: {} } }, "acme/b": { p: { version: 0, ops: {} } } } };
  assert.equal(resolve(live, "acme/x").p.version, 2);
  assert.equal(resolve(live, "acme/b").p.version, 0, "a bot pinned to the code as written");
  assert.equal(resolve(live, "zeta").p.version, 1);
});

test("a company gets its own version; its bots inherit it; everyone else stays on global", async () => {
  await route("hello, first sight"); await route("hello again");
  for (const t of ["hi from acme", "acme again"]) await decidus.trace({ scope: "acme/support-bot" }, () => route(t));
  await until(async () => (await api("/api/policies/route_conversation.team?scope=acme")).template.ready);

  // global v1, written by hand into the field's empty description
  const e = await api("/api/policies/route_conversation.team/edit", { parts: { description: "billing: charges. technical: crash. shipping: parcel." } });
  assert.deepEqual(e.ops.description, [{ op: "insert", after: null, before: null, text: "billing: charges. technical: crash. shipping: parcel." }]);
  assert.equal((await api("/api/policies/route_conversation.team/stage", { mode: "live" })).n, 1);

  // acme edits on top of what it runs (global v1) and goes live: v2 belongs to acme
  const v = await api("/api/policies/route_conversation.team/view?v=live&scope=acme");
  assert.equal(v.edit.description, "billing: charges. technical: crash. shipping: parcel.");
  const s = await api("/api/policies/route_conversation.team/edit", { scope: "acme", parts: { description: v.edit.description.replace("shipping: parcel.", "shipping: parcel; damaged items.") } });
  assert.equal(s.base, 1);
  assert.match(s.tune.at(-1).note, /Edited description by hand/);
  assert.equal((await api("/api/policies/route_conversation.team/stage", { scope: "acme", mode: "live" })).n, 2);

  const live = await api("/v1/policies");
  assert.equal(live.policies["route_conversation.team"].version, 1);
  assert.equal(live.scopes.acme["route_conversation.team"].version, 2);

  await route("warm-up"); await sleep(80);
  const acme = await decidus.trace({ scope: "acme/support-bot", conversationId: "conv_a1" }, () => route("the box arrived damaged"));
  assert.equal(teamOf(acme), "shipping");
  assert.equal(lastSent(), "billing: charges. technical: crash. shipping: parcel; damaged items.");
  const zeta = await decidus.trace({ scope: "zeta/web" }, () => route("the box arrived damaged"));
  assert.equal(teamOf(zeta), "billing", "zeta runs global v1, which knows nothing about damage");
  assert.doesNotMatch(lastSent(), /damaged/);

  const calls = await until(async () => { const d = await api("/api/policies/route_conversation.team/calls?scope=acme&q=v:2"); return d.calls.length === 1 && d; });
  assert.equal(calls.calls[0].scope, "acme/support-bot");
  assert.equal(calls.calls[0].conversation_id, "conv_a1");

  const bot = await api("/api/policies/route_conversation.team?scope=acme/support-bot");
  assert.deepEqual(bot.effective, { n: 2, from: "acme" });
  assert.deepEqual(bot.versions.map(v => [v.n, v.scope]), [[0, ""], [1, ""], [2, "acme"]]);
  assert.deepEqual((await api("/api/policies/route_conversation.team")).versions.map(v => v.n), [0, 1], "global shows only its own line");
  assert.deepEqual((await api("/api/policies/route_conversation.team")).scopes, ["acme", "acme/support-bot", "zeta", "zeta/web"]);

  // v2 is acme's; zeta can't run it. acme can go back to inheriting.
  await assert.rejects(api("/api/policies/route_conversation.team/live", { scope: "zeta", version: 2 }), /belongs to acme/);
  await api("/api/policies/route_conversation.team/live", { scope: "acme", version: null });
  assert.deepEqual((await api("/api/policies/route_conversation.team?scope=acme")).effective, { n: 1, from: "" });
  assert.equal((await api("/v1/policies")).scopes.acme, undefined);
  await api("/api/policies/route_conversation.team/live", { scope: "acme", version: 2 });
});

test("a scope's suggestion only learns from that scope; OpenAI writes it by default", async () => {
  await decidus.trace({ scope: "acme/support-bot" }, () => route("my charge is wrong"));
  await decidus.trace({ scope: "zeta/web" }, () => route("my parcel is late"));
  const calls = await until(async () => { const d = await api("/api/policies/route_conversation.team/calls?q=decided:no"); return d.calls.some(c => c.headline.includes("parcel is late")) && d; });
  const acmeCase = calls.calls.find(c => c.scope === "acme/support-bot" && c.headline.includes("charge"));
  const zetaCase = calls.calls.find(c => c.scope === "zeta/web" && c.headline.includes("parcel"));
  await api(`/api/cases/${acmeCase.id}/decide`, { value: "billing" });
  await api(`/api/cases/${zetaCase.id}/decide`, { value: "shipping" });

  await assert.rejects(api("/api/policies/route_conversation.team/suggest", { scope: "acme", cases: [zetaCase.id] }), /pick at least one/);
  const s = await api("/api/policies/route_conversation.team/suggest", { scope: "acme", all: true });
  assert.deepEqual(s.added, [acmeCase.id]);
  assert.equal(s.base, 2);
  assert.equal(s.notes, "openai wrote this");
  assert.deepEqual(Object.keys(s.ops), ["description"]);
  const w = seen.filter(x => x.path.endsWith("/chat/completions") && x.body.tools[0].function.name === "write_policy").at(-1);
  assert.equal(w.body.model, "gpt-6.1-sol");
  assert.equal(w.headers.authorization, "Bearer sk-writer");
  assert.deepEqual(w.body.tool_choice, { type: "function", function: { name: "write_policy" } });
  assert.match(w.body.messages[1].content, /my charge is wrong/);
  assert.doesNotMatch(w.body.messages[1].content, /my parcel is late/);
  await api("/api/policies/route_conversation.team/discard", { scope: "acme" });
});

test("Gemini writes suggestions too, and writer() reads provider/model", async () => {
  Object.assign(process.env, { DECIDUS_SUGGEST_MODEL: "gemini/gemini-3.8-flash", GEMINI_API_KEY: "g-key", GEMINI_BASE_URL: mock });
  try {
    const s = await api("/api/policies/route_conversation.team/suggest", { scope: "zeta", all: true });
    assert.equal(s.notes, "gemini wrote this");
    const g = seen.filter(x => x.path.includes(":generateContent")).at(-1);
    assert.equal(g.path, "/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(g.headers["x-goog-api-key"], "g-key");
    assert.deepEqual(g.body.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["write_policy"] } });
    assert.ok(g.body.tools[0].functionDeclarations[0].parametersJsonSchema.properties.parts);
    await api("/api/policies/route_conversation.team/discard", { scope: "zeta" });
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

test("to review: shadow disagreements first, then the least certain, then answers people often correct", () => {
  const store = new Store(":memory:");
  const c = [];
  for (let i = 0; i < 2; i++) c.push(ingest(store, decisionRec("c", 0.7), 0, 0)[0]);
  for (let i = 0; i < 3; i++) ingest(store, decisionRec("b", 0.55), 0, 0);
  for (let i = 0; i < 40; i++) ingest(store, decisionRec("a", 0.5), 0, 0);
  for (let i = 0; i < 20; i++) ingest(store, decisionRec("a", 0.97), 0, 0);      // confident: not reviewable with sample 0
  assert.equal(store.tally("triage", "").queue, 45);
  const q = store.review("triage", "", 45);
  assert.deepEqual([q[0].confidence, q[40].confidence, q[43].confidence], [0.5, 0.55, 0.7], "a coin flip first, then less and less unsure");
  store.setShadow(c[1], 2, "b", true);                                            // a shadow answered differently
  assert.equal(store.review("triage", "", 1)[0].id, c[1]);
  assert.deepEqual(parseFilter("differs:2").differs, 2);
  assert.deepEqual(store.calls("triage", "", { differs: true }, null, 10).map(r => r.id), [c[1]]);

  // no confidence: answers people correct more often come first
  const none = (choice) => ({ ...decisionRec(choice, null), response: { answers: [{ type: "choice", name: "triage", choice }] } });
  const s2 = new Store(":memory:");
  const ids = [...Array(6)].map((_, i) => ingest(s2, none(i % 2 ? "x" : "y"), 99, 0)[0]);
  s2.decide(ids[0], "x"); s2.decide(ids[2], "x");                                  // people corrected "y" twice
  s2.decide(ids[1], "x");
  assert.equal(s2.review("triage", "", 1)[0].answer, "y");
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
  assert.deepEqual(store.live().policies.triage, { version: 1, ops: {} }, "0.3 versions were option descriptions; they no longer change calls");
  assert.equal(store.version("triage", 1).legacy, true);
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
  const e = await api("/api/policies/triage2/edit", { parts: { "choices.a": "x", "choices.b": "y" } });
  assert.deepEqual(e.added, []);
  assert.deepEqual((await api("/api/policies/triage2/replay", { target: "draft" })).map(r => r.id), ids);
  await api("/api/policies/triage2/stage", { mode: "live" });
  const s = await api("/api/policies/triage2/suggest", { all: true });
  assert.deepEqual(s.cases, ids, "each case once");
  await api("/api/policies/triage2/discard", {});

  // two drafts take the same case; the first to become a version keeps it
  await api("/api/policies/triage2/suggest", { scope: "acme", cases: [ids[0]] });
  await api("/api/policies/triage2/suggest", { cases: [ids[0], ids[2]] });
  const va = (await api("/api/policies/triage2/stage", { scope: "acme", mode: "live" })).n;
  const vg = (await api("/api/policies/triage2/stage", { mode: "live" })).n;
  assert.equal((await api(`/api/cases/${ids[0]}`)).used_in, va);
  assert.equal((await api(`/api/cases/${ids[2]}`)).used_in, vg);

  // acme runs its own version now, so its decisions don't shape the global one
  const ac = await add("four", "acme/bot"), gl = await add("five");
  await api(`/api/cases/${ac}/decide`, { value: "b" }); await api(`/api/cases/${gl}/decide`, { value: "b" });
  assert.deepEqual((await api("/api/policies/triage2/suggest", { all: true })).added, [gl]);
  await api("/api/policies/triage2/discard", {});

  // a replay that finishes after the text changed doesn't attach its results to the new text
  await api("/api/policies/triage2/edit", { parts: { "choices.a": "first" } });
  const pending = api("/api/policies/triage2/replay", { target: "draft" });
  await sleep(60);
  await api("/api/policies/triage2/edit", { parts: { "choices.a": "second" } });
  assert.equal((await pending).length > 0, true);
  const d = await api("/api/policies/triage2");
  assert.deepEqual(d.draft.ops["choices.a"], [{ op: "insert", after: null, before: null, text: "second" }]);
  assert.equal(d.draft.replay, null);
  await api("/api/policies/triage2/discard", {});

  // records are data, not markup
  const bad = (await api("/v1/records", { ...rec("six", ""), versions: { triage2: "<img src=x onerror=alert(1)>" }, ms: "<b>", status: "200" })).cases[0];
  const c = await api(`/api/cases/${bad}`);
  assert.deepEqual([c.version, c.ms, c.status], [0, 0, 200]);
  assert.ok((await api("/api/policies/triage2/calls?limit=0")).calls.length > 0);
  assert.equal((await api("/api/policies/triage2/calls?limit=-1")).calls.length, 1);
});

test("edits the newest call can't show survive a re-save; staging names what it stages; keeping decidus's text stays in its scope", () => {
  const store = new Store(":memory:");
  store.observe = 4;
  const A = "Answer true if the customer wants a refund.", VIP = "Escalate VIP customers.", C = "Otherwise answer false.";
  const rec = (ins, scope = "") => ({ url: "https://api.openai.com/v1/decisions", status: 200, scope, versions: {},
    request: { model: "m", input: "hi", questions: [{ name: "q", type: "predicate", instructions: ins }] }, response: { answers: [{ name: "q", probability: 0.9 }] } });
  for (let i = 0; i < 5; i++) ingest(store, rec(`${A} ${VIP} ${C}`), 0, 0);
  edit(store, "q", "", { instructions: `${A} Escalate VIP and enterprise customers. ${C}` });
  assert.equal(stage(store, "q", "", "live").n, 1);

  // the VIP sentence is still in most calls, but not in the newest one: a no-change save keeps its edit
  ingest(store, rec(`${A} ${C}`), 0, 0);
  const d = edit(store, "q", "", { instructions: `${A} ${C} Be brief.` });
  assert.deepEqual(d.ops.instructions.map(o => o.op), ["insert", "replace"]);
  assert.equal(stage(store, "q", "", "canary", 10, "draft").n, 2);

  // a new draft while v2 is on canary: updating the canary's share leaves the draft alone
  edit(store, "q", "", { instructions: `${A} ${C} Be very brief.` });
  assert.equal(stage(store, "q", "", "canary", 50, 2).n, 2);
  assert.ok(store.variant("q", "").draft, "the draft is still a draft");
  assert.deepEqual(store.variant("q", "").candidates.map(c => [c.n, c.mode, c.pct]), [[2, "canary", 50]]);
  store.setDraft("q", "", null); store.setCandidates("q", "", []);

  // acme's code rewrote the VIP sentence; keeping decidus's text there doesn't touch global
  for (let i = 0; i < 4; i++) ingest(store, rec(`${A} Escalate VIP accounts quickly. ${C}`, "acme"), 0, 0);
  const n = rebase(store, "q", "acme");
  assert.deepEqual([store.effective("q", "acme"), store.effective("q", "zeta")], [{ n, from: "acme" }, { n: 1, from: "" }]);
  assert.deepEqual(store.version("q", n).ops.instructions, [{ op: "replace", clause: "Escalate VIP accounts quickly.", text: "Escalate VIP and enterprise customers." }]);
});

test("several versions tried at once: canaries take slices of traffic, shadows slices of calls; a draft saves as a version", () => {
  const store = new Store(":memory:");
  store.observe = 2;
  const rec = (ins) => ({ url: "https://api.openai.com/v1/decisions", status: 200, scope: "", versions: {},
    request: { model: "m", input: "hi", questions: [{ name: "t", type: "predicate", instructions: ins }] }, response: { answers: [{ name: "t", probability: 0.9 }] } });
  for (let i = 0; i < 3; i++) ingest(store, rec("Answer true for refunds. Otherwise false."), 0, 0);
  const v = n => { edit(store, "t", "", { instructions: `Answer true for refunds. Otherwise false. Note ${n}.` }); return save(store, "t", ""); };
  const [a, b, c] = [v(1), v(2), v(3)];
  assert.deepEqual([a, b, c, store.variant("t", "").draft], [1, 2, 3, null], "saved drafts are versions with no traffic");
  assert.equal(store.effective("t", "").n, 0);

  traffic(store, "t", "", a, { traffic: 10 });
  traffic(store, "t", "", b, { traffic: 20 });
  traffic(store, "t", "", c, { shadow: 30 });
  assert.deepEqual(store.variant("t", "").candidates.map(x => [x.n, x.mode, x.pct]), [[1, "canary", 10], [2, "canary", 20], [3, "shadow", 30]]);
  assert.deepEqual(store.live().policies.t.canaries.map(x => [x.version, x.pct]), [[1, 10], [2, 20]]);
  assert.throws(() => traffic(store, "t", "", c, { traffic: 80 }), /all traffic/);
  assert.throws(() => traffic(store, "t", "", a, { shadow: 10 }), /already answers traffic/);

  // the live version gives up share: the largest canary takes it; at 0 that canary is live
  traffic(store, "t", "", 0, { traffic: 50 });
  assert.deepEqual(store.variant("t", "").candidates.filter(x => x.mode === "canary").map(x => [x.n, x.pct]), [[1, 10], [2, 40]]);
  traffic(store, "t", "", 0, { traffic: 0 });
  assert.equal(store.effective("t", "").n, 2);
  // 100% makes a version live: the other canaries stop, shadows keep comparing
  traffic(store, "t", "", a, { traffic: 100 });
  assert.equal(store.effective("t", "").n, 1);
  assert.deepEqual(store.variant("t", "").candidates.map(x => [x.n, x.mode]), [[3, "shadow"]]);
  assert.equal(store.version("t", 3).log.origin, "hand");
});

test("trials: inherited ones can be changed, each canary keeps its slice, the live version's share moves the largest canary, shadows only re-run live answers", async () => {
  const store = new Store(":memory:");
  store.observe = 2;
  const rec = (ins, scope = "", versions = {}) => ({ url: "https://api.openai.com/v1/decisions", status: 200, scope, versions,
    request: { model: "m", input: "hi", questions: [{ name: "u", type: "predicate", instructions: ins }] }, response: { answers: [{ name: "u", probability: 0.9 }] } });
  for (let i = 0; i < 3; i++) ingest(store, rec("Answer true for refunds. Otherwise false."), 0, 0);
  const v = n => { edit(store, "u", "", { instructions: `Answer true for refunds. Otherwise false. Note ${n}.` }); return save(store, "u", ""); };
  const [a, b, c] = [v(1), v(2), v(3)];

  // each canary owns its slice: adding, resizing or stopping one moves no other
  traffic(store, "u", "", a, { traffic: 20 });
  traffic(store, "u", "", b, { traffic: 10 });
  const at = () => Object.fromEntries(store.variant("u", "").candidates.map(x => [x.n, [x.at, x.pct]]));
  assert.deepEqual(at(), { [a]: [0, 20], [b]: [20, 10] });
  traffic(store, "u", "", a, { traffic: 5 });
  assert.deepEqual(at(), { [a]: [0, 5], [b]: [20, 10] });
  traffic(store, "u", "", a, { traffic: 0 });
  assert.deepEqual(at(), { [b]: [20, 10] });
  assert.deepEqual(store.live().policies.u.canaries.map(x => [x.version, x.at, x.pct]), [[b, 20, 10]]);

  // the live version's share goes up: the largest canary gives way first
  traffic(store, "u", "", a, { traffic: 30 });
  traffic(store, "u", "", 0, { traffic: 80 });
  assert.deepEqual(store.variant("u", "").candidates.filter(x => x.mode === "canary").map(x => [x.n, x.pct]), [[b, 10], [a, 10]].sort((x, y) => x[0] - y[0]));

  // acme inherits global's trials; changing one there gives acme its own copy, comparison clock and all
  const since = store.variant("u", "").candidates.find(x => x.n === b).since;
  traffic(store, "u", "acme", b, { traffic: 40 });
  const own = store.variant("u", "acme").candidates;
  assert.deepEqual(own.map(x => [x.n, x.pct]), [[a, 10], [b, 40]]);
  assert.equal(own.find(x => x.n === b).since, since);
  assert.deepEqual(store.variant("u", "").candidates.map(x => [x.n, x.pct]), [[a, 10], [b, 10]], "global is untouched");

  // a version that goes live stops being tried, wherever the trial was set
  traffic(store, "u", "", b, { traffic: 100 });
  traffic(store, "u", "acme", 0, { traffic: 100 });
  traffic(store, "u", "acme", c, { shadow: 100 });
  assert.ok(store.candidatesFor("u", "zeta").every(x => x.n !== b));

  // shadows only re-run calls the live version answered
  traffic(store, "u", "acme", a, { traffic: 50 });
  const pushed = [], fake = { push: (id, n) => pushed.push(n) };
  ingest(store, rec("Answer true for refunds. Otherwise false.", "acme", { u: a }), 0, 0, fake);
  ingest(store, rec("Answer true for refunds. Otherwise false.", "acme", { u: 0 }), 0, 0, fake);
  assert.deepEqual(pushed, [c]);
  edit(store, "u", "acme", { instructions: "Answer true for refunds. Otherwise false. Be brief." });
  await assert.rejects(tune(store, "u", "acme", 3, a), /draft already/);
});
