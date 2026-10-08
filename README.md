# decidus

The policy loop for decision models. People decide the cases your model wasn't sure about; decidus turns those decisions into the next version of the policy, replays it against them, and puts it live without a code change.

Works with structured outputs and forced function calls on OpenAI, Anthropic and Gemini, directly or through a gateway such as LiteLLM or OpenRouter, with the OpenAI Decisions API, and with TypeSafe Jev.

```bash
npm install decidus
npx decidus serve          # http://localhost:7700
```

Then one option on the client you already use:

```ts
import OpenAI from "openai";
import * as decidus from "decidus";

const openai = new OpenAI({ fetch: decidus.fetch() });
```

Open http://localhost:7700 and your decisions show up there.

Tracing tools such as Langfuse show and grade what your app did. decidus changes what your decision model does next.

## What counts as a decision

decidus only touches calls that are already decisions: the model picks from a fixed set of answers. Chat, free text, embeddings and everything else pass through untouched.

| Your call | Each policy is |
|---|---|
| Structured output: `responses.create({ text: { format } })`, `chat.completions.create({ response_format })`, Anthropic `output_config.format`, Gemini `responseSchema` | a fixed-choice field in the schema: `select_tags.chosen_tags.Intent` |
| A function call forced to one tool (`tool_choice` naming it) | a fixed-choice field in the tool's schema: `route_conversation.team` |
| `openai.decisions.create({ questions: [{ name: "needs_human", ... }] })` | each question's `name` |
| `typesafe.systemOne({ questions: { approve_refund: choice(...) } })` | each question's key |

A fixed-choice field is an `enum`, a set of `const` alternatives (`anyOf` / `oneOf`), a `boolean`, or an array of those (multi-select), at any depth, through `$ref`s. That covers what Zod, Pydantic, `zodResponseFormat`, Vercel AI SDK's `generateObject` and LangChain's `withStructuredOutput` produce. Free-text fields next to it (`reasoning`, ...) are left alone.

The first call creates the policy at **v0**, with its options read from your schema. There is nothing to register. v0 is your code exactly as written, and nothing changes until someone accepts a version.

Each call keeps its own options, so schemas that differ per customer (each with their own tags or rules) share one policy, and a version only describes the options a call actually offers.

Names come from your schema. When they don't make a good policy (keys generated per item, a field that isn't really a decision), rename or skip:

```ts
decidus.fetch({ name: d => d.name.startsWith("articles_") ? "articles" : d.name === "plan.depth" ? null : d.name })
```

## The loop

1. **Queue.** Calls worth a look land here with their full input and output. Pick the right answer (tick several for a multi-select), or press ✓ to agree with the model.
2. **Suggest.** Under *Decided*, select cases and click *Suggest policy*. A model writes the next version: one description per option, shown as a diff on the live version, each change tagged with the cases behind it.
3. **Replay.** The suggestion is sent to your provider once per case, with the new wording, and checked against what people decided. *Auto-tune* rewords what's still failing, up to three rounds.
4. **Accept.** From then on, `decidus.fetch()` writes the new wording into every matching request, within 30 seconds, in every process. Your code doesn't change. Any older version can be made live again from its tab.

*Edit* lets you change the wording yourself, on a suggestion or on the live version. An edit is replayed against the same cases before you accept it.

The policy is only ever text: the `description` of the decision field in your schema, the `description` of each Decisions choice, or the `criteria` of a Jev question. Your options, tool names, schema and parsing code stay yours. Add or remove an option in your code and the policy follows.

## Companies, bots and other scopes

If your app serves many customers, each can get its own version of a policy without forking your code. Tag calls with a scope, as a path:

```ts
await decidus.trace({ scope: `${companyId}/${botId}` }, () => handleMessage(msg));
```

A call runs the version set for its exact scope, else for its parent, else the global one. So `acme/support-bot` runs what `acme` runs until someone accepts a version for that bot; a new company runs the global policy from its first call. Without scopes, everything is global, which is what most teams want.

In the UI, pick a scope next to the policy name. The queue, decisions and calls narrow to that scope, and *Suggest*, *Edit* and *Accept* write a version for that scope only, built from its cases. *Inherit instead* drops a scope's own version so it follows its parent again.

Scopes decide which policy runs. To find calls later, pass your own ids, which never change the policy:

```ts
decidus.trace({ scope, conversationId, eventId, traceId, metadata: { channel: "chat" } }, fn)
```

Or per call, with your SDK's extra headers: `x-decidus-scope`, `x-decidus-conversation-id`, `x-decidus-event-id`, `x-decidus-trace-id`. decidus removes its own headers before the request leaves your process. A client can also carry a fixed scope: `decidus.fetch({ scope: "acme" })`.

## What goes to the queue

A call can be reviewed when:

- the model was unsure: Decisions API and Jev `confidence < 0.80`, or a yes/no probability between 0.20 and 0.80;
- it is one of the first 20 calls of its policy in its scope;
- it is in a 10% sample of the rest, so confident mistakes show up too, and so do structured outputs and function calls, which report no confidence;
- its answer couldn't be read.

At volume that's still too many for people, so the queue shows **50 at a time**, picked round-robin across answers, confidence bands, versions and scopes, newest first in each, newest versions first. Each decision pulls in the next. A million calls a month still reads as a representative 50.

