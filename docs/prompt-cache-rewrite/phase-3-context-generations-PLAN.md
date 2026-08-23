# Phase 3 PLAN — Immutable Context Generations

## Purpose

Build and persist the final append-only context model as a standalone PoC abstraction.

There is no old prompt adapter, production shadow comparison, or dual write. Phase 2 supplies durable runs with a minimal prompt fixture; Phase 3 replaces that fixture with the final context request builder.

```text
durable PoC run data
  → provider-neutral transcript
  → generation-specific rendering
  → stable A+B+C + frozen D
  → deterministic request ready for isolated model tests
```

This phase proves deterministic rendering, stable-prefix growth, direct-reply handling, media projection, and context token estimation before the complete PoC runtime is connected in Phase 4.

## Greenfield PoC assumptions

- Create final context and transcript schemas directly.
- Do not backfill legacy history or memory rows.
- Do not read `History.build` or old prompt-rendering helpers.
- Do not write context rows as a side effect of the legacy runtime.
- Use synthetic fixtures and Phase 2 PoC runs as source data.
- If an abstraction is wrong, replace it now instead of adding a compatibility layer.

## Dependencies

- Phase 2 supplies immutable PoC inputs, finalized runs, delivered actions, durable tool state, and lane serialization.
- Phase 1 supplies model profiles and normalized usage.
- Phase 0 supplies the cache strategy for the exact model.

## Context identity

```text
ContextGeneration
  conversation key
  generation number
  model-profile fingerprint
```

One lane has one active generation. A generation freezes every input that can alter its stable prefix.

## Required persistence

### ConversationContext

Conceptual fields:

```text
id
assistantId + chatId + threadKey
generation
status: active | checkpointing | sealed | superseded
parentContextId nullable
modelProfileFingerprint
stableEnvelope rendered data/hash
frozenMemory rendered data/hash
summaryThroughInputSequence nullable
retainedFromTurnOrdinal nullable
estimatedStableTokens
lastObservedInputTokens
lastObservedCacheReadTokens
createdAt + sealedAt
resetReason nullable
```

Enforce one active context per conversation lane.

### Provider-neutral transcript turn

Provider-neutral immutable content supports future renderer/model changes:

```text
conversation key + global turn ordinal
run ID
kind
canonical content
source input/action/tool IDs
visibility/delivery state
createdAt
```

Kinds include:

```text
user-message
linked-reply-context
assistant-message
assistant-ignore
tool-call
tool-result
tool-error
media-projection
edit-correction
system-event
```

### ConversationContextTurn

Generation-specific immutable rendering:

```text
context ID
turn ordinal inside generation
source transcript turn ID
role
rendered content
render version
estimated tokens
segment hash
rolling prefix hash
```

Retained turns can reference the same provider-neutral transcript but receive a new generation rendering when the profile changes. Inside one generation, old rendered content never changes.

Use `bun run db:migrate` and `bun run db:generate`. Do not backfill all chats.

## Lazy generation creation

Create the first context when a PoC lane is created or first used.

```text
lane has no context
  → choose current model profile
  → freeze stable system/tool/output envelope
  → start with an empty checkpoint memory or explicit PoC seed fixture
  → no legacy raw-history import
  → render new finalized PoC turns once
  → create generation 1
```

No backfill or legacy memory seed exists. Phase 6 introduces new scoped memory revisions.

## Stable envelope

The stable envelope includes more than the system text:

```text
system instructions
tool definitions and order
tool choice defaults
structured-output schema
reasoning settings
provider/cache options that affect serialization
renderer version
```

Changing one field creates a new model-profile fingerprint and requires a new generation before Phase 4.

Store the rendered envelope or enough immutable encoded data to reproduce it after a deployment.

```text
deploy changes system prompt
  → existing generation keeps old frozen envelope
  → next planned profile transition starts a new generation
```

An urgent security prompt update can force a context transition instead of continuing old instructions.

## Prompt regions

```text
A  frozen envelope
   │
   ▼
B  frozen context memory
   │
   ▼
C  finalized immutable context turns
   │
   ├── reusable logical prefix
   ▼
D  current run data
   date + input batch + sender memory placeholder + linked context + live media
```

Phase 3 renders D but does not persist D into C until the corresponding run is finalized.

For implicit cache profiles, do not add a moving explicit cache marker. The common prefix is observed through deterministic A+B+C rendering.

## Segment and prefix hashing

A single changed final hash does not prove append-only growth. Keep a segment hash chain:

