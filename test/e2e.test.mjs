// End to end: real OpenAI + Anthropic TS SDKs -> decidus.fetch() -> mock provider, records -> decidus server.
// Observe -> decide -> draft -> replay accuracy -> auto-tune -> shadow -> canary -> live, then the code
// changes its text under the live version: unrelated changes merge, a conflicting one wins until people
// choose to keep decidus's text.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import * as decidus from "../dist/index.js";
import { createServer } from "../dist/server.js";

// ---------- a mock provider whose "model" only knows what the field's description tells it ----------
const seen = [];
let writerCalls = 0;
const KNOWS = [["charge", "billing"], ["crash", "technical"], ["parcel", "shipping"]];
function decide(description = "", text = "") {
  for (const [kw, team] of KNOWS) if (description.includes(kw) && text.includes(kw)) return team;
  return "billing";
}
const userText = b => JSON.stringify(b.messages ?? b.input ?? "");
const S1 = "The team that should handle this conversation.", LEGACY = "Legacy: VIP customers go to billing.";

const provider = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  seen.push({ path: req.url, body });
  const json = o => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

  if (req.url.endsWith("/chat/completions")) {
    const tool = body.tools?.[0]?.function;
    if (!body.tool_choice) return json({ id: "c", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }] });
    const team = decide(tool.parameters.properties.team.description, userText(body));
    return json({ id: "c", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify({ team }) } }] } }] });
  }
  if (req.url.endsWith("/messages")) {
    const tool = body.tools?.[0];
    if (tool?.name === "write_policy") {                       // the writer: simplifies the text, drops the legacy note
      writerCalls++;
      const prompt = body.messages[0].content, fixing = prompt.includes("still fail");
      const text = `${prompt.includes("Pick the team") ? "Pick the team for this conversation." : S1} Billing: duplicate or unexpected charges. Technical: app crash or error on the device. ` +
        (fixing ? "Shipping: parcel delayed or stuck with the carrier." : "Shipping: delivery problems.");
      const cases = [...prompt.matchAll(/#(\d+) ·/g)].map(m => Number(m[1]));
      return json({ id: "m", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", id: "tu", name: "write_policy", input: { parts: [{ part: "description", text, cases }], notes: "Dropped the VIP note: no case needed it." } }] });
    }
    return json({ id: "m", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "tu", name: tool.name, input: { needs_human: userText(body).includes("lawyer") } }] });
  }
  res.writeHead(404); res.end();
});

let srv, shadow, base, mock, openai, claude;
const api = async (path, body) => {
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const until = async (f, ms = 3000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise(r => setTimeout(r, 30)); } };
const P = (s = "") => "/api/policies/route_conversation.team" + s;

let DESC = `${S1} ${LEGACY}`;                     // the code's own text; tests change it like a deploy would
const tool = () => ({ type: "function", function: { name: "route_conversation", description: "Route the conversation.",
  parameters: { type: "object", properties: { team: { type: "string", enum: ["billing", "technical", "shipping"], description: DESC } }, required: ["team"] } } });
const route = content => openai.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "user", content }], tools: [tool()],
  tool_choice: { type: "function", function: { name: "route_conversation" } } });
const teamOf = r => JSON.parse(r.choices[0].message.tool_calls[0].function.arguments).team;
const lastSent = () => seen.filter(s => s.path.endsWith("/chat/completions") && s.body.tool_choice).at(-1).body.tools[0].function.parameters.properties.team.description;
const fresh = async () => { await route("warm-up: refreshes the cached live policies"); await new Promise(r => setTimeout(r, 80)); };

