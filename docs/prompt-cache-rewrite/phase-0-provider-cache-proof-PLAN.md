# Phase 0 PLAN — Prove Provider Cache Behavior

Measured evidence: [Phase 0 RESULT — Gemini 3.7 Flash on Vertex Global](./phase-0-provider-cache-proof-RESULT.md)

## Purpose

Prove the cache contract of the exact candidate model, OpenRouter route, AI SDK provider, tool schema, and media format before the PoC persistence and cost policy depend on cache savings.

This phase is the first and only executable surface in the new `apps/starlight` PoC. The legacy bot source is removed before the probe is built; there is no old model path to preserve.

```text
assumption ──▶ controlled request ──▶ provider usage ──▶ observed contract

no observed contract ──▶ choose a no-cache PoC profile or another provider
```

## Why this phase is first

Gemini and native DeepSeek normally use automatic prefix caching. They do not share one universal TTL, cache threshold, or accounting format.

The removed runtime named two conflicting model defaults:

```text
old shared config                 google/gemini-3-flash-preview
old Starlight environment         google/gemini-3.5-flash-lite
new Phase 0 environment           no default; exact model is required
```

OpenRouter can route one model slug to different upstream providers. A valid stable prefix can miss when routing changes.

## External contracts to verify

Primary references:

- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Google Gemini context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)
- [AI SDK provider options](https://ai-sdk.dev/v7/docs/foundations/provider-options)

Treat documentation as the expected behavior. Treat measured requests through the planned PoC adapter as the architecture evidence.

## Greenfield PoC assumptions

- Build the cache probe against the new model profile and adapter contract.
- Delete the old `apps/starlight/src` runtime before building the probe. Phase 0 does not compile Telegram, queue, database, memory, or observability code.
- Do not call or preserve `withOpenRouterGeminiCacheControl` for compatibility.
- Do not reproduce legacy prompt ordering as a control path.
- Synthetic requests define the experiment. No legacy conversation backfill is required.
- If the candidate provider contract is poor, change the profile/adapter instead of adding model-name conditionals to old helpers.

## Required experiment profile

Record this before sending a test request:

```text
model slug
actual upstream provider when reported
OpenRouter provider package version
AI SDK version
system prompt hash
tool schema hash and order
structured-output schema hash
reasoning settings
media strategy
routing preferences and fallbacks
session/affinity identifier strategy
```

One profile produces one result set. Do not merge results from two models or routes.

For the current adapter profile, record exact installed versions rather than semver ranges:

```text
ai                              7.0.77
@openrouter/ai-sdk-provider     3.0.0
```

## Test harness requirements

This section records the temporary proof harness contract. The harness and commands were removed from `apps/starlight` after the measured result was captured; the package now starts the grammY bot runtime.

Build a narrow, deterministic command. It is the complete `apps/starlight` executable for Phase 0 and must:

- own the only model path in `apps/starlight`;
- use fixed text instead of current date, random IDs, or generated labels;
- print normalized per-step usage;
- print OpenRouter request/generation IDs and upstream provider when available;
- calculate and print a stable hash of the intended common prefix;
- retain raw provider metadata in a local test artifact with secrets removed;
- never send Telegram messages;
- never write existing application conversation state.

Use synthetic content. Do not upload real user chat history or media.

Implementation boundary:

```text
apps/starlight/src/index.ts
  → explicit Phase 0 command
  → deterministic fixture
  → OpenRouter AI SDK provider
  → normalized observation
  → ignored .artifacts/phase-0/<timestamp>.json
```

Commands:

```text
bun run phase0 profile
bun run phase0 minimum-prefix
bun run phase0 growth
bun run phase0 idle
bun run phase0 routing
bun run phase0 tools
bun run phase0 structured-output
bun run phase0 media
bun run phase0 explicit-cache
bun run phase0 all
```

`profile` is local and makes no provider request. Every experiment command is an explicit paid external operation; do not run it during tests, lint, application start, or package install.

Every live process reserves `PHASE0_REQUEST_COST_RESERVE_USD` before each physical provider step, disables AI SDK retries, bounds output tokens, and reconciles the reserve against reported cost. The initial measured limit is USD 10 with a USD 0.10 per-step reserve. OpenRouter does not expose a general pre-charge cap for one chat request, so the OpenRouter key or guardrail must also have a USD 10 hard limit.

## Experiment A — Minimum cacheable prefix

Generate stable synthetic prefixes at increasing sizes:

```text
1k ──▶ 2k ──▶ 4k ──▶ 8k ──▶ 16k estimated tokens
```

For each size:

```text
request 1  prefix P + suffix A  ──▶ expected cold/write behavior
request 2  prefix P + suffix B  ──▶ inspect cache-read tokens
request 3  prefix P + suffix C  ──▶ inspect repeatability
```

Each size uses a distinct namespace in the first bytes of its prefix. A larger case must not begin with a smaller case that ran earlier.

Pass condition:

```text
cacheReadTokens > 0 on a repeated stable prefix
and cacheReadTokens grows with a larger eligible prefix
```

Record the smallest prefix with repeatable reads. Do not assume that a documented family threshold applies to a `-lite`, preview, or OpenRouter-routed variant.

## Experiment B — Growing append-only prefix

Use deterministic user turns and retain each real provider response:

```text
R1  A + B                     + live C
R2  A + B + committed C + R1  + live D
R3  A + B + C + R1 + D + R2   + live E
```

Expected implicit-cache behavior:

```text
R1  cold prefix
R2  reuses the old eligible prefix and warms the longer prefix
R3  reuses a longer prefix than R2
```

Verify:

- each longer prefix contains the prior prefix messages as its exact leading sequence;
- the prefix hash changes deterministically and records the prior prefix hash as its parent;
- cache-read tokens rise after the prefix passes the model threshold;
- no explicit `cache_control` marker is required for the implicit profile;
- removing or reordering an earlier turn causes the expected miss.

Do not call this successful only because total cost falls. Require provider cache-read evidence.

## Experiment C — Idle behavior

Run the same stable-prefix pair after controlled idle periods:

```text
warm request
   │
   ├── wait 1 minute  ──▶ retry and record
   ├── wait 3 minutes ──▶ retry and record
   ├── wait 5 minutes ──▶ retry and record
   └── wait 10 minutes ─▶ retry and record
```

Run more than one sample. Implicit cache hits are best-effort.

Classify results:

```text
confirmed hit       cache-read tokens reported
confirmed miss      zero cache-read tokens with otherwise valid usage
unknown             provider omitted cache detail
routing miss        upstream provider changed
```

Do not convert an observed average into a correctness TTL.

## Experiment D — Session affinity and routing

Compare:

```text
stable session ID + stable route        ──▶ cache result
stable session ID + fallback allowed    ──▶ cache result + upstream identity
new session ID + same content           ──▶ cache result
changed provider order                  ──▶ cache result
```

Use an opaque `x-session-id`. OpenRouter's `user` field is for end-user abuse monitoring and is not the cache-affinity mechanism. Do not expose raw Telegram chat IDs to the provider when a stable hash is sufficient.

The current OpenRouter provider package has no typed `session_id` option. Prefer the documented `x-session-id` header over an untyped `extraBody.session_id` field.

Decision output:

```text
availability-first   fallback remains enabled; routing misses are accepted
cache-first          upstream route is pinned where supported
```

The initial recommendation is availability-first with stable affinity and explicit routing-miss telemetry.

## Experiment E — Tool definitions and tool loop

First vary only tool schema order:

```text
request A  tools [web, other]
request B  tools [web, other]  ──▶ expected reuse
request C  tools [other, web]  ──▶ expected miss or lower reuse
```

Then run one deterministic read-only tool flow:

```text
provider step 1  stable prefix + user request
  → assistant tool call
  → bounded tool result
provider step 2  same prefix + call + result
  → final assistant output
```

Record usage per step.

Do not calculate context size as the sum of both step inputs:

```text
billing input = step 1 input + step 2 input
context size  = relevant final request input
```

Verify whether the second step reuses the stable prefix and whether tool definitions affect the cache key.

## Experiment F — Structured output

Compare identical requests with:

```text
same output schema       ──▶ expected reuse
changed field order      ──▶ record behavior
changed schema version   ──▶ expected profile change
```

Even if the provider does not expose how schema bytes affect caching, the PoC design must keep schema serialization stable inside a generation.

## Experiment G — Media

Use a synthetic, non-sensitive image with a stable digest.

```text
R1  stable text prefix + live image bytes
R2  stable text prefix + stable image description + new text
R3  same as R2 + next turn
```

Measure:

- whether R2 still reads the text prefix before the media boundary;
- whether R3 reads through the stable media description;
- whether a stable provider-readable URL and inline bytes differ;
- whether media token accounting is present and consistent.

The expected design is:

```text
live bytes in volatile D
stable digest/description in future C
old prefix remains reusable
new projection warms on the next call
```

Do not require a generation reset unless the result shows a lasting cache barrier.

## Experiment H — Explicit cache control

Run this only if the exact route documents or demonstrates an explicit mode.

```text
implicit mode, no marker
explicit mode, fixed marker
```

Use isolated prefixes for two samples per mode. Warm each prefix to a confirmed hit, wait one minute, and retry. Record cache reads, cache writes, storage/write pricing, and TTL behavior separately.

OpenRouter-managed Gemini caching uses one final `cache_control: { type: "ephemeral" }` breakpoint and an opaque five-minute cache. It is not a caller-owned native Vertex `cachedContents` resource. Do not send Anthropic-only TTL options to Gemini.

## Usage normalization contract

AI SDK normalized usage captures these fields when exposed:

```text
inputTokens
inputTokenDetails.cacheReadTokens
inputTokenDetails.cacheWriteTokens
outputTokens
reasoningTokens
provider request/generation ID
actual upstream provider
actual provider cost
cache discount
```

`@openrouter/ai-sdk-provider` 3.0.0 types provider metadata as:

```text
openrouter.provider
openrouter.usage.promptTokens
openrouter.usage.promptTokensDetails.cachedTokens
openrouter.usage.completionTokens
openrouter.usage.completionTokensDetails.reasoningTokens
openrouter.usage.totalTokens
openrouter.usage.cost
openrouter.usage.costDetails.upstreamInferenceCost
```

The package maps OpenRouter `cache_write_tokens` into AI SDK `inputTokenDetails.cacheWriteTokens`. It does not expose a typed cache discount or upstream response ID. Enrich each successful step through `GET /api/v1/generation?id=<response.id>` and retain the redacted response in the local artifact. A failure to fetch enrichment must remain visible but does not replace the AI SDK cache-read or cache-write observation.

`result.usage` aggregates all model steps. Always normalize `result.steps[*].usage` first. Use the sum of step inputs for billing and only the final step input for final context size.

Derive only with explicit rules:

```text
uncachedInput = max(inputTokens - cacheReadTokens, 0)
```

Zero cache-write tokens do not prove that an implicit cache was not populated.

## Edge cases

### Usage is missing

```text
response succeeds
  → usage absent
  → mark cache result unknown
  → do not infer a hit from latency or price
```

The phase cannot pass for a cache-dependent cost policy if cache reads remain unobservable.

### Prefix hash matches but cache misses

Check in this order:

```text
upstream route changed?
  → cache below minimum?
  → idle expiry likely?
  → tool/schema/settings changed?
  → provider best-effort miss?
```

Do not mutate prompt architecture to hide an unexplained route change.

### Provider reports more cached than input tokens

Treat the observation as invalid provider metadata. Preserve the raw record, emit a structured warning, and exclude it from threshold calculations.

### Experiment cost or rate limit

Use the smallest synthetic prefixes that cross the expected thresholds. Add delay between distinct warm attempts and disable AI SDK request retries. Never retry an unchanged permanent provider error.

### Preview model changes during experiment

Record model revision and date. Re-run the gate before accepting the PoC if the provider changes the route or model revision materially.

## Result artifact

The phase result must state:

```text
profile name
cache strategy
minimum proven stable prefix
observed idle hit distribution
tool behavior
media behavior
usage field mapping
routing policy
known unknowns
recommended Phase 5 threshold candidates
```

Do not put credentials, prompts from real users, authorization headers, or raw private media in the artifact.

## Tests and validation

- Deterministic prefix creation produces the same hash on repeat runs.
- Changing only the volatile suffix does not change the prefix hash.
- Reordering a stable turn changes the hash and makes the control test fail.
- Usage normalization handles absent and zero cache details.
- Per-step billing totals are not used as final context size.
- Synthetic media uses an immutable digest.

Local validation must not need an API key. Live results are separate evidence:

```text
local gate  lint + deterministic tests + profile command
live gate   explicit experiment command + paid provider requests + artifact review
```

## Current implementation status

The completed proof is preserved in the result document. The temporary executable and its experiment-only environment variables are no longer part of the bot package.

The removed harness had:

- an isolated provider-proof executable;
- explicit model with no default;
- all eight experiment commands;
- opaque `x-session-id` routing;
- AI SDK per-step usage normalization;
- OpenRouter generation-detail enrichment;
- deterministic text, tool, schema, and image fixtures;
- redacted ignored artifacts;
- focused deterministic tests.

Selected measured profile:

```text
model               google/gemini-3.7-flash
provider only       google-vertex/global
fallbacks           false
require parameters  true
reasoning effort    minimal
cache strategy      fixed OpenRouter-managed explicit breakpoint
```

Measured explicit-cache contract:

- explicit cache writes begin between 2,540 and 5,043 marked tokens, consistent with Vertex's documented 4,096-token Gemini 3 floor;
- both one-minute explicit retries reused 10,305 tokens;
- a fixed marker reused 10,301 tokens through exact append-only growth without moving the marker;
- tools, structured output, inline media, and a new session retained fixed-base reuse;
- tool-order or tool-step setting changes can cause a new explicit write;
- DeepSeek automatic caching was cheaper, but named tool choice, strict schema output, and ZDR requirements rejected it as the chatbot profile;
- the public media-URL variant remains optional and unmeasured.

## Exit gate

Phase 0 passes only when:

```text
exact candidate model and route recorded
  + repeatable stable-prefix cache reads observed or cache declared unsupported
  + cache usage normalized
  + tools and media measured
  + idle behavior classified
  + routing policy selected
  = model profile ready for Phase 1
```

If caching is unsupported or unobservable, continue only with a quality/safety context design. Remove cache savings from PoC acceptance expectations.

## PoC failure handling

Change or reject the candidate model profile and rerun the isolated harness. Do not add a legacy cache-helper adapter. Keep the harness as an explicit diagnostic command; never run it automatically in the application runtime.