Everything else is under **Calls**: every call, newest first, filtered with `answer:billing v:2 conf:<0.6 decided:no queue`, or by a conversation, event or trace id, or by words in the message. You can decide any call from there.

Keys: `j`/`k` move, `1`–`9` decide, `Enter` agrees with the model, `x` selects under *Decided*, `/` searches calls.

*Select all* under *Decided* suggests from up to 100 decided cases in the scope, disagreements with the model first. The overview shows calls per day and how often people agreed with each version.

Queuing is a copy. It never blocks the call, never waits for a person and never changes the answer your code receives.

## Other providers, gateways and SDKs

```ts
const claude = new Anthropic({ fetch: decidus.fetch() });
const gemini = new GoogleGenAI({ apiKey, httpOptions: { fetch: decidus.fetch() } });
const jev    = new TypeSafeClient({ fetch: decidus.fetch() });

// a gateway (LiteLLM proxy, OpenRouter, Portkey, ...): the same client, another baseURL
const llm = new OpenAI({ baseURL: process.env.LLM_GATEWAY_URL, apiKey: process.env.LLM_GATEWAY_KEY, fetch: decidus.fetch() });

// Vercel AI SDK, LangChain
const openai = createOpenAI({ fetch: decidus.fetch() });
const model  = new ChatOpenAI({ configuration: { fetch: decidus.fetch() } });
```

Wrappers such as Langfuse's `observeOpenAI` keep working on top. Calls through a gateway keep the gateway's routing, retries and fallbacks; decidus only sees the request and response.

Python is next.

## Where things run

`decidus.fetch()` runs in your process. It sends your request to your provider as before, with the live policy text written in, and copies the request and response to the decidus server in the background. Your provider keys are never sent to decidus.

The server holds the queue, the versions and the UI in one SQLite file. It needs keys in its environment:

- **To write suggestions:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`. With several, OpenAI is used. Pick one with `DECIDUS_SUGGEST_MODEL=provider/model`: `openai/gpt-6.1-sol` (default), `anthropic/claude-sonnet-5-5`, `gemini/gemini-3.8-flash`, or any other model of those three.
- **To replay:** replay sends a recorded call to the same endpoint again, with the draft wording. For providers, it uses their keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY`. Through a gateway, set `DECIDUS_GATEWAY_URL` (the base URL your app uses) and `DECIDUS_GATEWAY_KEY`. Give decidus its own gateway key with a budget, so replays are attributed and can be revoked separately.

A hosted version at decidus.ai is on the way. Until then, to share one queue with your team, run the server where they can reach it:

```bash
DECIDUS_API_KEY=... docker compose up -d      # or: docker build -t decidus . && docker run -p 7700:7700 -v decidus:/data ...
```

and in your app:

```bash
DECIDUS_BASE_URL=https://decidus.internal.example.com
DECIDUS_API_KEY=...                 # the same key; the UI asks for it once
```

## If decidus is down

Calls go out exactly as your code wrote them. The interceptor keeps the last live versions it fetched; if it never reached the server, it sends v0. Records that can't be delivered are dropped.

## Configuration

| Where | Variable | Default |
|---|---|---|
| your app | `DECIDUS_BASE_URL` | `http://localhost:7700` |
| your app | `DECIDUS_API_KEY` | unset |
| your app | `DECIDUS_DISABLED` | unset; `1` makes `decidus.fetch()` a plain pass-through |
| server | `DECIDUS_API_KEY` | unset; when set, the API and UI require it |
| server | `DECIDUS_DB` / `--db` | `~/.decidus/decidus.db` |
| server | `PORT` / `--port` | `7700` |
| server | `DECIDUS_SUGGEST_MODEL` | `openai/gpt-6.1-sol`, else the provider whose key is set |
| server | `DECIDUS_WARMUP`, `DECIDUS_SAMPLE_RATE` | `20` per scope, `0.1` |
| server | `DECIDUS_QUEUE_SIZE` | `50` |
| server | `DECIDUS_MAX_CASES` | `100`; most cases one suggestion is written from and replayed against |
| server | `DECIDUS_GATEWAY_URL`, `DECIDUS_GATEWAY_KEY` | unset; replay calls to that URL carry `Authorization: Bearer <key>` |
| server | `DECIDUS_RETENTION_DAYS` | `30`; after that, calls nobody decided keep their row but lose their input and output. `0` keeps everything |

`npx decidus reset` deletes the local database. A 0.1 database is upgraded in place on first start.

## Known limits in 0.3

- Streamed calls get the live policy, but aren't recorded, so they never reach the queue.
- Replay authenticates to the public provider APIs and to one gateway. Calling Azure OpenAI, Bedrock or Vertex directly isn't supported for replay yet; through a gateway it is.
- Fixed-choice fields inside arrays of objects (one label per extracted item) aren't decisions yet.
- One server is one project, and everyone with the key sees every scope. Per-scope reviewer access comes with the hosted version.
- Jev `score` questions pass through unmanaged.
- Requires Node 22.13 or newer (it uses the built-in `node:sqlite`).

## Status

An experiment from the team at [Fini](https://usefini.com), who run their own support decisions on it. MIT.
