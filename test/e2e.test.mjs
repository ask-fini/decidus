// End to end: real OpenAI + Anthropic TS SDKs -> decidus.fetch() -> mock provider,
// records -> decidus server -> decide -> suggest -> replay -> auto-tune -> accept -> next call carries v1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import * as decidus from "../dist/index.js";
import { createServer } from "../dist/server.js";

// ---------- a mock provider whose "model" only knows what the policy text tells it ----------
const seen = [];
let writerCalls = 0;
const KNOWS = [["charge", "billing"], ["crash", "technical"], ["parcel", "shipping"]];
function decide(description = "", text = "") {
  for (const [kw, team] of KNOWS) if (description.includes(kw) && text.includes(kw)) return team;
  return "billing";
}
const userText = b => JSON.stringify(b.messages ?? b.input ?? "");

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
    if (tool?.name === "write_policy") {                       // the suggestion writer
      writerCalls++;
      const fixing = body.messages[0].content.includes("still fail");
      const options = [
        { option: "billing", text: "duplicate or unexpected charges", cases: [1] },
        { option: "technical", text: "app crash or error on the device", cases: [2] },
        { option: "shipping", text: fixing ? "parcel delayed or stuck with the carrier" : "delivery problems", cases: [3] },
      ];
      return json({ id: "m", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", id: "tu", name: "write_policy", input: { options } }] });
    }
    return json({ id: "m", type: "message", role: "assistant", model: body.model, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: "tool_use", id: "tu", name: tool.name, input: { needs_human: userText(body).includes("lawyer") } }] });
  }
  res.writeHead(404); res.end();
});

let srv, base, mock, openai, claude;
const api = async (path, body) => {
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const until = async (f, ms = 3000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise(r => setTimeout(r, 30)); } };

const ROUTE_TOOL = { type: "function", function: { name: "route_conversation", description: "Which team should handle this conversation?",
  parameters: { type: "object", properties: { team: { type: "string", enum: ["billing", "technical", "shipping"] } }, required: ["team"] } } };
const route = content => openai.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "user", content }], tools: [ROUTE_TOOL],
  tool_choice: { type: "function", function: { name: "route_conversation" } } });
const teamOf = r => JSON.parse(r.choices[0].message.tool_calls[0].function.arguments).team;

