// What counts as a decision in each provider's request shape, what its text is, how a version is
// merged into it, and how answers are read. The two `text.format` schemas are shaped like Fini's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, answers, decided, evidence, specs, textParts } from "../dist/shapes.js";
import { diff, norm, patch, rebase, split } from "../dist/clauses.js";

const brief = s => s.map(x => [x.name, x.kind, x.options.join("|")]);
const slotsOf = text => split(text).map(norm).map(key => ({ key, fixed: null }));
/** A version whose edits turn `from` into `to` for one part. */
const version = (name, n, part, from, to) => ({ [name]: { version: n, ops: { [part]: diff(slotsOf(from), to) } } });

const SELECT_TAGS = { type: "json_schema", name: "select_tags", strict: true, schema: {
  type: "object", additionalProperties: false, required: ["reasoning", "chosen_tags"],
  properties: {
    reasoning: { type: "string", description: "Why these tags." },
    chosen_tags: { type: "object", additionalProperties: false, required: ["Intent", "Topics"], properties: {
      Intent: { type: "string", enum: ["Refund", "Status"], description: "The customer's intent. Select exactly one option." },
      Topics: { type: "array", description: "Topics. Select all applicable options.", items: { type: "string", enum: ["Shipping"], description: "Options: 'Shipping' — parcels and delivery." } },
    } },
  } } };