```text
h0 = hash(stable envelope + frozen memory)
h1 = hash(h0 + rendered turn 1)
h2 = hash(h1 + rendered turn 2)
h3 = hash(h2 + rendered turn 3)
```

Next request:

```text
old terminal h3 appears unchanged
new turn 4 creates h4
new turn 5 creates h5
```

Append-only assertion:

```text
previous segment hashes == exact leading segment hashes of current A+B+C
```

Also compare the serialized bytes or canonical encoded values at segment boundaries. Hashes support observability; deterministic serialization owns correctness.

Never log raw segment content.

## Deterministic rendering

One renderer owns each generation's model-facing representation.

Freeze:

```text
role
sender label and stable sender identity
message/reply IDs
text and caption
forward origin projection
attachment projection
tool call/result projection
assistant delivery-visible content
serialization order and omitted-field rules
```

Rules:

- Do not render a timestamp in the stable prefix unless its exact frozen value is part of the turn.
- Do not use locale-sensitive number or date formatting.
- Sort object fields only through one canonical encoder; do not rely on incidental mutation order.
- Do not include changing CDN signatures, request IDs, or current date in C.
- Do not rebuild an old turn from a mutable `Message` row.
- Store trusted metadata separately from untrusted user text.

## Finalization projection

Phase 2 finalizes a PoC run after Telegram delivery is terminal. The context owner then appends provider-neutral turns and generation renderings.

```text
finalized run
  → append each source user message in order
  → append linked reply context when needed
  → append stable media projection
  → append durable tool calls/results selected for future context
  → append delivered assistant actions
  → append bounded ignore/failure marker when policy requires it
```

One transaction appends all interaction units and advances the context's estimated token count.

Do not append an undelivered assistant message as if the user saw it.

## Direct replies

### Target already in C

```text
current user turn replies to turn 40 already in C
  → D contains reply ID/reference
  → no duplicate target text
```

### Target outside C

```text
old target #10 is outside current generation
  → load raw target as linked D context
  → freeze a bounded linked-context projection
  → after run, append that projection at the end before current user turn
```

The old target is never inserted back at its historical position:

```text
wrong  C turn 1, turn 2, insert old #10, turn 3
right  C turn 1, turn 2, turn 3, linked #10, current reply turn
```

### Target unavailable

If the required reply target was deleted or cannot be decoded:

```text
reply ID + "target unavailable" marker
```

Do not silently point the model at a different message.

## Current date and volatile metadata

The PoC system policy keeps the date in a trusted D block:

```text
A  stable system instructions
...
D  trusted request metadata: current date YYYY-MM-DD
   untrusted Telegram input follows
```

User text cannot override the trusted metadata label.

Other D-only values:

```text
run ID
current sender memory
live direct-reply content
live binary media
temporary retrieval context
```

Run IDs are normally observability data and should not be sent to the model unless needed.

## Media rendering

### Live request

```text
immutable S3 object/version
  → verify digest
  → load bytes for D
  → send model-supported media part
```

### Future stable context

```text
attachment type + MIME + digest + stable description/reference
```

Do not persist base64 into context storage. Do not persist a changing signed URL.

If no stable summary exists:

```text
current run can use live bytes
future C uses bounded factual placeholder
  "[Attached image image/jpeg, digest …; no description available]"
```

Phase 6 can add richer memory extraction. Phase 3 must not invent a summary that no model or deterministic processor produced.

## Tool rendering

Persist complete run-level tool state, but project only bounded useful content into C.

```text
tool call     name + canonical input
tool success  bounded text/structured projection
tool error    stable error category + safe message
```

Keep call/result together as one interaction unit for future compaction.

Changing truncation rules changes the renderer version. It does not rewrite an active generation.

## Assistant actions

The current model returns structured Telegram actions. Context should show what users observed, not internal delivery JSON.

```text
generated action  text reply to #123
Telegram delivery succeeds
  → C assistant turn contains delivered reply text + target metadata
```

For reactions:

```text
reaction delivered
  → append bounded assistant-action turn if it affects future understanding
```

For ignore:

```text
model intentionally ignored batch
  → user messages still append
  → optional stable no-reply marker, never a fake Telegram message
```

## Token estimation

Start with a conservative character-ratio estimator. Do not reuse a legacy helper only for compatibility, and do not add a tokenizer dependency unless PoC measurements prove it necessary.

For each PoC request record:

```text
estimated A tokens
estimated B tokens
estimated C tokens
estimated D tokens
estimated total input
observed provider input tokens when an isolated model test runs
estimation error and ratio
```

