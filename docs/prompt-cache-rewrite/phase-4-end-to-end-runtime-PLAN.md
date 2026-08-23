# Phase 4 PLAN — End-to-End Context Runtime PoC

## Purpose

Connect the new admission, batching, lane, context, model, tool, delivery, and finalization abstractions into one coherent PoC runtime.

```text
PoC input
  → durable lane run
  → active context A+B+C + live D
  → model/tools
  → durable delivery
  → finalized context append
```

Phase 4 enables normal append-only growth. Automatic checkpoints remain disabled until Phase 5, so PoC scenarios use contexts safely below a conservative token ceiling.

There is no legacy prompt option, old-path fallback, compatibility assignment, or dual runtime in this phase.

## Dependencies

- Phase 0 proved the model cache strategy.
- Phase 1 returns complete model results and per-step usage.
- Phase 2 serializes lanes and persists runs/actions.
- Phase 3 proved deterministic rendering and context invariants.

Do not start Phase 4 with unresolved PoC fixture failures for required text, direct replies, media, tools, or sender identity.

## PoC integration matrix

Run the final architecture for every PoC lane:

```text
text-only lane
  → direct-reply lane
  → tool lane
  → media lane
  → multi-user burst lane
  → provider/cache miss lane
```

One lane always uses one context history:

```text
run 1 A+B+C0+D1 → finalize C1
run 2 A+B+C1+D2 → finalize C2
run 3 A+B+C2+D3
```

Do not connect the legacy handler or old 17-message selector as a fallback. If an end-to-end scenario fails, stop and fix the owning PoC abstraction.

## PoC request construction

For a prepared run:

```text
load active context by lane
  → verify model-profile fingerprint
  → load stored A and B
  → load ordered immutable C turns
  → verify terminal segment chain
  → render frozen D from prepared run
  → estimate total input + reserves
  → invoke Model.Service
```

If the terminal chain does not match, stop the lane and return a controlled internal failure. Do not rebuild old turns from raw messages as a hidden repair.

## PoC prompt

```text
A  stable system/tool/output envelope
   │
   ▼
B  frozen context memory
   │
   ▼
C  finalized turns through previous run
   │
   ├── automatic provider prefix matching
   ▼
D  current date + current batch + linked context + live media
```

For `implicit-prefix` profiles:

- do not add `cache_control` markers;
- keep a stable affinity identifier;
- record configured and actual upstream provider;
- accept best-effort cache misses without changing logical context.

Explicit cache behavior is enabled only for a separately proven profile.

## Stable affinity

Derive an opaque provider session/affinity value:

```text
hash(assistantId + chatId + threadKey + application salt)
```

Keep it stable across normal generations unless the provider contract requires a generation-specific value. Do not send raw chat IDs when an opaque value works.

Affinity helps route stability. It is not a cache key or lock.

## Profile mismatch

At preparation:

```text
active generation profile == configured profile?
  yes ──▶ normal request
  no  ──▶ controlled profile transition required
```

Before Phase 5 general transition support, a PoC lane with a profile mismatch must:

```text
stop new context invocation
  → finish or terminally resolve active run
  → remain queued/disabled for operator transition
```

Do not silently invoke a different model against the old generation.

## Input and direct-reply behavior

The prepared Phase 2 batch is D. It remains immutable across provider retries.

```text
batch messages 41…45
  + direct target projections
  + current metadata
  + live media references/digests
  = frozen D
```

An old direct target is rendered as linked context at the end of D. It never changes C ordering.

After successful terminal delivery, its stable projection can append at the end of C before the user turn it explains.

## Model and tool execution

The run keeps the same lifecycle from Phase 2:

```text
prepared → invoking → generated → dispatching → finalized
```

AI SDK may issue multiple provider steps:

```text
step 1  A+B+C+D                  ──▶ web tool call
step 2  A+B+C+D+call+tool result ──▶ structured reply
```

Persist per-step usage. The final context size observation is not the sum of both inputs.

Every tool definition remains stable for the generation. If Exa availability changes tool presence, that creates a different model profile instead of silently changing A.

## Generation result and delivery

Persist generation output before Telegram:

```text
model result
  → durable provider/tool events
  → durable Telegram actions
  → generated status
  → dispatch by ordinal
```

If dispatch retries, reuse these stored actions.

No context turn is finalized until delivery reaches a terminal state.

## Context append transaction

After delivery:

```text
fenced finalization transaction
  → append provider-neutral user/linked/media/tool turns
  → append delivered assistant actions
  → append bounded terminal markers for ignore/failure policy
  → render new turns once for active generation
  → extend segment hash chain
  → advance estimated stable tokens
  → update run and lane progress
```

The context append and run finalization must be idempotent by run/source turn identity.

```text
worker retries finalization
  → uniqueness finds existing turns
  → terminal segment hash is unchanged
  → no duplicate C content
```

## What becomes C

### Delivered text

```text
user source turns
  → linked reply context if external
  → bounded tool interaction if used
  → delivered assistant text + target
```

### Delivered reaction

Append a bounded action only if the reaction affects future conversation meaning.

### Ignore

Always append user input. Optionally append one stable internal no-reply marker. Do not create a fake Telegram assistant message.

### Permanent delivery failure

Append user input and a stable delivery-failure marker. Do not append failed assistant text as user-visible output.

### Partial delivery

Append only delivered actions as visible output. Keep undelivered generated actions in run audit data.

## Media in the PoC runtime

```text
D  live bytes loaded from immutable object version
   │
   ▼
model can inspect media
   │
   ▼
C  stable digest/description projection only
```

Verify the object digest before retry. If bytes do not match the prepared digest, fail the run instead of sending different media under the same request hash.

