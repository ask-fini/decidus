# Decidus

**The open-source policy loop for decision models.**

Turn the decisions you review into the next policy you ship.

Decidus records your model's choices and turns reviewed cases into policy drafts. Inspect the changes, replay real cases, and try a version on live traffic before rolling it out. One fetch wrapper connects to your existing SDK; your application code stays the same.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/ask-fini/decidus/main/docs/decidus-loop-light.gif">
    <img src="https://raw.githubusercontent.com/ask-fini/decidus/main/docs/decidus-loop-dark.gif" width="720" alt="Review a decision, generate and replay a policy draft, then give the new version live traffic.">
  </picture>
</p>

Works with structured outputs and forced tool calls on OpenAI, Anthropic and Gemini, directly or through gateways such as LiteLLM and OpenRouter. Also supports the OpenAI Decisions API and TypeSafe Jev.

## Quick start

Requires Node.js 22.13 or newer.

Install Decidus and start the local server:

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

Make a [supported decision call](#what-counts-as-a-decision), then open [localhost:7700](http://localhost:7700):

- **Invocations** shows your recorded decisions, with their inputs and outputs.
- **To review** highlights cases that need attention.

Decidus discovers policies from your schema on the first call. There is nothing to register. The initial version, **v0**, uses your code's text as written. **Policy edits only affect your app's calls when you give a version traffic.**

To generate drafts, replay cases or run shadow versions, add the server's [provider or gateway keys](#keys-for-drafts-replay-and-shadow).

## The policy loop

A **decision** picks from a fixed set of answers: which team handles a conversation, which tags apply, or whether a refund needs approval. Its **policy** is the text that guides that choice, such as a field description, question instructions or criteria.

As exceptions accumulate, that text can become hard to maintain. Decidus helps you rewrite and simplify it using cases people have reviewed.

### 1. Review real cases

Open a call in **Invocations** or **To review**. Inspect the input and output, then choose the right answer. Tick several options for a multi-select decision, or press ✓ to agree with the model.

The model's free-text output, such as `reasoning`, is visible to reviewers and included with the cases used to generate drafts.

### 2. Generate a draft

In **Decided**, select reviewed cases and click **Generate draft**. A model rewrites the decision's text, using up to 40 cases at a time and prioritizing disagreements with the model.

The policy pane displays the text as JSON:

- **Diff** compares it with the version it was built on. The cases behind each change appear on the right.
- **Tuneable** shows which text Decidus can change. Text supplied dynamically by your code is greyed out and locked.
- **Edit** lets you write the changes yourself.
- **Save as vN** keeps the draft as a version without sending it any traffic.

### 3. Replay for accuracy

Replay runs up to 300 reviewed cases against a version, using the current scope (global by default). Each case goes to its recorded endpoint with the candidate text. Decidus compares the answer with the reviewer's choice and shows an accuracy score, such as **91% · 219 of 240**.

This score measures agreement with those reviewed cases. Failures are warnings; they do not block you from using a version.

**Auto-tune** revises the draft for cases that still fail, for up to three rounds. If you start from a saved version, Auto-tune first creates a draft from it.

### 4. Try it on live traffic

Each saved version shows its traffic and shadow percentages. Click a percentage to change it:

| Mode | What happens | What your app receives |
| --- | --- | --- |
| **Traffic** | The version handles a share of conversations | That version's answer |
| **Shadow** | The server re-runs a share of calls with the candidate version and records both answers | The answer already selected by normal traffic routing; the shadow answer does not replace it |

Traffic stays on the same version within a `conversationId`. Without one, the version is chosen randomly per call. Several versions can run at once, each with its own share; the live version keeps the remaining traffic.

Each call is re-run by at most one shadow version. Under each version, you can see how often it agrees with your reviewed answers. Shadows also show how often their answers differ from the original; click that number to inspect the calls.

### 5. Roll out or roll back

Give a version **100% traffic** to make it live. Within 30 seconds, `decidus.fetch()` applies it to matching requests in every process. To roll back, give an older version 100%.

**Copy** exports any version as it would be sent for your newest call, so you can move the text into your code if you want.

## What Decidus can change

A version stores edits to the decision's text, clause by clause, relative to what your code sends.

| Decision type | Text that can be edited |
| --- | --- |
| Schema field | Its `description`, plus `items.description` for a multi-select |
| Jev question | `instructions`, including strings inside an instructions object, and each string criterion |
| OpenAI Decisions question | `instructions` and each choice's or level's `description` |

Option values, tool names and schema structure stay under your control. Objects such as article cards and arrays such as examples are not rewritten.

### Stable text is tuneable; per-call context is locked

Decidus learns which parts of the text are stable by observing calls, one sentence or line at a time. By default, it samples the first **20 calls for a policy in a scope** before tuning starts.

After that, text is **tuneable** when nearly every recent call in the scope includes it. Text that varies by call is **locked**. The writer receives locked text as context for each case, and the **Tuneable** view marks it with a lock.

This distinction is specific to each scope. A company's tag descriptions may vary across companies, so they stay locked in the global policy. Within that company's scope, the same descriptions can be stable and tuneable.

### Your code can keep changing

On every call, Decidus merges the active version's edits into the text your code sends now. New or rewritten clauses that the version does not edit pass through as written.

If your code and the version both change the same clause, **your code wins**. Decidus skips that edit and shows a conflict warning. **Rebase** reapplies the version's edits to your updated text and creates a new live version.

## What counts as a decision

Decidus recognizes fields that choose from a fixed set of answers. Each field becomes its own policy, named from your schema.

| Your call | Policy name |
| --- | --- |
| Structured output: OpenAI `responses.create({ text: { format } })` or `chat.completions.create({ response_format })`, Anthropic `output_config.format`, Gemini `responseSchema` | Schema name and field path, such as `select_tags.chosen_tags.Intent` |
| A function call forced to one tool, with `tool_choice` naming it | Tool name and field path, such as `route_conversation.team` |
| `openai.decisions.create({ questions: [{ name: "needs_human", ... }] })` | Each question's `name` |
| `typesafe.systemOne({ questions: { approve_refund: choice(...) } })` | Each question's key |

Supported fields include `enum`, `boolean`, `const` alternatives expressed with `anyOf` or `oneOf`, and arrays of these values for multi-select decisions.

Decidus finds these fields in nested objects and through `$ref`s. This covers schema shapes produced by Zod, Pydantic, `zodResponseFormat`, Vercel AI SDK's `generateObject` and LangChain's `withStructuredOutput`. Fields inside arrays of objects, such as a label for each extracted item, are not supported yet.

Free-text fields beside a decision, such as `reasoning`, are recorded for reviewers and the draft writer, but never tuned. Calls without a fixed-choice field, including chat, generation-only structured outputs and embeddings, pass through unchanged and are not recorded. Streamed decision calls receive the live policy, but are not recorded yet.

### Different options, one policy

Each call keeps its own options. Customers with different tags or rules can share a policy: text that varies across their calls stays locked in the shared policy, while each customer's scope can tune its own stable text. Add or remove an option in your code and the policy follows.

### Rename or skip a policy

Map generated field names to a shared name when they represent the same decision. Return `null` to skip a field:

```ts
decidus.fetch({
  name: (decision) => {
    if (decision.name.startsWith("articles_")) return "articles";
    if (decision.name === "plan.depth") return null;
    return decision.name;
  },
});
```

For names whose meaning changes by call, assign a stable ID where you build the request. For example, `rule_1` might refer to a different guardrail for each customer:

```ts
await decidus.trace(
  { names: { rule_1: `guardrail_${rule.id}` } },
  () => jev.systemOne({ state, questions: { rule_1: guardrail(rule) } }),
);
```

Using the rule's database UUID gives each rule its own policy, allowing its stable text to become tuneable.

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

Your gateway keeps handling routing, retries and fallbacks. Decidus sees the request and response. Wrappers such as Langfuse's `observeOpenAI` keep working on top, so you can add the policy loop alongside your existing tracing.

Python support is next.

## Choose what to review

By default, a call is eligible for **To review** when:

- The model is unsure: Decisions API or Jev confidence is below `0.80`, or a yes/no probability is between `0.20` and `0.80`.
- It is one of the first 20 calls for its policy in its scope.
- It falls in a 10% sample of the remaining calls. This helps surface confident mistakes and includes structured outputs and function calls, which do not report confidence.
- Its answer could not be read.

**To review** shows up to 50 eligible, undecided calls at a time, prioritized by:

1. Disagreement between a shadow and the original answer.
2. The model's uncertainty: yes/no probabilities closest to 50%, or the lowest confidence in an answer.
3. For calls without confidence, answers that people correct most often.

After you review a call, your answer is highlighted and its row is ticked. You stay on the call until you move on with `j` / `k`, the arrow keys or a click. Reviewed calls leave the list the next time it loads.

**Invocations** shows every recorded call, newest first. Search by message text, conversation, event or trace ID, or combine filters:

```text
answer:billing v:2 conf:<0.6 decided:no differs:3
```

`differs:3` finds calls where the v3 shadow answered differently. You can review any call from Invocations. The overview shows calls per day and how often reviewers agreed with each version.

**Review never blocks your app.** Recording creates a copy of the call. It does not wait for a person or change the answer your code receives.

## Give customers or bots their own policies

By default, each policy is global. For different behavior by customer or bot, give calls a **scope**:

```ts
await decidus.trace(
  { scope: `${companyId}/${botId}` },
  () => handleMessage(msg),
);
```

Scopes are paths. A call uses its exact scope's version, then its parent's, then the global one. For example, `acme/support-bot` inherits from `acme` until you give the bot its own version. A new company starts with the global policy.

Choose a scope next to the policy name in the UI. Invocations and reviewed cases narrow to that scope; drafts, replays and traffic settings apply there. If a scope inherits its parent's traffic trials, changing a trial creates a local copy of the trial settings.

Click **Inherit** under the versions to follow the parent again, including its later versions. A client can also carry a fixed scope: `decidus.fetch({ scope: "acme" })`.

### Add IDs and context

Use IDs and metadata to find related calls. `conversationId` also keeps traffic routing consistent within a conversation:

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

`scope` selects the policy hierarchy. `eventId`, `traceId` and `metadata` do not change which version runs.

You can also pass `scope` and the IDs through your SDK's extra headers: `x-decidus-scope`, `x-decidus-conversation-id`, `x-decidus-event-id` and `x-decidus-trace-id`. Decidus removes these headers before the request leaves your process.

## How it runs

`decidus.fetch()` runs in your app's process. It merges the active version's edits into the decision text and sends the request to your provider or gateway. In the background, it copies the original request, as your code wrote it, and the response to the Decidus server. Your app's provider keys are never sent to Decidus.

The server serves the UI and stores calls, reviews and policy versions in one SQLite database.

### Keys for drafts, replay and shadow

Set keys in the server's environment:

| Task | Server configuration |
| --- | --- |
| Write drafts | At least one of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` |
| Replay or shadow direct provider calls | The key for each provider: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `TYPESAFE_API_KEY` |
| Replay or shadow gateway calls | `DECIDUS_GATEWAY_URL`, matching your app's gateway base URL, and `DECIDUS_GATEWAY_KEY` |

Replay and shadow make real calls to the recorded endpoint with the candidate text and the server's keys. Give Decidus its own gateway key with a budget so this usage is tracked separately and can be revoked independently.

OpenAI is preferred for drafts when several keys are set. To choose a model explicitly, set `DECIDUS_SUGGEST_MODEL=provider/model`, for example:

```sh
DECIDUS_SUGGEST_MODEL=openai/gpt-6.1-sol
```

Other examples are `anthropic/claude-sonnet-5-5` and `gemini/gemini-3.8-flash`. You can choose another model from any of those three providers.

### Share a server with your team

A hosted version at [decidus.ai](https://decidus.ai) is on the way. To review together now, run the server where your team can reach it:

```sh
DECIDUS_API_KEY=your-shared-key docker compose up -d
```

Or build and run the Docker image directly:

```sh
docker build -t decidus .
docker run -d -p 7700:7700 -v decidus:/data \
  -e DECIDUS_API_KEY=your-shared-key decidus
```

For a self-hosted server, set both variables in your app:

```sh
DECIDUS_BASE_URL=https://decidus.internal.example.com
DECIDUS_API_KEY=your-shared-key
```

Use the same shared key; the UI asks for it once. Also pass the server the provider or gateway keys it needs for drafts, replay and shadow.

### If the server is unavailable

Your app keeps calling its provider or gateway using the last live policy the fetch wrapper retrieved. If it has never reached the server, it uses v0 and sends your code's text as written. Records that cannot be delivered are dropped.

## Configuration

### In your app

| Variable | Default | Purpose |
| --- | --- | --- |
| `DECIDUS_BASE_URL` | `http://localhost:7700`, or `https://api.decidus.ai` when `DECIDUS_API_KEY` is set | Decidus server URL |
| `DECIDUS_API_KEY` | Unset | Shared server key |
| `DECIDUS_DISABLED` | Unset | Set to `1` to make `decidus.fetch()` a plain pass-through |

### On the server

| Variable | Default | Purpose |
| --- | --- | --- |
| `DECIDUS_API_KEY` | Unset | When set, requires the key for the API and UI |
| `DECIDUS_DB` or `--db` | `~/.decidus/decidus.db` | Database location |
| `PORT` or `--port` | `7700` | Server port |
| `DECIDUS_SUGGEST_MODEL` | `openai/gpt-6.1-sol`, otherwise a provider with a key set | Model that writes drafts |
| `DECIDUS_OBSERVE` | `20` | Calls sampled per scope to identify stable and varying text before tuning |
| `DECIDUS_WARMUP` | `20` | Initial calls per policy and scope eligible for review |
| `DECIDUS_SAMPLE_RATE` | `0.1` | Review sample rate after warmup |
| `DECIDUS_QUEUE_SIZE` | `50` | Calls shown in **To review** at a time |
| `DECIDUS_MAX_CASES` | `40` | Maximum cases the draft writer sees at once, disagreements first |
| `DECIDUS_REPLAY_CASES` | `300` | Maximum reviewed cases used for replay |
| `DECIDUS_GATEWAY_URL` | Unset | Gateway base URL for replay and shadow |
| `DECIDUS_GATEWAY_KEY` | Unset | Sent to that gateway as `Authorization: Bearer <key>` for replay and shadow |
| `DECIDUS_RETENTION_DAYS` | `30` | After this many days, unreviewed calls keep their rows but lose input and output. Set to `0` to keep everything. |

Run `npx decidus reset` to delete the local database. Older databases are upgraded in place on first start. **Policy versions created in 0.3 remain in history but no longer change calls:** they stored option descriptions rather than edits to decision text.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `j` / `k`, or arrow keys | Move between cases |
| `1`–`9` | Choose an answer |
| `Enter` | Agree with the model |
| `x` | Select a case under **Decided** |
| `/` | Search invocations |

## Limits in 0.5

- Streamed decision calls receive the live policy, but are not recorded or available for review.
- Shadow skips calls when it falls behind. With several shadows, each call is re-run by at most one of them.
- Replay authenticates to public provider APIs and one gateway. Direct replay to Azure OpenAI, Bedrock or Vertex is not supported yet; replay through a gateway is supported.
- Fixed-choice fields inside arrays of objects are not recognized as decisions yet.
- One server is one project. Everyone with its key can see every scope. Per-scope reviewer access is planned for the hosted version.
- Jev `score` questions pass through unmanaged.
- Node.js 22.13 or newer is required for the built-in `node:sqlite` module.

## Status and license

An experiment from the team at [Fini](https://usefini.com), who use it for their own support decisions.

MIT licensed.