Pure rendering tests establish deterministic size. Isolated provider calls calibrate the estimator. Phase 4 adds full end-to-end observations.

## PoC context validation

Validate behaviorally required dimensions against explicit fixtures and user rules:

```text
source message IDs selected
source order
sender labels
direct-reply target
media included live and projected for future
tool context included
memory source revisions
estimated token size
stable segment chain
```

Do not compare serialized messages to the old implementation. The PoC owns its final order and representation.

Classify differences:

```text
fixture expectation
missing required context
extra sensitive context
nondeterministic rendering
token-budget risk
unknown
```

## Context lifecycle example

```text
run 1 finalizes
  → create generation 1 from PoC transcript state
  → append run 1 turns
  → store terminal prefix chain h12

run 2 prepares
  → rebuild A+B+C from immutable context
  → verify terminal h12
  → render D for run 2

run 2 finalizes
  → append turns
  → terminal prefix becomes h16
```

Phase 3 can invoke the model only through explicit isolated PoC tests. Normal end-to-end queue and Telegram integration begins in Phase 4.

## Profile transition

Test a controlled system/renderer/model-profile change:

```text
generation 1 profile P1
  → requested profile P2
  → freeze/seal P1
  → create generation 2 from canonical retained turns
  → render once with P2
```

Do not copy P1 provider-specific rendering into P2 when the new model needs a different media or tool format.

## Edge cases

### Raw message edits old content

The provider-neutral transcript and rendered context remain unchanged. The admitted edit becomes a new correction turn.

### Attachment summary changes in storage

An active context keeps its stored projection. The new summary can become available only in a future turn or generation.

### A future memory revision publishes

Generation B remains unchanged. Deterministic context tests verify that an external revision cannot leak into active B.

### Deployment cannot render the old profile

Because A, B, and C renderings are stored, a normal append can continue. If new D rendering is incompatible, force a controlled profile transition instead of mutating the old generation.

### One finalized run has no delivered assistant action

Append source user turns and terminal run marker according to policy. The context ordinal still advances deterministically.

### Tool result contains unstable URLs or current timestamps

The model-visible C projection freezes a bounded value once. A future renderer change does not rewrite it.

### Same linked target is used several times

If already present in C as a linked-context turn, reference its context turn ID rather than appending the full target again unless the model needs a new bounded projection.

### Context transaction retries

Use run ID and source transcript IDs as uniqueness keys. A retry appends zero duplicate turns.

### Provider-neutral and rendered data disagree

Mark the generation invalid. Do not repair rendered rows in place. Fix the renderer and start a new PoC generation.

## Observability

Record without content:

```text
context/generation/profile IDs
stable segment count
prefix byte length and estimated tokens
prior terminal hash match
PoC source-message count
fixture/source-set differences
linked-context count
live/stable media projection count
tool projection count
render duration
estimation error
invalid-generation count
```

## Tests

Required behavior tests:

1. Appending one text interaction preserves every previous segment and rolling hash.
2. The current date changes D but not A+B+C.
3. A new memory note does not change active B.
4. A direct target outside context appends as linked context at the end.
5. A direct target already in C is not duplicated.
6. An edited message appends a correction instead of mutating an old turn.
7. An attachment keeps the same stable projection for the generation.
8. Live base64 is not persisted in context storage.
9. Tool call and result remain one ordered interaction unit.
10. Undelivered assistant text is not rendered as user-visible C.
11. A repeated finalization transaction creates no duplicate turns.
12. A profile change creates a new generation and does not rewrite the old one.
13. Two independently rendered copies of the same canonical input are byte-identical.
14. A changed renderer rule changes the renderer/profile version.

Use real Prisma test storage. No model call is required for pure renderer tests. Run narrow tests and `bun run lint`.

## Exit gate

Phase 3 passes when representative PoC fixtures and isolated model tests show:

```text
all normal appends preserve the previous segment chain
  + no mutable memory changes active B
  + direct replies retain their targets without reordering C
  + media and tools have stable bounded projections
  + profile changes create new generations
  + isolated provider requests use the exact deterministic render
  + fixture/source differences are classified and accepted
  = context path is ready for end-to-end PoC integration
```

## PoC failure handling

Stop Phase 4 integration. Keep invalid PoC rows for diagnosis or recreate the disposable PoC database after fixing the schema/renderer. Do not add a legacy rendering adapter or import old history to make a failing fixture pass.