before(async () => {
  await new Promise(r => provider.listen(0, r));
  mock = `http://127.0.0.1:${provider.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = mock;   // the writer
  process.env.DECIDUS_SUGGEST_MODEL = "anthropic/claude-sonnet-5-5";
  ({ server: srv, shadow } = createServer({ quiet: true, observe: 6 }));
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const f = decidus.fetch({ baseUrl: base, ttlMs: 0 });
  openai = new OpenAI({ apiKey: "sk-test", baseURL: mock + "/v1", fetch: f });
  claude = new Anthropic({ apiKey: "sk-ant-test", baseURL: mock, fetch: f });
});
after(() => { srv.close(); provider.close(); });

const TICKETS = [
  ["I was charged twice for my order", "billing"],
  ["The app keeps crashing when I open settings", "technical"],
  ["My parcel has been stuck for a week", "shipping"],
  ["Why is there a charge I don't recognise?", "billing"],
  ["Every time I log in the app crashes", "technical"],
  ["Where is my parcel? Tracking hasn't moved", "shipping"],
];

test("first sight: a v0 policy; decidus observes until it can tell fixed text from text that varies", async () => {
  for (const [text] of TICKETS.slice(0, 3)) assert.equal(teamOf(await route(text)), "billing");   // v0 knows nothing
  const early = await until(async () => { const d = await api(P()).catch(() => null); return d?.tally.calls === 3 && d; });
  assert.deepEqual([early.template.ready, early.template.seen, early.template.need], [false, 3, 6]);
  await api(`/api/cases/${early.queue[0].id}/decide`, { value: "billing" });
  await assert.rejects(api(P("/suggest"), { all: true }), /Still observing: 3 of 6 calls/);

  for (const [text] of TICKETS.slice(3)) await route(text);
  const d = await until(async () => { const d = await api(P()); return d.queue.length === 5 && d; });
  assert.deepEqual(d.policy.options, ["billing", "technical", "shipping"]);
  assert.equal(d.policy.field, "team");
  assert.deepEqual(d.template, { ready: true, seen: 6, need: 6, parts: [{ part: "description", static: 2, dynamic: 0, locked: 0 }] });
  const v = await api(P("/view?v=0"));
  assert.equal(v.merged.description, DESC);
});

test("plain chat and unforced calls pass through without a record", async () => {
  const r = await openai.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }] });
  assert.equal(r.choices[0].message.content, "hi");
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await api("/api/overview")).length, 1);
});

test("decide, draft, replay for accuracy, auto-tune, then live", async () => {
  const d = await api(P());
  const all = (await api(P("/calls"))).calls.sort((a, b) => a.id - b.id);
  for (const [i, c] of all.entries()) await api(`/api/cases/${c.id}/decide`, { value: TICKETS[i][1] });
  assert.equal(d.queue.length, 5);

  const s = await api(P("/suggest"), { all: true });
  assert.equal(s.base, 0);
  assert.deepEqual(s.ops.description, [
    { op: "delete", clause: LEGACY },
    { op: "insert", after: LEGACY, before: null, text: "Billing: duplicate or unexpected charges. Technical: app crash or error on the device. Shipping: delivery problems." },
  ], "the legacy note is dropped; the new rules go where it stood");
  assert.equal(s.notes, "Dropped the VIP note: no case needed it.");
  const draft = await api(P("/view?v=draft"));
  assert.equal(draft.merged.description, `${S1} Billing: duplicate or unexpected charges. Technical: app crash or error on the device. Shipping: delivery problems.`);
  assert.deepEqual(draft.parts[0].units.filter(u => u.kind === "del").map(u => u.text), [LEGACY]);

  const r1 = await api(P("/replay"), { target: "draft" });
  assert.equal(r1.length, 6);
  assert.equal(r1.filter(x => x.pass).length, 4, "the vague shipping wording fails both parcel cases");

  const tuned = await api(P("/tune"), {});
  assert.ok(tuned.replay.every(x => x.pass));
  assert.equal(tuned.tune.at(-1).pass, 6);
  assert.equal(writerCalls, 2);

  assert.deepEqual(await api(P("/stage"), { mode: "live" }), { n: 1, mode: "live" });
  const after = await api(P());
  assert.equal(after.effective.n, 1);
  assert.equal(after.draft, null);
  assert.ok(after.processed.every(c => c.used_in === 1));
  assert.deepEqual(after.agreement[0], { n: 6, agree: 2 }, "v0 said billing every time; people agreed twice");
});

test("calls carry v1 merged into the code's text; the stored request stays the code's own", async () => {
  await fresh();
  const r = await decidus.trace({ traceId: "tr_9f2c41", conversationId: "conv_8f2c1", metadata: { channel: "chat" } }, () => route("My parcel never arrived"));
  assert.equal(teamOf(r), "shipping");
  assert.match(lastSent(), /Shipping: parcel delayed/);
  assert.doesNotMatch(lastSent(), /Legacy/);
  const d = await until(async () => { const d = await api(P("/calls")); return d.calls[0].headline === "My parcel never arrived" && d; });
  const last = await api(`/api/cases/${d.calls[0].id}`);
  assert.deepEqual([last.version, last.retired, last.trace_id, last.conversation_id], [1, 0, "tr_9f2c41", "conv_8f2c1"]);
  assert.deepEqual(last.metadata, { channel: "chat" });
  assert.equal(last.request.tools[0].function.parameters.properties.team.description, DESC, "stored request is the code's own");
  assert.match(last.sent.tools[0].function.parameters.properties.team.description, /parcel delayed/, "the view shows what was sent");
  assert.equal(JSON.stringify(last.headers).includes("sk-test"), false, "provider keys never recorded");
});

test("the code changes a clause v1 doesn't touch: both changes go out", async () => {
  DESC = `Pick the team for this conversation. ${LEGACY}`;
  await route("my parcel is lost");
  assert.equal(lastSent(), "Pick the team for this conversation. Billing: duplicate or unexpected charges. Technical: app crash or error on the device. Shipping: parcel delayed or stuck with the carrier.");
});

test("the code changes a clause v1 edits: the code wins, the UI warns, people can keep decidus's text", async () => {
  DESC = "Pick the team for this conversation. Legacy: VIP and gold customers go to billing.";
  for (let i = 0; i < 6; i++) await route("my parcel is lost");    // a deploy: the newest calls carry the new text
  assert.equal(lastSent(), DESC, "v1's edits anchored on the old legacy clause no longer apply");
  const d = await until(async () => { const d = await api(P()); return d.retired && d; });
  assert.equal(d.retired.version, 1);
  assert.deepEqual(d.retired.ops.map(o => o.op), ["delete", "insert"]);
  assert.ok(d.retired.calls >= 6);

  const { live } = await api(P("/rebase"), {});
  assert.equal(live, 2);
  const v2 = (await api(P())).versions.find(v => v.n === 2);
  assert.equal(v2.log.rebased, 1);
  await fresh();
  await route("my parcel is lost");
  assert.equal(lastSent(), "Pick the team for this conversation. Billing: duplicate or unexpected charges. Technical: app crash or error on the device. Shipping: parcel delayed or stuck with the carrier.");
  assert.equal((await until(async () => { const d = await api(P()); return d.effective.n === 2 && d; })).retired, null);
});

test("shadow: the candidate re-runs calls on the side; where it disagrees the call goes to review", async () => {
  // a hand edit that breaks crash routing, so the two versions disagree on crash tickets
  const live = await api(P("/view?v=live"));
  const text = live.edit.description.replace("Technical: app crash or error on the device.", "Technical: login problems.");
  const e = await api(P("/edit"), { parts: { description: text } });
  assert.match(e.tune.at(-1).note, /Edited description by hand/);
  assert.deepEqual(await api(P("/stage"), { mode: "shadow", pct: 100 }), { n: 3, mode: "shadow" });
  assert.equal((await api("/v1/policies")).policies["route_conversation.team"].canary, undefined, "shadow is never served");

  await fresh();
  for (const t of ["the app crashes on start", "the app crashed again", "I was charged twice"]) await route(t);
  await until(async () => (await api(P("/calls"))).calls.filter(c => c.shadow_version === 3).length >= 3);
  await shadow.idle();
  const d = await api(P());
  assert.deepEqual(d.candidates.map(c => [c.n, c.mode]), [[3, "shadow"]]);
  assert.equal(d.compare[3].live.n, 2);
  assert.ok(d.compare[3].paired.n >= 3 && d.compare[3].paired.differ >= 2, "crash tickets: live says technical, the candidate billing");
  assert.ok((await api(P("/calls?q=differs:3"))).calls.length >= 2, "the calls it answered differently, as a filter");
  const crash = (await api(P("/calls?q=crashes"))).calls.find(c => c.shadow_version === 3);
  assert.deepEqual([crash.answer, crash.shadow_answer, crash.escalated], ["technical", "billing", 1]);
  await api(`/api/cases/${crash.id}/decide`, { value: "technical" });
  assert.deepEqual((await api(P())).compare[3].candidate.reviewed, { n: 1, agree: 0 });
  const top = (await api(P("/calls?review=1"))).calls[0];
  assert.deepEqual([top.shadow_version, top.answer !== top.shadow_answer], [3, true], "to review: where the shadow disagreed comes first");
  await api(P("/stop"), {});
  assert.deepEqual((await api(P())).candidates, []);
});

test("canary: the candidate is served to a share of calls, the same version for the whole conversation", async () => {
  const live = await api(P("/view?v=live"));
  await api(P("/edit"), { parts: { description: live.edit.description + " Ask for the order number when unsure." } });
  assert.deepEqual(await api(P("/stage"), { mode: "canary", pct: 50 }), { n: 4, mode: "canary" });
  assert.deepEqual((await api("/v1/policies")).policies["route_conversation.team"].canaries.map(c => [c.version, c.pct]), [[4, 50]]);
  await fresh();
  const sent = [];
  for (let i = 0; i < 12; i++) {
    const conv = "conv_" + (i % 4);
    await decidus.trace({ conversationId: conv }, () => route("where is my parcel"));
    sent.push([conv, lastSent().includes("order number")]);
  }
  for (const [conv, got] of sent) assert.equal(got, sent.find(x => x[0] === conv)[1], "one conversation, one version");
  const calls = await until(async () => { const c = (await api(P("/calls?q=v:4"))).calls; return c.length && c; });
  assert.ok(calls.length >= 3 && calls.length <= 9);
  const d = await api(P());
  assert.ok(d.compare[4].candidate.answers.shipping >= 3);

  await api(P("/stage"), { mode: "live" });
  const after = await api(P());
  assert.deepEqual([after.effective.n, after.candidates], [4, []]);
  // rollback is one click: any earlier version can go live again
  await api(P("/live"), { version: 2 });
  assert.equal((await api(P())).effective.n, 2);
});

test("auto-tune from a version, save a draft as a version, set traffic per version, read several texts at once", async () => {
  // v2 passes its decided cases: nothing to tune, and no draft left behind
  await assert.rejects(api(P("/tune"), { from: 2 }), /v2 already passes every decided case|nothing that beats v2/);
  assert.equal((await api(P())).draft, null);
  const live = await api(P("/view?v=live"));
  await api(P("/edit"), { parts: { description: live.edit.description + " Be brief." } });
  const { n } = await api(P("/save"), {});
  let d = await api(P());
  assert.deepEqual([d.draft, d.effective.n, d.versions.at(-1).n, d.versions.at(-1).log.origin], [null, 2, n, "hand"], "saved, with no traffic");
  assert.deepEqual((await api(P("/traffic"), { version: n, shadow: 20 })).candidates.map(c => [c.n, c.mode, c.pct]), [[n, "shadow", 20]]);
  await api(P("/traffic"), { version: n, traffic: 10 });
  d = await api(P());
  assert.deepEqual(d.candidates.map(c => [c.n, c.mode, c.pct]), [[n, "canary", 10]], "a canary needs no shadow");
  const t = await api(P(`/texts?v=0,2,${n},draft`));
  assert.deepEqual(Object.keys(t.texts), ["0", "2", String(n)]);
  assert.ok(t.texts[String(n)].merged.description.endsWith("Be brief."));
  await api(P("/stop"), { version: n });
  assert.deepEqual((await api(P())).candidates, []);
});

test("Anthropic forced tool with a boolean field becomes a bool policy", async () => {
  const r = await claude.messages.create({ model: "claude-haiku-4-5", max_tokens: 64,
    messages: [{ role: "user", content: "If this isn't fixed I'm calling my lawyer." }],
    tools: [{ name: "needs_human", description: "Should a person take over?", input_schema: { type: "object", properties: { needs_human: { type: "boolean" } }, required: ["needs_human"] } }],
    tool_choice: { type: "tool", name: "needs_human" } });
  assert.equal(r.content[0].input.needs_human, true);
  const d = await until(async () => (await api("/api/policies/needs_human.needs_human").catch(() => null)));
  assert.equal(d.policy.kind, "bool");
  assert.deepEqual(d.policy.options, ["true", "false"]);
  assert.equal(d.queue[0].answer, "true");
});

test("decidus down: calls go out exactly as written", async () => {
  const f = decidus.fetch({ baseUrl: "http://127.0.0.1:1", ttlMs: 0 });
  const o = new OpenAI({ apiKey: "sk-test", baseURL: mock + "/v1", fetch: f });
  const r = await o.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "user", content: "parcel late" }], tools: [tool()],
    tool_choice: { type: "function", function: { name: "route_conversation" } } });
  assert.equal(teamOf(r), "billing");
  assert.equal(lastSent(), DESC);
});