before(async () => {
  await new Promise(r => provider.listen(0, r));
  mock = `http://127.0.0.1:${provider.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test"; process.env.ANTHROPIC_BASE_URL = mock;   // the suggestion writer
  process.env.DECIDUS_SUGGEST_MODEL = "anthropic/claude-sonnet-5-5";
  ({ server: srv } = createServer({ quiet: true }));
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

test("first sight: forced tool call becomes a v0 policy with its options; calls still answered", async () => {
  for (const [text] of TICKETS) assert.equal(teamOf(await route(text)), "billing");   // v0 model knows nothing
  const d = await until(async () => { const d = await api("/api/policies/route_conversation").catch(() => null); return d?.queue.length === 6 && d; });
  assert.deepEqual(d.policy.options, ["billing", "technical", "shipping"]);
  assert.equal(d.policy.field, "team");
  assert.deepEqual(d.effective, { n: 0, from: "" });
  assert.equal(d.policy.model, "gpt-5-mini");
  assert.ok(d.queue.every(c => c.version === 0 && c.answer === "billing" && c.scope === ""));
});

test("plain chat and unforced calls pass through without a record", async () => {
  const r = await openai.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }] });
  assert.equal(r.choices[0].message.content, "hi");
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await api("/api/overview")).length, 1);
});

test("decide, suggest, replay fails one, auto-tune fixes it, accept as v1", async () => {
  const d = await api("/api/policies/route_conversation");
  const byId = [...d.queue].sort((a, b) => a.id - b.id);
  for (const [i, c] of byId.entries()) await api(`/api/cases/${c.id}/decide`, { value: TICKETS[i][1] });

  const s = await api("/api/policies/route_conversation/suggest", { cases: byId.map(c => c.id) });
  assert.equal(s.base, 0);
  assert.match(s.text.billing, /charges/);

  const r1 = await api("/api/policies/route_conversation/replay", { target: "suggestion" });
  assert.equal(r1.filter(x => x.pass).length, 4, "the vague shipping wording should fail both parcel cases");

  const tuned = await api("/api/policies/route_conversation/tune", {});
  assert.match(tuned.text.shipping, /parcel/);
  assert.ok(tuned.replay.every(x => x.pass));
  assert.equal(tuned.tune.at(-1).pass, 6);
  assert.equal(writerCalls, 2);

  const { live } = await api("/api/policies/route_conversation/accept", {});
  assert.equal(live, 1);
  const after = await api("/api/policies/route_conversation");
  assert.equal(after.processed.length, 6);
  assert.ok(after.processed.every(c => c.used_in === 1));
  assert.equal(after.queue.length, 0);
  assert.deepEqual(after.agreement[0], { n: 6, agree: 2 }, "v0 said billing every time; people agreed twice");
});

test("after the cache refreshes, calls carry v1 and the model now gets it right", async () => {
  await route("warm-up: this call still uses the cached v0 and triggers a background refresh");
  await new Promise(r => setTimeout(r, 100));
  const r = await decidus.trace({ traceId: "tr_9f2c41", conversationId: "conv_8f2c1", metadata: { channel: "chat" } },
    () => route("My parcel never arrived"));
  assert.equal(teamOf(r), "shipping");
  const sent = seen.filter(s => s.path.endsWith("/chat/completions")).at(-1).body;
  assert.match(sent.tools[0].function.parameters.properties.team.description, /shipping: parcel delayed/);
  assert.deepEqual(sent.tools[0].function.parameters.properties.team.enum, ["billing", "technical", "shipping"]);

  const d = await until(async () => { const d = await api("/api/policies/route_conversation/calls"); return d.calls.length === 8 && d; });
  const last = await api(`/api/cases/${d.calls[0].id}`);
  assert.equal(last.version, 1);
  assert.equal(last.trace_id, "tr_9f2c41");
  assert.equal(last.conversation_id, "conv_8f2c1");
  assert.deepEqual(last.metadata, { channel: "chat" });
  assert.equal(last.request.tools[0].function.parameters.properties.team.description, undefined, "stored request is the code's own");
  assert.match(last.sent.tools[0].function.parameters.properties.team.description, /parcel/, "the view shows what was sent");
  assert.equal(JSON.stringify(last.headers).includes("sk-test"), false, "provider keys never recorded");
});

test("Anthropic forced tool with a boolean field becomes a bool policy", async () => {
  const r = await claude.messages.create({ model: "claude-haiku-4-5", max_tokens: 64,
    messages: [{ role: "user", content: "If this isn't fixed I'm calling my lawyer." }],
    tools: [{ name: "needs_human", description: "Should a person take over?", input_schema: { type: "object", properties: { needs_human: { type: "boolean" } }, required: ["needs_human"] } }],
    tool_choice: { type: "tool", name: "needs_human" } });
  assert.equal(r.content[0].input.needs_human, true);
  const d = await until(async () => (await api("/api/policies/needs_human").catch(() => null)));
  assert.equal(d.policy.kind, "bool");
  assert.deepEqual(d.policy.options, ["true", "false"]);
  assert.equal(d.queue[0].answer, "true");
});

test("Decidus down: calls go out exactly as written", async () => {
  const f = decidus.fetch({ baseUrl: "http://127.0.0.1:1", ttlMs: 0 });
  const o = new OpenAI({ apiKey: "sk-test", baseURL: mock + "/v1", fetch: f });
  const r = await o.chat.completions.create({ model: "gpt-5-mini", messages: [{ role: "user", content: "parcel late" }], tools: [ROUTE_TOOL],
    tool_choice: { type: "function", function: { name: "route_conversation" } } });
  assert.equal(teamOf(r), "billing");
  assert.equal(seen.at(-1).body.tools[0].function.parameters.properties.team.description, undefined);
});