const PLANNING = { type: "json_schema", name: "perform_planning", strict: true, schema: {
  type: "object", additionalProperties: false, required: ["reasoning", "perform_knowledge_search", "selected_rule"],
  properties: {
    reasoning: { type: "string" },
    perform_knowledge_search: { type: "boolean" },
    selected_rule: { anyOf: [{ type: "string", const: "Refund over 100 EUR" }, { type: "string", const: "Chargeback" }],
      description: "The name of the single rule that should be applied to this interaction. Legacy: prefer Chargeback for VIPs." },
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

test("a decision's text: the field description, and the items description of a multi-select", () => {
  assert.deepEqual(textParts("responses", responses(SELECT_TAGS), "select_tags.chosen_tags.Topics"),
    { description: "Topics. Select all applicable options.", "items.description": "Options: 'Shipping' — parcels and delivery." });
  assert.deepEqual(textParts("responses", responses(PLANNING), "perform_planning.perform_knowledge_search"), { description: "" }, "no description yet: an empty part to write into");
});

test("a version is merged into the field's description; options and the rest of the schema are untouched", () => {
  const body = responses(structuredClone(PLANNING));
  const from = PLANNING.schema.properties.selected_rule.description;
  const used = apply("responses", body, version("perform_planning.selected_rule", 3, "description", from,
    "The name of the single rule that should be applied to this interaction. Chargeback: the customer says their bank reversed the payment."));
  assert.deepEqual(used, { versions: { "perform_planning.selected_rule": 3 }, retired: {} });
  const p = body.text.format.schema.properties;
  assert.equal(p.selected_rule.description, "The name of the single rule that should be applied to this interaction. Chargeback: the customer says their bank reversed the payment.");
  assert.deepEqual(p.selected_rule.anyOf, PLANNING.schema.properties.selected_rule.anyOf);
  assert.deepEqual(p.perform_knowledge_search, { type: "boolean" });
  assert.equal(body.text.format.strict, true);
});

test("three-way: the code's other changes come through; when it changes a clause the version edits, the code wins", () => {
  const from = PLANNING.schema.properties.selected_rule.description;
  const live = version("perform_planning.selected_rule", 2, "description", from, "The name of the single rule that should be applied to this interaction. Prefer Chargeback when the bank reversed a payment.");
  const changed = structuredClone(PLANNING);
  changed.schema.properties.selected_rule.description = "Pick the single rule for this interaction. Legacy: prefer Chargeback for VIPs.";
  let body = responses(structuredClone(changed));
  assert.deepEqual(apply("responses", body, live).versions, { "perform_planning.selected_rule": 2 });
  assert.equal(body.text.format.schema.properties.selected_rule.description, "Pick the single rule for this interaction. Prefer Chargeback when the bank reversed a payment.",
    "the code's new first sentence, decidus's rewrite of the second");

  changed.schema.properties.selected_rule.description = "The name of the single rule that should be applied to this interaction. Legacy: prefer Chargeback for VIP and gold customers.";
  body = responses(structuredClone(changed));
  assert.deepEqual(apply("responses", body, live).retired, { "perform_planning.selected_rule": 2 }, "both edits anchored on that clause are skipped");
  assert.equal(body.text.format.schema.properties.selected_rule.description, changed.schema.properties.selected_rule.description, "code wins");
});

test("clauses: split joins back exactly; fixed text survives any edit; rebase keeps decidus's text", () => {
  const t = "Intro.\n- 'A' — first; 'B' — second\n\nOutro! Done?";
  assert.equal(split(t).join(""), t);
  const slots = [{ key: "Intro.", fixed: null }, { key: "Article one.", fixed: 1 }, { key: "Article one, more.", fixed: 1 }, { key: "Outro.", fixed: null }];
  const ops = diff(slots, "Shorter intro. ⟦1⟧ Outro. Ask if unsure.");
  assert.equal(patch("Intro. Article two. Outro.", ops).text, "Shorter intro. Article two. Outro. Ask if unsure.", "another call's article stays in place");
  assert.deepEqual(diff(slots, "Intro. Outro."), [], "a dropped marker doesn't delete fixed text");

  const was = ["Pick one.", "Billing handles charges."], now = ["Pick one.", "Billing handles all charges."];
  const mine = diff(slotsOf("Pick one. Billing handles charges."), "Pick one. Billing handles charges and refunds.");
  assert.deepEqual(patch("Pick one. Billing handles all charges.", mine).retired, [0]);
  assert.equal(patch("Pick one. Billing handles all charges.", rebase(mine, was, now)).text, "Pick one. Billing handles charges and refunds.");
});

test("answers are read from the structured output; multi-select is a sorted set; free text comes along", () => {
  const out = responsesOut({ reasoning: "The parcel is late.", chosen_tags: { Intent: "Refund", Topics: ["Shipping"] } });
  const a = answers("responses", responses(SELECT_TAGS), out);
  assert.equal(a["select_tags.chosen_tags.Intent"].value, "Refund");
  assert.equal(a["select_tags.chosen_tags.Topics"].value, '["Shipping"]');
  assert.deepEqual(evidence("responses", responses(SELECT_TAGS), out, "select_tags.chosen_tags.Intent").said, { reasoning: "The parcel is late." }, "enum answers aren't free text");
  assert.equal(answers("responses", responses(PLANNING), responsesOut({ perform_knowledge_search: false, selected_rule: "Chargeback" }))["perform_planning.perform_knowledge_search"].value, "false");
});

test("Chat Completions response_format, as on the Vertex path", () => {
  const body = { model: "vertex/gemini", messages: [{ role: "user", content: "hi" }], response_format: { type: "json_schema", json_schema: { name: "select_tags", schema: structuredClone(SELECT_TAGS.schema) } } };
  assert.deepEqual(specs("chat", body).map(s => s.name), ["select_tags.chosen_tags.Intent", "select_tags.chosen_tags.Topics"]);
  const res = { choices: [{ message: { role: "assistant", content: JSON.stringify({ chosen_tags: { Intent: "Status", Topics: [] } }) } }] };
  assert.equal(answers("chat", body, res)["select_tags.chosen_tags.Topics"].value, "[]");
  apply("chat", body, version("select_tags.chosen_tags.Topics", 1, "items.description", "Options: 'Shipping' — parcels and delivery.", "Options: 'Shipping' — delivery, tracking, parcels."));
  const topics = body.response_format.json_schema.schema.properties.chosen_tags.properties.Topics;
  assert.equal(topics.items.description, "Options: 'Shipping' — delivery, tracking, parcels.");
  assert.equal(topics.description, "Topics. Select all applicable options.");
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
  apply("chat", body, version("Triage.team", 2, "description", "Who handles it", "Who handles it. Billing: money."));
  const p = body.response_format.json_schema.schema.properties;
  assert.deepEqual(p.team, { enum: ["billing", "technical"], title: "Team", type: "string", description: "Who handles it. Billing: money." }, "the $ref is copied in place");
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

test("Jev: string instructions and criteria are text; an article card or examples never are", () => {
  const article = { title: "Reset your password", folder: "Account", keywords: ["password", "login"] };
  const jev = { model: "jev-1", state: "…", questions: {
    a7_on_topic: { type: "noul", instructions: { question: "Is this article (`article`) about what the customer asks?", article },
      criteria: { true: "The article covers the subject.", false: "A different subject." } },
    rule_1: { type: "noul", instructions: { question: "Does `draft_reply` violate this rule?", rule_name: "No escalation status", rule: "Never reveal escalation states.", examples: ["…"] },
      criteria: { true: "Violates.", false: "Complies." } },
    articles_1: { type: "choice", instructions: "Which article helps?", criteria: { a1: article, none: "No article helps." } } } };
  assert.deepEqual(Object.keys(textParts("systemone", jev, "a7_on_topic")), ["instructions.question", "criteria.true", "criteria.false"]);
  assert.deepEqual(Object.keys(textParts("systemone", jev, "rule_1")), ["instructions.question", "instructions.rule_name", "instructions.rule", "criteria.true", "criteria.false"]);
  assert.deepEqual(textParts("systemone", jev, "articles_1"), { instructions: "Which article helps?", "criteria.none": "No article helps." });
  assert.match(evidence("systemone", jev, {}, "a7_on_topic").about, /Reset your password/, "the card is what this question is about");

  const body = structuredClone(jev);
  apply("systemone", body, version("a7_on_topic", 2, "criteria.true", "The article covers the subject.", "The article covers the subject, even if the customer asks about more."));
  assert.equal(body.questions.a7_on_topic.criteria.true, "The article covers the subject, even if the customer asks about more.");
  assert.deepEqual(body.questions.a7_on_topic.instructions.article, article);
});

test("the name hook: fold generated keys into one policy, or leave a field alone", () => {
  const jev = { model: "jev-1", state: "…", questions: {
    a1_on_topic: { type: "noul", instructions: "Is article 1 on topic?", criteria: { true: "", false: "" } },
    a2_on_topic: { type: "noul", instructions: "Is article 2 on topic?", criteria: { true: "", false: "" } },
    broken: { type: "noul", instructions: "Is the rewrite broken?", criteria: {} } } };
  const fold = k => (k === "broken" ? null : k.replace(/\d+/g, "n"));
  assert.deepEqual(specs("systemone", jev, fold).map(s => [s.name, s.key]), [["an_on_topic", "a1_on_topic"], ["an_on_topic", "a2_on_topic"]]);
  const res = { answers: { a1_on_topic: { type: "noul", noul: 0.91, reasoning: "Same subject." }, a2_on_topic: { type: "noul", noul: 0.3 } } };
  assert.deepEqual(decided("systemone", jev, res, fold).map(d => [d.key, d.answer.value]), [["a1_on_topic", "true"], ["a2_on_topic", "false"]]);
  assert.deepEqual(evidence("systemone", jev, res, "a1_on_topic").said, { reasoning: "Same subject." });
  const body = structuredClone(jev);
  apply("systemone", body, { an_on_topic: { version: 2, ops: { "criteria.true": [{ op: "insert", after: null, before: null, text: "the article answers the customer's question" }] } } }, fold);
  assert.equal(body.questions.a1_on_topic.criteria.true, "the article answers the customer's question");
  assert.equal(body.questions.a2_on_topic.criteria.true, "the article answers the customer's question");
  assert.deepEqual(body.questions.broken.criteria, {});
});

test("OpenAI Decisions: the instructions and each choice's description", () => {
  const body = { model: "gpt-6-luna", input: "…", questions: [{ type: "choice", name: "triage", instructions: "Which queue?", choices: [{ value: "a", description: "Money." }, { value: "b" }] }] };
  assert.deepEqual(textParts("decisions", body, "triage"), { instructions: "Which queue?", "choices.a": "Money.", "choices.b": "" });
  apply("decisions", body, { triage: { version: 1, ops: { "choices.b": [{ op: "insert", after: null, before: null, text: "Crashes." }] } } });
  assert.deepEqual(body.questions[0].choices, [{ value: "a", description: "Money." }, { value: "b", description: "Crashes." }]);
});

test("clauses: repeated text and numbered lists keep each edit where it was made", () => {
  const code = "Answer true if:\n1. The customer wants a refund.\n2. The order is late.\nAnswer false if:\n1. The customer only asks.\n2. Otherwise.";
  assert.deepEqual(split("1. A. 2. B.").map(c => c.trim()), ["1. A.", "2. B."], "a list number stays with its item");
  const target = code.replace("2. Otherwise.", "2. Otherwise.\n3. The customer asks to cancel.");
  assert.equal(patch(code, diff(slotsOf(code), target)).text, target);
  const rep = "A. B. A.";
  assert.equal(patch(rep, diff(slotsOf(rep), "A. B. Z.")).text, "A. B. Z.", "the second A, not the first");
});

test("clauses: a multi-line insert keeps its lines; text can go before a leading fixed run", () => {
  const code = "Pick the intent.\n- billing: invoices";
  const target = "Pick the intent.\n- billing: invoices\n- refund: money back\n- other: anything else";
  assert.equal(patch(code, diff(slotsOf(code), target)).text, target);
  const slots = [{ key: "Article one.", fixed: 1 }, { key: "Answer true if late.", fixed: null }];
  const ops = diff(slots, "Be strict. ⟦1⟧ Answer true if late.");
  assert.deepEqual(ops, [{ op: "insert", after: null, before: null, start: true, text: "Be strict." }]);
  assert.equal(patch("Article two. Answer true if late.", ops).text, "Be strict. Article two. Answer true if late.");
});

test("deleting the last clause of a paragraph keeps the paragraph break", async () => {
  const { patch } = await import("../dist/clauses.js");
  const text = "Pick one. Old note.\n\nCustomer: Maya.\nOptions: A; B.";
  assert.equal(patch(text, [{ op: "delete", clause: "Old note." }]).text, "Pick one.\n\nCustomer: Maya.\nOptions: A; B.");
  // a replaced clause keeps its own place
  assert.equal(patch(text, [{ op: "replace", clause: "Old note.", text: "New note." }]).text, "Pick one. New note.\n\nCustomer: Maya.\nOptions: A; B.");
  // so does text inserted after it
  assert.equal(patch(text, [{ op: "delete", clause: "Old note." }, { op: "insert", after: "Old note.", before: null, text: "Ignore greetings." }]).text, "Pick one. Ignore greetings.\n\nCustomer: Maya.\nOptions: A; B.");
  // a list's last line: the blank line before the next paragraph stays
  assert.equal(patch("Rules:\n- a.\n- Old rule.\n\nOtherwise no.", [{ op: "delete", clause: "- Old rule." }]).text, "Rules:\n- a.\n\nOtherwise no.");
});
