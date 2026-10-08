// Fini's setup, end to end: the real OpenAI SDK pointed at a LiteLLM-style gateway (with its own key),
// structured outputs via responses.create({ text: { format } }) and chat.completions.create({ response_format }),
// Jev questions through the gateway's /v1/systemone, per-company scopes with different options per company,
// multi-select review, and replay back through the gateway.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import OpenAI from "openai";
import * as decidus from "../dist/index.js";
import { createServer } from "../dist/server.js";

const GW_KEY = "sk-gateway";
const seen = [];
// The "model" behind the gateway only knows what the policy text says: an option is picked when a word
// from its description appears in the input.
const rubric = d => Object.fromEntries((d ?? "").split("\n").map(l => l.match(/^([^:]+): (.+)$/)).filter(Boolean).map(m => [m[1], m[2]]));
const hits = (desc, input) => Object.entries(rubric(desc)).filter(([, t]) => t.toLowerCase().split(/\W+/).some(w => w.length > 3 && input.includes(w))).map(([o]) => o);
function answer(node, input) {
  if (node.type === "boolean") return hits(node.description, input).includes("true");
  if (node.type === "array") return hits(node.description, input).filter(o => node.items.enum.includes(o));
  const opts = node.enum ?? node.anyOf.map(a => a.const);
  return hits(node.description, input).find(o => opts.includes(o)) ?? opts[0];
}
function fill(schema, input) {
  const out = {};
  for (const [k, v] of Object.entries(schema.properties)) out[k] = v.type === "object" ? fill(v, input) : v.type === "string" && !v.enum ? "…" : answer(v, input);
  return out;
}

const gateway = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  seen.push({ path: req.url, auth: req.headers.authorization, body });
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== `Bearer ${GW_KEY}`) return json({ error: { message: "Authentication Error, invalid gateway key" } }, 401);
  if (req.url === "/v1/responses") {
    const out = fill(body.text.format.schema, JSON.stringify(body.input).toLowerCase());
    return json({ id: "resp_1", object: "response", created_at: 0, status: "completed", model: body.model,
      output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(out), annotations: [] }] }] });
  }
  if (req.url === "/v1/chat/completions") {
    const out = fill(body.response_format.json_schema.schema, JSON.stringify(body.messages).toLowerCase());
    return json({ id: "c", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(out) } }] });
  }
  if (req.url === "/v1/systemone") {
    const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) =>
      [k, { type: "noul", noul: Object.values(q.criteria ?? {}).some(t => t && body.state.toLowerCase().includes(t.split(" ")[0])) ? 0.95 : 0.1 }]));
    return json({ answers });
  }
  json({ error: { message: "not found" } }, 404);
});

