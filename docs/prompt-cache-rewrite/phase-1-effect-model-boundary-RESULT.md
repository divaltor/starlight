# Phase 1 RESULT — Effect Model Boundary and Usage Telemetry

## Verdict

```text
PASS  application-owned Model.Service boundary
PASS  structured Telegram reply and one-web-lookup workflow
PASS  typed timeout, provider cancellation, and tool cancellation
PASS  normalized per-step and generation billing telemetry
PASS  safe live Langfuse trace
GO    durable conversation lane work can begin
```

Phase 1 is complete. Production source, commands, configuration, and runtime names have no phase prefixes.

## Final boundary

```text
grammY handler
  → ChatReply.generate
    → Model.Service.generate
      → AI SDK generateText
        → OpenRouter
          → google/gemini-3.7-flash
```

The public `Model` contract contains only application-owned messages, tools, schemas, transcript events, tool events, normalized usage, finish reason, and typed errors. AI SDK messages, OpenRouter options, raw provider metadata, warnings, and response objects remain private.

The selected runtime profile contains only the fields consumed by invocation and usage accounting:

```text
model and provider route
reasoning setting
default and maximum output limits
input, cache, output, and reasoning prices
```

System-prompt, renderer, toolset, media, checkpoint, and context-generation fingerprints are deferred to their owning context phase.

## Implemented behavior

- OpenRouter configuration is read once through an internal provider layer.
- Missing or blank provider configuration returns typed `Unavailable` before invocation.
- Paid model admission is default-deny; only private, group, or supergroup chat IDs in `WHITELIST_CHAT_IDS` can invoke `ChatReply`.
- The route is pinned to `google-vertex/global`, fallbacks are disabled, required parameters are enforced, and reasoning is minimal.
- AI SDK automatic retries are disabled.
- One interruptible 120-second deadline covers provider and tool work.
- The abort signal propagates through application tools into Exa effects.
- `ChatReply` returns one to three validated ignore, text, or reaction actions.
- At most one web lookup can execute.
- URL lookup accepts only normalized URLs extracted from the live message.
- Completed and failed tool executions return as immutable application events.
- Provider-reported cost takes precedence over local estimates.
- Billing usage sums all physical provider steps; context input uses the final relevant step.
- Missing usage remains unknown and does not block a valid reply.
- An invocation with no recorded provider step reports unknown billing, not zero cost, and is invalid for cost thresholds.
- Invalid cache accounting is excluded from cost-threshold data.
- Effect logs use stable messages with structured annotations.
- OpenTelemetry exports normalized model-step and generation-summary spans.
- AI telemetry records neither prompt nor output content.
- One process `ManagedRuntime` assembles logging, Exa, Model telemetry, and Model provider layers.

## Reply output limit

The generic model boundary retains an 8,192-token default, but the chatbot workflow now requests at most 1,024 output tokens.

```text
Model.Service default     8,192 tokens
ChatReply maximum         1,024 tokens
provider maximum         65,536 tokens
```

One live acceptance request exposed a runaway 8,185-token response that ended without valid structured output. The workflow-specific cap bounds that failure class while leaving enough room for three short Telegram actions and minimal reasoning.

## Deterministic validation

Twenty-five focused tests protect:

```text
missing or blank key          → Unavailable
empty chat allowlist          → no chat admitted
private and group chat IDs    → parsed as safe integers
OTLP endpoint and headers     → optional exporter configuration
text, reaction, ignore        → decoded through ChatReply and Model
second requested tool call    → not executed
completed tool result         → immutable event
failed tool result            → failed event + recovered generation
provider deadline             → abort + TimedOut
tool deadline                 → tool abort + TimedOut
ChatReply output limit        → 1,024 tokens
prompt and tool-result data   → absent from logs and spans
step telemetry                → normalized cache, token, provider, and cost fields
generation telemetry          → total billing summary
missing cache detail          → unknown
provider-reported cost        → selected before estimate
multi-step usage              → billing sum + final context input
invalid cache accounting      → excluded from thresholds
no recorded provider step     → unknown cost + invalid threshold sample
invented URL                  → rejected
allowed live-message URL      → accepted
URL prose punctuation         → normalized
```

## Live acceptance

Final accepted trace:

```text
trace ID          15d2b0d1d761702de425f512446fbcc8
model             google/gemini-3.7-flash
upstream          Google through google-vertex/global
finish reason     stop
actions           text
provider steps    1
input tokens      1,887
output tokens     20
cache read        0
reported cost     $0.00073767375
latency           1,929.53 ms
```

The cache miss is expected. `ChatReply` does not yet have the frozen, proven-size cache base that the future context runtime will supply.

Langfuse Observations API v2 returned five observations in the same trace:

```text
Model generation                         normalized billing summary
Model step                               normalized provider/cache/cost fields
invoke_agent google/gemini-3.7-flash     AI SDK agent span
step 1                                   AI SDK step span
chat google/gemini-3.7-flash             AI SDK generation + provider usage
```

The normalized step observation contains configured and actual model, upstream provider, provider request ID, cache classification, input/cache/output/reasoning tokens, latency, finish reason, tool-call count, and reported/estimated/selected cost.

The normalized generation observation contains physical-step count, total billing tokens and cost, final context input, finish reason, and cost-threshold validity.

Every observation returned zero recorded input and output bytes. No prompt, model output, tool-result content, raw Telegram chat ID, raw thread ID, or authorization data was present.

## Acceptance calls

```text
first provider call   PASS   $0.000859815 reported
second provider call  FAIL   8,185 output tokens; $0.016054125 local estimate
final bounded call    PASS   $0.00073767375 reported

total                approximately $0.01765161375
```

The failed call was not retried unchanged. It caused the 1,024-token ChatReply cap, failure-span export, and structured Effect-log correction before the final bounded request.

An earlier no-key attempt made no provider request and confirmed the typed configuration guard.

## Validation

- `bun test src` in `apps/starlight`: 25 passed.
- `bun run lint` in `apps/starlight`: passed.
- Repository structural `ast-grep` scan: passed.
- The last clean repository `bun run lint` passed all six packages; the final root rerun was blocked by unrelated generated `apps/web/bench/` files that appeared concurrently. The affected Starlight lint remained clean.
- Working-tree and staged `git diff --check`: passed.
- Bellno final review: `READY`; admission and no-step usage findings resolved.

## Phase 2 handoff

Phase 2 can persist the application result without importing AI SDK or provider contracts:

```text
decoded Telegram actions
canonical assistant transcript
completed or failed tool events
per-step and total usage
finish reason
typed failure category
```

Phase 2 still owns immutable Telegram admission, conversation lanes, fencing, batching, durable run state, durable action delivery, and retry policy. Explicit caching remains inactive until a later context phase supplies a frozen stable base.
