# Phase 0 PLAN — Prove Provider Cache Behavior

## Purpose

Prove the cache contract of the exact candidate model, OpenRouter route, AI SDK provider, tool schema, and media format before the PoC persistence and cost policy depend on cache savings.

This phase is an isolated PoC harness and changes no existing application behavior.

```text
assumption ──▶ controlled request ──▶ provider usage ──▶ observed contract

no observed contract ──▶ choose a no-cache PoC profile or another provider
```

## Why this phase is first

Gemini and native DeepSeek normally use automatic prefix caching. They do not share one universal TTL, cache threshold, or accounting format.

The current repository also names two model defaults:

```text
packages/utils/src/config.ts       google/gemini-3-flash-preview
apps/starlight/.env.example        google/gemini-3.5-flash-lite
candidate PoC environment          must be recorded before the experiment
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

## Test harness requirements

Build a narrow, deterministic script or test-only command. It must:

- call the same model path as `apps/starlight`;
- use fixed text instead of current date, random IDs, or generated labels;
- print normalized per-step usage;
- print OpenRouter request/generation IDs and upstream provider when available;
- calculate and print a stable hash of the intended common prefix;
- retain raw provider metadata in a local test artifact with secrets removed;
- never send Telegram messages;
- never write existing application conversation state.

Use synthetic content. Do not upload real user chat history or media.

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

Pass condition:

```text
cacheReadTokens > 0 on a repeated stable prefix
and cacheReadTokens grows with a larger eligible prefix
```

Record the smallest prefix with repeatable reads. Do not assume that a documented family threshold applies to a `-lite`, preview, or OpenRouter-routed variant.

## Experiment B — Growing append-only prefix

Use deterministic turns:

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

- the stable prefix hash extends instead of changing;
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
stable affinity ID + stable route       ──▶ cache result
stable affinity ID + fallback allowed   ──▶ cache result + upstream identity
new affinity ID + same content          ──▶ cache result
changed provider order                  ──▶ cache result
```

The affinity ID must be opaque. Do not expose raw Telegram chat IDs to the provider when a stable hash is sufficient.

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
explicit mode, moved marker
```

Record cache reads, cache writes, storage/write pricing, and TTL behavior separately.

Do not add `providerOptions.openrouter.cacheControl` to Gemini or DeepSeek only because another provider family needs it.

## Usage normalization contract

Capture these fields when exposed:

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

Use the smallest synthetic prefixes that cross the expected thresholds. Add delay and bounded retries. Never retry an unchanged permanent provider error.

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