let srv, base, gw, llm;
const api = async (path, body) => {
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const P = name => "/api/policies/" + encodeURIComponent(name);
const until = async (f, ms = 3000) => { const t = Date.now(); for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise(r => setTimeout(r, 30)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// per-company tag configuration, as Collector builds it from the database
const selectTags = (intents, topics) => ({ type: "json_schema", name: "select_tags", strict: true, schema: {
  type: "object", additionalProperties: false, required: ["reasoning", "chosen_tags"], properties: {
    reasoning: { type: "string" },
    chosen_tags: { type: "object", additionalProperties: false, required: ["Intent", "Topics"], properties: {
      Intent: { type: "string", enum: intents }, Topics: { type: "array", items: { type: "string", enum: topics } } } } } } });
const ACME = selectTags(["Refund", "Status"], ["Shipping", "Billing"]);
const GLOBEX = selectTags(["Cancel", "Status"], ["Returns"]);
const tag = (format, input, scope) => decidus.trace({ scope, conversationId: "conv_" + scope },
  () => llm.responses.create({ model: "gpt-6-sol", input, text: { format } })).then(r => JSON.parse(r.output_text).chosen_tags);
const sentTopics = () => seen.filter(s => s.path === "/v1/responses").at(-1).body.text.format.schema.properties.chosen_tags.properties.Topics.description;

before(async () => {
  await new Promise(r => gateway.listen(0, r));
  gw = `http://127.0.0.1:${gateway.address().port}`;
  for (const k of ["DECIDUS_GATEWAY_URL", "DECIDUS_GATEWAY_KEY", "OPENAI_API_KEY"]) delete process.env[k];
  ({ server: srv } = createServer({ quiet: true, warmup: 1000 }));
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
  llm = new OpenAI({ baseURL: gw + "/v1", apiKey: GW_KEY, maxRetries: 0, fetch: decidus.fetch({ baseUrl: base, ttlMs: 0 }) });
});
after(() => { srv.close(); gateway.close(); });

test("responses.create with text.format: each tag group is a policy; each call keeps its company's options", async () => {
  assert.deepEqual(await tag(ACME, "I want my money back, the parcel never came", "acme"), { Intent: "Refund", Topics: [] });
  assert.deepEqual(await tag(GLOBEX, "please cancel my plan", "globex"), { Intent: "Cancel", Topics: [] });
  const d = await until(async () => { const d = await api(P("select_tags.chosen_tags.Topics")); return d.queue.length === 2 && d; });
  assert.equal(d.policy.kind, "multi");
  assert.equal(d.policy.route, "responses");
  assert.equal(d.policy.field, "chosen_tags.Topics");
  const [acme, globex] = await Promise.all([...d.queue].sort((a, b) => a.id - b.id).map(c => api(`/api/cases/${c.id}`)));
  assert.deepEqual([acme.scope, acme.options, acme.answer], ["acme", ["Shipping", "Billing"], "[]"]);
  assert.deepEqual([globex.scope, globex.options], ["globex", ["Returns"]]);
  assert.equal(JSON.stringify(acme.headers).includes(GW_KEY), false, "the gateway key is never recorded");
  assert.ok((await api("/api/overview")).some(p => p.name === "select_tags.chosen_tags.Intent" && p.kind === "category"));
});

test("multi-select review, a company-only version, and the next call carries it", async () => {
  const d = await api(P("select_tags.chosen_tags.Topics") + "?scope=acme");
  const c = d.queue[0];
  await api(`/api/cases/${c.id}/decide`, { value: ["Shipping", "Billing", "Shipping"] });
  assert.equal((await api(`/api/cases/${c.id}`)).decision, '["Billing","Shipping"]', "a set, sorted");
  const s = await api(P("select_tags.chosen_tags.Topics") + "/edit", { scope: "acme", text: { Shipping: "parcel never arrived or late", Billing: "money back or wrong charge" } });
  assert.deepEqual(s.cases, [c.id]);
  assert.equal((await api(P("select_tags.chosen_tags.Topics") + "/accept", { scope: "acme" })).live, 1);

  await tag(ACME, "warm up", "acme"); await sleep(80);
  assert.deepEqual((await tag(ACME, "I want my money back, the parcel never came", "acme")).Topics, ["Shipping", "Billing"]);
  assert.equal(sentTopics(), "Shipping: parcel never arrived or late\nBilling: money back or wrong charge");
  await tag(GLOBEX, "the parcel never came", "globex");
  assert.equal(sentTopics(), undefined, "globex has no version: its call goes out as written");
  const g = await api(P("select_tags.chosen_tags.Topics") + "?scope=globex");
  assert.deepEqual(g.effective, { n: 0, from: "" });
});

test("replay goes back through the gateway, with the gateway key the server holds", async () => {
  let r = await api(P("select_tags.chosen_tags.Topics") + "/replay", { scope: "acme", target: 1 });
  assert.match(r[0].error, /invalid gateway key/, "without DECIDUS_GATEWAY_KEY the gateway refuses");
  Object.assign(process.env, { DECIDUS_GATEWAY_URL: gw, DECIDUS_GATEWAY_KEY: GW_KEY });
  r = await api(P("select_tags.chosen_tags.Topics") + "/replay", { scope: "acme", target: 1 });
  assert.deepEqual(r.map(x => [x.pass, x.model]), [[true, '["Billing","Shipping"]']]);
  const last = seen.at(-1);
  assert.equal(last.path, "/v1/responses");
  assert.equal(last.auth, `Bearer ${GW_KEY}`);
  assert.match(last.body.text.format.schema.properties.chosen_tags.properties.Topics.description, /Billing: money back/);
});

test("chat.completions with response_format (the Vertex path) lands on the same policies", async () => {
  const r = await decidus.trace({ scope: "acme" }, () => llm.chat.completions.create({ model: "vertex/gemini-3.8-flash",
    messages: [{ role: "user", content: "the parcel never came" }],
    response_format: { type: "json_schema", json_schema: { name: "select_tags", strict: true, schema: ACME.schema } } }));
  assert.deepEqual(JSON.parse(r.choices[0].message.content).chosen_tags.Topics, ["Shipping"], "acme's v1 reached the Chat path too");
  const calls = await until(async () => { const c = (await api(P("select_tags.chosen_tags.Topics") + "/calls")).calls; return c[0]?.model === "vertex/gemini-3.8-flash" && c; });
  assert.equal(calls[0].version, 1);
});

test("Jev through the gateway: generated question keys folded into one policy by the name hook", async () => {
  const jev = decidus.fetch({ baseUrl: base, ttlMs: 0, name: d => d.name.replace(/\d+/g, "n") });
  const ask = state => jev(gw + "/v1/systemone", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${GW_KEY}` },
    body: JSON.stringify({ model: "jev-2", state, questions: {
      a1_on_topic: { type: "noul", instructions: "Is article 1 on topic?", criteria: { true: "", false: "" } },
      a2_on_topic: { type: "noul", instructions: "Is article 2 on topic?", criteria: { true: "", false: "" } } } }) }).then(r => r.json());
  await ask("How do I reset my password?");
  const d = await until(async () => { const d = await api(P("an_on_topic")); return d.queue.length === 2 && d; });
  assert.deepEqual(d.queue.map(c => c.answer), ["false", "false"]);
  await api(P("an_on_topic") + "/edit", { text: { true: "password resets, login problems" } });
  await api(P("an_on_topic") + "/accept", {});
  await ask("warm up"); await sleep(80);
  const r = await ask("password reset link expired");
  assert.deepEqual([r.answers.a1_on_topic.noul, r.answers.a2_on_topic.noul], [0.95, 0.95], "the folded policy was written into both questions");
  const sent = seen.filter(s => s.path === "/v1/systemone").at(-1).body.questions;
  assert.equal(sent.a1_on_topic.criteria.true, "password resets, login problems");
  assert.equal(sent.a2_on_topic.criteria.true, "password resets, login problems");
  const v1 = await until(async () => (await api(P("an_on_topic") + "/calls?q=v:1")).calls.length === 2 && (await api(P("an_on_topic") + "/calls?q=v:1")).calls);
  const full = await api(`/api/cases/${v1[0].id}`);
  assert.equal(full.spec, "a2_on_topic");
  assert.equal(full.sent.questions.a2_on_topic.criteria.true, "password resets, login problems");
});
