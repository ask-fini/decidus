// What counts as a decision in each provider's request shape, how policy text is written in, and how answers are read.
// The two `text.format` schemas are the shapes Fini's collector sends (descriptions trimmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, answers, decided, specs } from "../dist/shapes.js";

const brief = s => s.map(x => [x.name, x.kind, x.options.join("|")]);
const live = (name, version, text) => ({ [name]: { version, text } });

const SELECT_TAGS = { type: "json_schema", name: "select_tags", strict: true, schema: {
  type: "object", additionalProperties: false, required: ["reasoning", "chosen_tags"],
  properties: {
    reasoning: { type: "string" },
    chosen_tags: { type: "object", additionalProperties: false, required: ["Intent", "Topics"], properties: {
      Intent: { type: "string", enum: ["Refund", "Status"] },
      Topics: { type: "array", items: { type: "string", enum: ["Shipping"] } },
    } },
  } } };
const PLANNING = { type: "json_schema", name: "perform_planning", strict: true, schema: {
  type: "object", additionalProperties: false, required: ["reasoning", "perform_knowledge_search", "selected_rule"],
  properties: {
    reasoning: { type: "string" },
    perform_knowledge_search: { type: "boolean" },
    selected_rule: { anyOf: [{ type: "string", const: "Refund over 100 EUR" }, { type: "string", const: "Chargeback" }],
      description: "The name of the single rule that should be applied to this interaction." },
  } } };
const responses = format => ({ model: "gpt-6-sol", input: "Where is my refund?", text: { format } });
const responsesOut = obj => ({ id: "r", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(obj) }] }] });

test("Responses text.format: every fixed-choice field, nested too, is its own policy", () => {
  assert.deepEqual(brief(specs("responses", responses(SELECT_TAGS))), [
    ["select_tags.chosen_tags.Intent", "category", "Refund|Status"],
    ["select_tags.chosen_tags.Topics", "multi", "Shipping"],
  ]);
  assert.deepEqual(brief(specs("responses", responses(PLANNING))), [
    ["perform_planning.perform_knowledge_search", "bool", "true|false"],
    ["perform_planning.selected_rule", "category", "Refund over 100 EUR|Chargeback"],
  ]);
});

test("policy text goes into that field's description; the rest of the schema is untouched", () => {
  const body = responses(structuredClone(PLANNING));
  const used = apply("responses", body, live("perform_planning.selected_rule", 3, { Chargeback: "the customer says their bank reversed the payment", Other: "not offered in this call" }));
  assert.deepEqual(used, { "perform_planning.selected_rule": 3 });
  const p = body.text.format.schema.properties;
  assert.equal(p.selected_rule.description, "The name of the single rule that should be applied to this interaction.\n\nChargeback: the customer says their bank reversed the payment");
  assert.deepEqual(p.selected_rule.anyOf, PLANNING.schema.properties.selected_rule.anyOf);
  assert.deepEqual(p.perform_knowledge_search, { type: "boolean" });
  assert.equal(body.text.format.strict, true);
});

test("answers are read from the structured output; multi-select is a sorted set", () => {
  const out = responsesOut({ reasoning: "…", chosen_tags: { Intent: "Refund", Topics: ["Shipping"] } });
  const a = answers("responses", responses(SELECT_TAGS), out);
  assert.equal(a["select_tags.chosen_tags.Intent"].value, "Refund");
  assert.equal(a["select_tags.chosen_tags.Topics"].value, '["Shipping"]');
  assert.equal(answers("responses", responses(PLANNING), responsesOut({ perform_knowledge_search: false, selected_rule: "Chargeback" }))["perform_planning.perform_knowledge_search"].value, "false");
});

test("Chat Completions response_format, as on the Vertex path", () => {
  const body = { model: "vertex/gemini", messages: [{ role: "user", content: "hi" }], response_format: { type: "json_schema", json_schema: { name: "select_tags", schema: structuredClone(SELECT_TAGS.schema) } } };
  assert.deepEqual(specs("chat", body).map(s => s.name), ["select_tags.chosen_tags.Intent", "select_tags.chosen_tags.Topics"]);
  const res = { choices: [{ message: { role: "assistant", content: JSON.stringify({ chosen_tags: { Intent: "Status", Topics: [] } }) } }] };
  assert.equal(answers("chat", body, res)["select_tags.chosen_tags.Topics"].value, "[]");
  apply("chat", body, live("select_tags.chosen_tags.Topics", 1, { Shipping: "delivery, tracking, parcels" }));
  assert.equal(body.response_format.json_schema.schema.properties.chosen_tags.properties.Topics.description, "Shipping: delivery, tracking, parcels");
});

