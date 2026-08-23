# Phase 1 PLAN — Effect Model Boundary and Usage Telemetry

## Purpose

Create the new complete model invocation behind one Effect service.

The legacy path returns only `result.output`; use that only as evidence of missing data. The PoC service defines a new result contract for later durable runs and context accounting.

```text
before
handler → ChatReply.generate → Llm.invoke(callback Promise) → output only

after
handler → ChatReply.generate → Model.Service → AI SDK/OpenRouter
                                      │
                                      └──▶ output + transcript + tools + usage + provider metadata
```

AI SDK remains the provider adapter in this phase. Effect owns errors, configuration, observability, timeout, and the model capability. No `Llm.invoke` compatibility wrapper is required.

## Greenfield PoC assumptions

- Define `Model.Service`, `ModelProfile`, usage, error, tool-event, and generation-result contracts directly.
- Do not preserve callback-shaped `Llm.invoke` or its return type.
- The existing action schema and one-web-lookup rule are product requirements, not API compatibility requirements.
- Run the service through an isolated PoC command/test boundary before integrating queues.

## Dependencies

- Phase 0 supplies the first model profile and usage mapping.
- The PoC supports structured Telegram actions and at most one web lookup.
- No queue, context, memory, or Telegram schema change is in scope.

## Current owners

```text
apps/starlight/src/ai/chat-reply.ts  structured reply + web tool
apps/starlight/src/ai/llm.ts         OpenRouter callback + timeout + telemetry
apps/starlight/src/ai/tools/web.ts   read-only web lookup
apps/starlight/src/services/runtime.ts one ManagedRuntime
apps/starlight/src/otel.ts           Langfuse telemetry options
```

## Target ownership

```text
ai/model-profile.ts
  → pure model capabilities, limits, prices, cache and media strategy

ai/usage.ts
  → pure provider/AI SDK usage normalization and cost estimate

ai/model.ts
  → Model.Service, OpenRouter/AI SDK invocation, timeout, typed failures

ai/chat-reply.ts
  → reply-specific schema, tools, and action result
```

Do not add Controller, ModelRepository, LlmManager, or another pass-through service.

## Effect shape

Follow the local flat service anatomy:

```text
Model.Interface
  generate prepared request → Effect<GenerationResult, Model.Error>

Model.Service
  Context.Service class

Model.layer
  binds configuration and provider once

Model.defaultLayer
  PoC/default OpenRouter adapter
```

Consumers import the module:

```ts
import * as Model from "@/ai/model";
```

Every workflow uses a stable `Effect.fn` name. Expected failures use `Schema.TaggedError` with a `fromCause` constructor where applicable.

## Model profile

A profile is immutable input to generation and later becomes part of the context-generation fingerprint.

Required fields:

```text
profile ID and version
provider and model slug
route/fallback policy
context limit
maximum output limit
default output reserve
tool-result reserve
cache strategy
minimum proven cacheable prefix
observed cache lifetime hints
input, cache-read, cache-write, output, reasoning prices
media input strategy
system prompt version
renderer version
toolset version
structured-output schema version
reasoning settings
```

Prices are observability data. Missing prices must not prevent a reply.

```text
known tokens + unknown price ──▶ reply succeeds + cost marked unknown
```

## Generation result

The Effect service must return enough information for later phases:

```text
structured reply output
provider-facing response messages or canonical events
tool calls and completed/error results
all provider steps
finish reason
warnings
provider request IDs
actual model/upstream provider
raw provider metadata needed for normalized usage
normalized per-step usage
normalized total billing usage
estimated or provider-reported cost
```

Do not return mutable arrays that tools continue to change after the Effect completes.

## Usage model

One AI SDK `generateText` can contain several provider calls:

```text
step 1  prompt + user       ──▶ tool call
step 2  prompt + tool result ──▶ final reply
```

Track two views:

```text
billing usage
  = sum every provider step

context observation
  = input size of the relevant provider request
```

Never do this:

```text
step 1 input + step 2 input = current context size   wrong
```

Normalize per step:

```text
input
cacheRead
cacheWrite
uncached = max(input - cacheRead, 0)
output
reasoning
cost
```

Then aggregate billing cost across all steps.

## Provider-reported versus estimated cost

Priority:

```text
provider-reported actual cost
  → model-profile calculation from normalized usage
  → unknown
```

Keep both reported and estimated values if both exist. A mismatch is telemetry, not a reply failure.

```text
reported $0.0031
estimated $0.0028
delta    $0.0003 ──▶ metric + structured warning above tolerance
```

## Error model

Expected categories:

```text
Unavailable       missing provider configuration
ProviderRejected  valid request rejected by provider
RateLimited       retryable provider limit
TimedOut          invocation exceeded deadline
InvalidOutput     structured response could not be decoded
ToolFailed        tool boundary failed
InvocationFailed  unknown transport/provider failure
```

Each error records stable fields:

```text
operation
profile ID
retryability
status code when known
provider error name
safe message
cause
```

Do not include prompt text, tool result content, or authorization headers in normal logs.

## Timeout and interruption