Do not reset after every image. Record whether the next request reuses the prior text prefix and whether the following request reuses through the stable media projection.

## Temporary size guard before Phase 5

Phase 4 has no automatic checkpoint. Use a conservative PoC ceiling below the model limit.

```text
estimated A+B+C+D + output/tool reserve < PoC ceiling
  → invoke context path

estimated total reaches ceiling
  → stop this lane from new-path invocation
  → keep pending input durable
  → require Phase 5 checkpoint or controlled operator transition
```

Do not silently slide, truncate finalized C, or call the old history builder.

This guard bounds Phase 4 scenarios. Phase 5 is required before long-running PoC conversations.

## Usage feedback

After every provider step record:

```text
estimated input
observed input
cache read/write
uncached input
output/reasoning
configured and actual provider/model
idle time since prior lane call
generation and terminal prefix hash
reported and estimated cost
```

Use the relevant observed request input to calibrate the next estimate:

```text
estimate too low repeatedly
  → increase conservative profile multiplier/reserve
```

Do not mutate already stored turn token estimates in a way that changes rendering. Aggregate estimates can be corrected separately.

## Cache interpretation

Classify each step:

```text
confirmed hit   cacheRead > 0
confirmed miss  valid usage and cacheRead = 0
unknown         cache details absent/invalid
routing miss    upstream changed
cold-after-idle likely expiry, same prefix/profile
```

An internal terminal prefix hash can prove application stability. It cannot prove provider cache storage.

```text
stable hash + provider miss
  → record miss
  → do not rewrite prompt automatically
```

## Memory before Phase 6

The generation's checkpoint memory remains frozen B. Use empty memory or explicit synthetic fixtures until Phase 6 supplies scoped revisions.

```text
generation B created from PoC checkpoint state
  → no ChatMemoryNote read
  → no legacy memory injection into D
```

Phase 6 adds new memory publication and prompt projection directly.

## PoC metrics

Measure the final runtime against its own requirements and test fixtures:

```text
reply/ignore/reaction distribution
provider error rate
Telegram delivery error rate
input/output tokens per useful reply
cache-read ratio
latency by provider step and total run
direct-reply success
media/tool behavior
user correction/retry signals
context estimate error
invalid prefix-chain count
```

Quality review must inspect representative outputs with private data controls. Lower cost alone does not pass the phase.

## Edge cases

### Cache expires during idle

```text
same generation + same prefix
  → first return request can miss
  → request proceeds
  → later requests can hit again
```

No checkpoint or memory generation occurs only because of expiry.

### Upstream provider changes

Record routing miss. If the new upstream still supports the profile's API contract, continue. If response/tool/media behavior is incompatible, fail with a provider/profile error.

### System prompt deployment changes

Existing generations continue their stored A. New lanes use the new profile. An urgent forced transition is an explicit operator action until Phase 5 transition support exists.

### Tool configuration changes while a run waits

The prepared run uses its pinned model/tool profile. It does not read current environment and silently alter the tool list.

### Linked target is deleted after preparation

The run uses the frozen linked projection. A later deletion event becomes a correction. It does not mutate prepared D.

### Media object becomes unavailable

Fail the prepared run with a media-unavailable error. Do not drop required live media and continue as if the request were complete.

### Provider succeeds, all Telegram actions fail permanently

Finalize source input and delivery-failure context. The lane can proceed. Preserve generated output in run audit data.

### New message arrives during dispatch

It remains pending. The active run finalizes first so reply order stays coherent.

### Context chain verification fails

Stop the lane, emit a high-severity structured error, and keep pending input. Never repair by deleting or rewriting turns automatically.

### First context request has no cache read

Expected. The new prefix may be below minimum, cold, or newly serialized. Require later append requests before classifying failure.

### First request after media reads only the older prefix

Expected for one extension. Check the next request for reuse through the stable media projection before declaring a barrier.

## Tests

Required behavior tests:

1. A prepared run sends exactly stored A+B+C+D.
2. Implicit profiles add no explicit cache marker.
3. A stable affinity value remains the same for one lane.
4. Profile mismatch blocks invocation instead of mutating the generation.
5. A normal finalized run appends one immutable interaction sequence.
6. Finalization retry appends zero duplicate turns.
7. Partial delivery appends only delivered assistant actions.
8. Ignore still appends source user turns.
9. Cache expiry classification does not create a checkpoint.
10. Provider fallback records actual upstream identity.
11. Media retry verifies the prepared digest.
12. External state cannot change active B.
13. Terminal chain mismatch prevents model invocation.
14. Temporary ceiling blocks an oversized PoC lane without dropping input.
15. A new message during dispatch runs only after finalization.

Run narrow context, AI, queue, and Telegram delivery tests. Run `bun run lint`.

## Acceptance gate

Phase 4 passes when end-to-end PoC evidence shows:

```text
normal finalized turns extend the stored prefix
  + provider cache reads appear according to Phase 0 expectations
  + cold misses do not mutate context
  + no direct-reply/media/tool behavior regression
  + model retries reuse prepared input
  + delivery retries never regenerate output
  + estimate remains safely below the temporary ceiling
  + quality review passes
  = checkpoints can be enabled
```

## PoC failure handling

Stop the PoC worker and preserve the failed run/context rows for diagnosis:

```text
active run?  terminally resolve or leave isolated in the disposable PoC environment
schema wrong? recreate PoC data after fixing the final schema
logic wrong?  fix the owning abstraction and rerun the scenario
```

Do not add a legacy fallback or compatibility flag. Existing application behavior outside the isolated PoC is not part of this phase's runtime.