test("Pydantic-style schemas: $defs enums, Optional[...] and Literal", () => {
  const schema = { title: "Triage", type: "object", $defs: { Team: { enum: ["billing", "technical"], title: "Team", type: "string" } },
    properties: {
      team: { $ref: "#/$defs/Team", description: "Who handles it" },
      priority: { anyOf: [{ enum: ["low", "high"], type: "string" }, { type: "null" }], default: null },
      urgent: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      labels: { type: "array", items: { $ref: "#/$defs/Team" } },
    } };
  const body = { model: "gpt-6-sol", messages: [], response_format: { type: "json_schema", json_schema: { name: "Triage", schema } } };
  assert.deepEqual(brief(specs("chat", body)), [
    ["Triage.team", "category", "billing|technical"], ["Triage.priority", "category", "low|high"],
    ["Triage.urgent", "bool", "true|false"], ["Triage.labels", "multi", "billing|technical"],
  ]);
  apply("chat", body, live("Triage.team", 2, { billing: "money" }));
  const p = body.response_format.json_schema.schema.properties;
  assert.deepEqual(p.team, { enum: ["billing", "technical"], title: "Team", type: "string", description: "Who handles it\n\nbilling: money" }, "the $ref is copied in place");
  assert.deepEqual(p.labels.items, { $ref: "#/$defs/Team" }, "other uses of the def are untouched");
  assert.deepEqual(body.response_format.json_schema.schema.$defs.Team, { enum: ["billing", "technical"], title: "Team", type: "string" });
});

test("Anthropic output_config.format (and the older output_format) and Gemini response schemas", () => {
  const schema = { type: "object", properties: { intent: { type: "string", enum: ["refund", "status"] } } };
  const claude = { model: "claude-sonnet-5-5", max_tokens: 100, messages: [], output_config: { format: { type: "json_schema", schema } } };
  assert.deepEqual(specs("anthropic", claude).map(s => s.name), ["response.intent"]);
  assert.equal(answers("anthropic", claude, { content: [{ type: "text", text: '{"intent":"refund"}' }] })["response.intent"].value, "refund");
  assert.deepEqual(specs("anthropic", { messages: [], output_format: { type: "json_schema", schema: { ...schema, title: "Ticket" } } }).map(s => s.name), ["Ticket.intent"]);
  const gem = { contents: [], generationConfig: { responseMimeType: "application/json",
    responseSchema: { type: "OBJECT", properties: { intent: { type: "STRING", format: "enum", enum: ["refund", "status"] }, escalate: { type: "BOOLEAN" } } } } };
  assert.deepEqual(brief(specs("gemini", gem)), [["response.intent", "category", "refund|status"], ["response.escalate", "bool", "true|false"]]);
  assert.equal(answers("gemini", gem, { candidates: [{ content: { parts: [{ text: '{"intent":"status","escalate":true}' }] } }] })["response.escalate"].value, "true");
});

test("forced tool calls use the same field rules: tool name + field path", () => {
  const body = { model: "gpt-6-luna", messages: [], tool_choice: { type: "function", function: { name: "route" } },
    tools: [{ type: "function", function: { name: "route", parameters: { type: "object", properties: { team: { type: "string", enum: ["a", "b"] }, why: { type: "string" } } } } }] };
  assert.deepEqual(specs("chat", body).map(s => s.name), ["route.team"]);
  assert.deepEqual(specs("chat", { ...body, tool_choice: "auto" }), [], "not forced: not a decision");
});

test("not decisions: open strings, a single-value enum, objects inside arrays, JSON mode without a schema", () => {
  const schema = { type: "object", properties: { only: { type: "string", enum: ["x"] }, free: { type: "string" },
    rows: { type: "array", items: { type: "object", properties: { label: { enum: ["a", "b"] } } } } } };
  assert.deepEqual(specs("responses", { input: "", text: { format: { type: "json_schema", name: "s", schema } } }), []);
  assert.deepEqual(specs("chat", { messages: [], response_format: { type: "json_object" } }), []);
});

test("the name hook: fold generated keys into one policy, or leave a field alone", () => {
  const jev = { model: "jev-1", state: "…", questions: {
    a1_on_topic: { type: "noul", instructions: "Is article 1 on topic?", criteria: { true: "", false: "" } },
    a2_on_topic: { type: "noul", instructions: "Is article 2 on topic?", criteria: { true: "", false: "" } },
    broken: { type: "noul", instructions: "Is the rewrite broken?", criteria: {} } } };
  const fold = k => (k === "broken" ? null : k.replace(/\d+/g, "n"));
  assert.deepEqual(specs("systemone", jev, fold).map(s => [s.name, s.key]), [["an_on_topic", "a1_on_topic"], ["an_on_topic", "a2_on_topic"]]);
  const res = { answers: { a1_on_topic: { type: "noul", noul: 0.91 }, a2_on_topic: { type: "noul", noul: 0.3 } } };
  assert.deepEqual(decided("systemone", jev, res, fold).map(d => [d.key, d.answer.value]), [["a1_on_topic", "true"], ["a2_on_topic", "false"]]);
  const body = structuredClone(jev);
  apply("systemone", body, live("an_on_topic", 2, { true: "the article answers the customer's question" }), fold);
  assert.equal(body.questions.a1_on_topic.criteria.true, "the article answers the customer's question");
  assert.equal(body.questions.a2_on_topic.criteria.true, "the article answers the customer's question");
  assert.deepEqual(body.questions.broken.criteria, {});
});