Use 120 seconds as the initial PoC total deadline unless measurement supports a different provider/tool split.

```text
Effect interruption
  → abort provider request when supported
  → wait for tool cleanup
  → return typed interruption/failure
```

Phase 2 will decide durable retry behavior. In Phase 1, return complete typed failures to the isolated caller.

## Tool handling

The current web tool mutates a shared `messageParts` array. Replace that internal mutation with an immutable returned tool-event list.

```text
tool call
  → execute read-only lookup
  → bound result
  → return completed event
  → include event in GenerationResult
```

Keep the one-web-lookup rule:

```text
0 completed lookups ──▶ web tool enabled
1 completed lookup  ──▶ no active tools
```

If a lookup fails, preserve the tool error event even if the model later produces a valid final response.

## Structured output

Keep the existing `ChatResponse` user-visible behavior:

```text
1–3 actions
  → ignore
  → text message
  → reaction
```

This phase does not yet expand targets for a multi-message batch. Phase 2 owns that contract change.

The generation result must retain both:

```text
decoded ChatResponse        application behavior
provider assistant content audit/retry/context source
```

## Telemetry

Every model step gets:

```text
operation
model profile
configured model
actual upstream provider/model
session or affinity ID
step index
input/cache-read/cache-write/uncached/output/reasoning tokens
reported and estimated cost
finish reason
latency
tool-call count
```

During Phase 1 the existing trace session ID remains. Phase 2 replaces it with a durable run and lane identity.

Use stable messages:

```text
"Model step completed"
"Model invocation failed"
"Model usage unavailable"
```

Put IDs and values in structured fields.

## Runtime assembly

Add `Model.defaultLayer` to the existing `ManagedRuntime` in `apps/starlight/src/services/runtime.ts`.

```text
logging layer
  + Exa.defaultLayer
  + Model.defaultLayer
  = one process ManagedRuntime
```

Do not create a runtime per Telegram message or BullMQ job.

## PoC build sequence

1. Add pure model-profile and usage modules.
2. Add `Model.Service` around OpenRouter/AI SDK behavior.
3. Create the new reply workflow against the bound service.
4. Return complete immutable generation data.
5. Decode the required Telegram action schema without dispatching through the legacy handler.
6. Add per-step structured logs and Langfuse fields.
7. Do not expose callback-style `Llm.invoke` in the PoC.

Normal path after migration:

```text
isolated PoC caller
  → runtime.runPromise(ChatReply.generate)
  → ChatReply uses Model.Service
  → Model invokes AI SDK
  → complete GenerationResult
  → handler dispatches existing actions
```

## Edge cases

### Output exists but usage is missing

```text
valid output + missing usage
  → reply continues
  → usage state = unknown
  → warning and metric
```

Usage is not a correctness dependency.

### Usage exists but output decoding fails

```text
provider billed request
  → usage is still logged
  → InvalidOutput returned
  → no Telegram action
```

### Tool succeeds but final provider step fails

Retain the completed tool event and all billed usage in the failure telemetry. Phase 2 later persists this against a durable run.

### Timeout races with final result

Only one Effect exit wins. If the provider completed but the timeout won before the result was observed, classify it as an invocation with unknown final outcome. Do not claim success.

### Cache fields are inconsistent

```text
cacheRead > input
  → raw usage retained
  → normalized record marked invalid
  → exclude from cost-threshold data
```

### Provider fallback changes model

Record both configured and actual model/provider. Do not treat fallback as an application error unless the profile requires a pinned route.

### Missing Exa key

The web tool remains absent. Tool schema/version in the profile must reflect that absence so later context generations do not silently change tool definitions.

## Tests

Behavior tests must protect these rules:

1. A normal request decodes the required structured Telegram actions.
2. One web lookup remains the maximum.
3. Tool events return as immutable generation data.
4. Multi-step usage sums for billing but keeps the final input observation separate.
5. Missing cache detail produces unknown cache usage, not zero-confidence success.
6. Provider-reported cost wins over the local estimate.
7. A timeout returns the typed timeout failure.
8. Missing provider configuration returns `Unavailable` without invoking AI SDK.
9. Logs do not contain prompt or tool-result content.

Run the narrow `apps/starlight` tests related to changed AI code, then run repository `bun run lint`.

## Observability gate

Isolated staging/PoC traces must show:

```text
one trace per generation
  → one or more provider step spans
  → complete per-step token fields
  → one total billing summary
  → configured and actual provider identity
```

Verify expected ignore/message/reaction fixtures. Do not compare call structure or serialized results with the legacy adapter.

## Exit gate

Phase 1 passes when:

```text
required Telegram action rules satisfied
  + AI SDK hidden behind Model.Service
  + complete immutable GenerationResult returned
  + per-step usage visible
  + typed errors and timeout implemented
  + one ManagedRuntime used
  = durable run work can begin
```

## PoC failure handling

Stop Phase 2 integration and fix the new service/profile contract. Do not add an `Llm.invoke` adapter or preserve the old callback signature. PoC traces and fixtures can be recreated after incompatible result changes.
