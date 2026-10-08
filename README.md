# decidus

**The open-source policy loop for decision models.**

Turn the decisions you review into the next policy you ship.

decidus records your model's choices and turns reviewed cases into proposed policy changes. Inspect the diff, replay those cases, and put the version you choose live without changing application code. One fetch wrapper connects to the SDK you already use.

Works with structured outputs and forced tool calls on OpenAI, Anthropic and Gemini, directly or through gateways such as LiteLLM and OpenRouter. Also supports the OpenAI Decisions API and TypeSafe Jev.

## Quick start

Requires Node.js 22.13 or newer.

Install decidus and start the local server:

```sh
npm install decidus
npx decidus serve
```

Add one option to your existing client:

```ts
import OpenAI from "openai";
import * as decidus from "decidus";

const openai = new OpenAI({ fetch: decidus.fetch() });
```

Make a supported decision call, then open [localhost:7700](http://localhost:7700). **Calls** shows your recorded decisions; **Queue** brings forward cases to review.

decidus discovers policies from your schema on the first call. There is nothing to register. The initial version, **v0**, is your code exactly as written. **Policy wording stays as written until you accept an update.**

To generate suggestions and replay cases, add the server's [provider or gateway keys](#keys-for-suggestions-and-replay).

## The policy loop

A **decision** picks from a fixed set of answers: which team should handle a conversation, which tags apply, or whether a refund needs approval. A **policy** is the wording that guides that choice.

decidus connects the answers you review to the policy that runs next:

1. **Review real cases.** Open a case in **Queue**, inspect its input and output, and choose the right answer. Tick several options for a multi-select decision, or press ✓ to agree with the model.
2. **Suggest a change.** In **Decided**, select reviewed cases and click **Suggest policy**. A model proposes a description for each option. You get a diff against the live policy, with each change linked to the cases behind it.
3. **Replay before accepting.** decidus sends each selected case to its recorded endpoint with the draft wording and compares the result with your answer. **Auto-tune** can revise wording for cases that still fail, for up to three rounds.
4. **Put it live.** Click **Accept**. Within 30 seconds, `decidus.fetch()` applies the new wording to matching requests in every process. No application code change is needed. To roll back, open an older version's tab and make it live again.

Use **Edit** to write the change yourself, on a suggestion or the live version. Replay your edit against the same cases before you accept it.

**Select all** uses up to 100 reviewed cases in the current scope, prioritizing disagreements with the model. The suggestion is written from, and replayed against, those same cases.

Policy updates change only text: a decision field's `description`, each Decisions choice's `description`, or a Jev question's `criteria`. Your options, tool names, schema structure and parsing code stay under your control.

## What counts as a decision

decidus recognizes fields that choose from a fixed set of answers. Each field becomes its own policy, named from your schema.

| Your call | Policy name |
| --- | --- |
| Structured output: OpenAI `responses.create({ text: { format } })` or `chat.completions.create({ response_format })`, Anthropic `output_config.format`, Gemini `responseSchema` | The schema name and field path, such as `select_tags.chosen_tags.Intent` |
| A function call forced to one tool, with `tool_choice` naming it | The tool name and field path, such as `route_conversation.team` |
| `openai.decisions.create({ questions: [{ name: "needs_human", ... }] })` | Each question's `name` |
| `typesafe.systemOne({ questions: { approve_refund: choice(...) } })` | Each question's key |

Supported fields include:

- `enum` values.
- `const` alternatives expressed with `anyOf` or `oneOf`.
- `boolean` values.
- Arrays of these values for multi-select decisions.

decidus finds these fields in nested objects and through `$ref`s. This covers schema shapes produced by Zod, Pydantic, `zodResponseFormat`, Vercel AI SDK's `generateObject` and LangChain's `withStructuredOutput`. Fields inside arrays of objects, such as a label for each extracted item, are not supported yet.

Free-text fields beside a decision, such as `reasoning`, are left alone. Chat, free text, embeddings and other calls pass through unchanged. Streamed decision calls receive the live policy, but are not recorded yet.

### Different options, one policy

Each call keeps its own options. Customers with different tags or rules can share a policy; its version only describes the options available in that call. Add or remove an option in your code and the policy follows.

### Rename or skip a policy

If generated field names split what should be one policy, map them to a shared name. Return `null` to skip a field:

```ts
decidus.fetch({
  name: (decision) => {
    if (decision.name.startsWith("articles_")) return "articles";
    if (decision.name === "plan.depth") return null;
    return decision.name;
  },
});
```

## Use your existing provider, gateway and SDK

The same fetch wrapper works with the other supported clients:

```ts
const claude = new Anthropic({ fetch: decidus.fetch() });
const gemini = new GoogleGenAI({
  apiKey,
  httpOptions: { fetch: decidus.fetch() },
});
const jev = new TypeSafeClient({ fetch: decidus.fetch() });
```

For a gateway such as LiteLLM, OpenRouter or Portkey, keep your existing URL and key:

```ts
const llm = new OpenAI({
  baseURL: process.env.LLM_GATEWAY_URL,
  apiKey: process.env.LLM_GATEWAY_KEY,
  fetch: decidus.fetch(),
});
```

For Vercel AI SDK and LangChain:

```ts
const openai = createOpenAI({ fetch: decidus.fetch() });
const model = new ChatOpenAI({
  configuration: { fetch: decidus.fetch() },
});
```

Your gateway keeps handling routing, retries and fallbacks. decidus sees the request and response. Wrappers such as Langfuse's `observeOpenAI` keep working on top, so you can add the policy loop alongside your existing tracing.

Python support is next.

## Choose what to review

**Queue** keeps review manageable as traffic grows. By default, a call is eligible when:

- The model is unsure: Decisions API or Jev confidence is below `0.80`, or a yes/no probability is between `0.20` and `0.80`.
- It is one of the first 20 calls for its policy in its scope.
- It falls in a 10% sample of the remaining calls. This helps surface confident mistakes and includes structured outputs and function calls, which do not report confidence.
- Its answer could not be read.

The queue shows **50 calls at a time**, rotating across answers, confidence bands, versions and scopes. Newer versions come first, with the newest calls first within each group. Each review brings in the next call.

**Calls** shows every recorded call, newest first. Search by message text, conversation, event or trace ID, or combine filters:

```text
answer:billing v:2 conf:<0.6 decided:no queue
```

You can review any call from there. The overview shows calls per day and how often reviewers agreed with each version.

**Review never blocks your app.** Queuing creates a copy of the call. It does not wait for a person or change the answer your code receives.

## Give customers or bots their own policies

By default, each policy has one global version. When customers or bots need different behavior, give their calls a **scope**:

```ts
await decidus.trace(
  { scope: `${companyId}/${botId}` },
  () => handleMessage(msg),
);
```

Scopes are paths. A call uses the version set for its exact scope, then its parent, then the global policy. For example, `acme/support-bot` inherits from `acme` until you accept a version for that bot. A new company starts with the global policy.

In the UI, choose a scope next to the policy name. The queue, reviewed decisions and calls narrow to that scope. **Suggest**, **Edit** and **Accept** use its cases and create a version for that scope only. Choose **Inherit instead** to remove its override and follow the parent again.

A client can also carry a fixed scope: `decidus.fetch({ scope: "acme" })`.

### Add IDs for search

Attach your own IDs and metadata to make calls easier to find. Only `scope` affects which policy runs:

```ts
decidus.trace(
  {
    scope,
    conversationId,
    eventId,
    traceId,
    metadata: { channel: "chat" },
  },
  fn,
);
```

You can also pass the scope and IDs through your SDK's extra headers: `x-decidus-scope`, `x-decidus-conversation-id`, `x-decidus-event-id` and `x-decidus-trace-id`. decidus removes these headers before the request leaves your process.

## How it runs

`decidus.fetch()` runs in your app's process. It applies the live policy text, sends the request to your provider or gateway, and copies the request and response to the decidus server in the background. Your app's provider keys are never sent to decidus.

The server serves the UI and stores calls, the queue and policy versions in one SQLite database.

### Keys for suggestions and replay

Set keys in the server's environment:

| Task | Server configuration |
| --- | --- |
| Write suggestions | At least one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` |
| Replay direct provider calls | The key for each provider your policies call: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `TYPESAFE_API_KEY` |
| Replay gateway calls | `DECIDUS_GATEWAY_URL`, matching the base URL your app uses, and `DECIDUS_GATEWAY_KEY` |

Replay sends the recorded call to the same endpoint with the draft policy wording. Give decidus its own gateway key with a budget so replay usage is tracked separately and the key can be revoked independently.

OpenAI is preferred for suggestions when several keys are set. To choose a model explicitly, set `DECIDUS_SUGGEST_MODEL=provider/model`, for example:

```sh
DECIDUS_SUGGEST_MODEL=openai/gpt-6.1-sol
```

Other examples are `anthropic/claude-sonnet-5-5` and `gemini/gemini-3.8-flash`. You can choose another model from any of those three providers.

### Share a server with your team

A hosted version at [decidus.ai](https://decidus.ai) is on the way. To share one queue now, run the server where your team can reach it:

```sh
DECIDUS_API_KEY=your-shared-key docker compose up -d
```

Or build and run the Docker image directly:

```sh
docker build -t decidus .
docker run -d -p 7700:7700 -v decidus:/data \
  -e DECIDUS_API_KEY=your-shared-key decidus
```

Set these variables in your app, using the same key:

```sh
DECIDUS_BASE_URL=https://decidus.internal.example.com
DECIDUS_API_KEY=your-shared-key
```

The UI asks for the shared key once. Also pass the server the provider or gateway keys it needs for suggestions and replay.

### If the server is unavailable

Your app keeps calling its provider or gateway. The fetch wrapper uses the last live policy it fetched. If it has never reached the server, it uses v0, leaving the request as your code wrote it.

Records that cannot be delivered are dropped.

## Configuration

### In your app

| Variable | Default | Purpose |
| --- | --- | --- |
| `DECIDUS_BASE_URL` | `http://localhost:7700`, or `https://api.decidus.ai` when `DECIDUS_API_KEY` is set | decidus server URL |
| `DECIDUS_API_KEY` | Unset | Shared server key |
| `DECIDUS_DISABLED` | Unset | Set to `1` to make `decidus.fetch()` a plain pass-through |

### On the server

| Variable | Default | Purpose |
| --- | --- | --- |
| `DECIDUS_API_KEY` | Unset | When set, requires the key for the API and UI |
| `DECIDUS_DB` or `--db` | `~/.decidus/decidus.db` | Database location |
| `PORT` or `--port` | `7700` | Server port |
| `DECIDUS_SUGGEST_MODEL` | `openai/gpt-6.1-sol`, otherwise a provider with a key set | Model for policy suggestions |
| `DECIDUS_WARMUP` | `20` | Initial calls per policy and scope eligible for review |
| `DECIDUS_SAMPLE_RATE` | `0.1` | Review sample rate after warmup |
| `DECIDUS_QUEUE_SIZE` | `50` | Calls shown in the queue at a time |
| `DECIDUS_MAX_CASES` | `100` | Maximum cases used to write and replay a suggestion |
| `DECIDUS_GATEWAY_URL` | Unset | Gateway base URL for replay |
| `DECIDUS_GATEWAY_KEY` | Unset | Sent to that gateway as `Authorization: Bearer <key>` during replay |
| `DECIDUS_RETENTION_DAYS` | `30` | After this many days, unreviewed calls keep their rows but lose input and output. Set to `0` to keep everything. |

Run `npx decidus reset` to delete the local database. Databases from version 0.1 are upgraded in place on first start.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `j` / `k` | Move between cases |
| `1`–`9` | Choose an answer |
| `Enter` | Agree with the model |
| `x` | Select a case under **Decided** |
| `/` | Search calls |

## Limits in 0.3

- Streamed decision calls receive the live policy, but are not recorded or queued.
- Replay authenticates to public provider APIs and one gateway. Direct replay to Azure OpenAI, Bedrock or Vertex is not supported yet; replay through a gateway is supported.
- Fixed-choice fields inside arrays of objects are not recognized as decisions yet.
- One server is one project. Everyone with its key can see every scope. Per-scope reviewer access is planned for the hosted version.
- Jev `score` questions pass through unmanaged.
- Node.js 22.13 or newer is required for the built-in `node:sqlite` module.

## Status and license

An experiment from the team at [Fini](https://usefini.com), who use it for their own support decisions.

MIT licensed.
