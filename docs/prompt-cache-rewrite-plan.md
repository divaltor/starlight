# Conversation Runtime and Prompt Cache Rewrite

## Status

This is the master implementation plan for a greenfield `apps/starlight` conversation runtime proof of concept.

```text
COMPLETE     Phases 0–1 provider proof and model boundary
IMPLEMENTED  Core Phases 2–6 runtime through scoped memory and DMs
GAPS         Media/album admission and bounded stable tool projection
NEXT         Close known gaps, then Phase 7 live acceptance and hardening
```

It replaces the earlier history-only proposal. Batching, distributed concurrency, durable retries, cross-chat memory, direct messages, and context checkpoints require changes beyond prompt selection.

The PoC can create new domain abstractions, Effect services, queue contracts, and Prisma models directly. It does not preserve the old history builder, old memory semantics, handler-owned model flow, old cache-control behavior, or old database interfaces for compatibility.

```text
existing runtime  reference behavior only
new PoC runtime   one coherent architecture from admission to delivery

no dual prompt path
no old/new per-lane fallback
no legacy context backfill
no compatibility adapters around obsolete abstractions
```

During development, the PoC can use isolated entrypoints, queues, and tables. After acceptance, it replaces the old runtime as one planned change. Failure handling stops or fixes the PoC; it does not require maintaining the old architecture inside the new domain.

No phase can weaken these rules:

- PostgreSQL owns durable conversation state.
- BullMQ wakes work; it does not own message data or progress.
- One chat topic has at most one active reply or checkpoint run.
- Different chat topics can run at the same time.
- Finalized prompt history is append-only inside one context generation.
- Provider cache state is an optimization, never correctness state.
- User, chat, and topic memory are separate from context compaction.
- No LLM, tool, S3, Redis, or Telegram API call runs inside a database transaction.

## Plan documents

Each phase has its own implementation plan, edge-case flows, tests, acceptance gate, and PoC failure rules.

| Phase | Document                                                                                              | Outcome                                                        |
| ----: | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
|     0 | [Provider cache proof result](./prompt-cache-rewrite/phase-0-provider-cache-proof-RESULT.md)          | Complete: selected and measured the provider cache contract    |
|     1 | [Effect model boundary result](./prompt-cache-rewrite/phase-1-effect-model-boundary-RESULT.md)        | Complete: AI SDK is behind Effect with safe complete telemetry |
|     2 | [Durable admission, lanes, and batching](./prompt-cache-rewrite/phase-2-conversation-lanes-PLAN.md)   | Serialize each topic and coalesce Telegram bursts safely       |
|     3 | [Context generations](./prompt-cache-rewrite/phase-3-context-generations-PLAN.md)                     | Build the final immutable context model directly               |
|     4 | [End-to-end context runtime](./prompt-cache-rewrite/phase-4-end-to-end-runtime-PLAN.md)               | Integrate the PoC from prepared run through finalized context  |
|     5 | [Checkpoints and compaction](./prompt-cache-rewrite/phase-5-checkpoints-PLAN.md)                      | Add soft cost and hard safety checkpoints                      |
|     6 | [Scoped memory and direct messages result](./prompt-cache-rewrite/phase-6-memory-and-dms-RESULT.md)   | Implemented; live privacy and memory-quality review remains    |
|     7 | [Hardening and runtime replacement](./prompt-cache-rewrite/phase-7-hardening-and-replacement-PLAN.md) | Prove the PoC, then replace and delete the legacy runtime      |

## Phase dependency map

The phases are ordered to isolate failures inside the PoC. They create final abstractions directly instead of passing legacy types through compatibility layers.

```text
Phase 0  provider proof ✓
   │
   ▼
Phase 1  Effect model boundary + usage ✓
   │
   ▼
Phase 2  durable input + lane serialization + batching ✓
   │
   ▼
Phase 3  immutable context generations ✓
   │
   ▼
Phase 4  end-to-end context runtime ✓
   │
   ▼
Phase 5  checkpoints and compaction ✓
   │
   ▼
Phase 6  scoped memory + DMs (implemented; acceptance pending)
   │
   ▼
Phase 7  hardening + atomic legacy replacement
```

Phase 0 is a PoC architecture gate. If the actual model does not reuse a growing stable prefix, the context architecture remains useful, but the cost policy must not assume prefix-cache savings.

## Greenfield PoC rules

1. Define final domain names and contracts now. Do not wrap `History.build`, `ChatMemoryNote`, or handler-owned generation behind new names.
2. New persistence starts with new tables and no legacy context or memory backfill.
3. Raw Telegram data can remain an input source, but mutable legacy prompt projections are never reused as finalized context.
4. Phase boundaries are implementation checkpoints, not production dual-path releases.
5. Tests target the final PoC behavior. They do not assert byte or call compatibility with the old implementation.
6. Existing user-visible rules are requirements only when explicitly retained in this plan, such as Telegram targeting, one web lookup, and supported media.
7. Once the PoC is accepted, remove replaced code instead of retaining fallback switches.
8. Schema cleanup does not preserve obsolete memory or context APIs. Any production data migration is a separate deployment decision, not a PoC compatibility requirement.

## Why the removed runtime was insufficient

The runtime deleted at the start of Phase 0 did this:

```text
Telegram message
  → save mutable Message row
  → wait 1–3.5 seconds
  → drop this reply if a newer topic message exists
  → rebuild 17-message history + latest mutable memories
  → call AI SDK in the grammY handler
  → send Telegram actions
```

Removed owners:

- handler-owned model execution, delay, and stale-message drop;
- mutable 17-message history and memory reconstruction;
- private-message storage skip;
- output-only model result that discarded usage;
- model-name cache-control helper;
- count-based memory workers.

Those source files no longer exist in `apps/starlight`. Their behavior is historical design evidence only.

The old generation CAS protected only resets. It did not protect normal runs:

```text
same topic, no lane lock

worker A reads prefix P ──▶ model sees P + A ──▶ reply A
worker B reads prefix P ──▶ model sees P + B ──▶ reply B

result: two replies exist, but neither saw the other request or reply
```

Every model run in one topic must serialize, not only context resets.

## Core identities

### Conversation lane

```text
ConversationKey = assistantId + chatId + threadKey
threadKey       = messageThreadId ?? 0
```

`assistantId` prevents two bots that share the database from sharing one model context.

### Concurrency behavior

```text
group A / topic 10  ──▶ run 1 ──▶ run 2 ──▶ run 3
group A / topic 20  ──▶ run 1 ──▶ run 2
user DM            ──▶ run 1 ──▶ run 2

three lanes may execute in parallel
each individual lane remains serial
```

Multiple people in one topic share one chronological lane. One user speaking in a group and DM uses two lanes but one user-memory namespace.

## Target runtime

### Normal flow

```text
Telegram update
  → normalize and persist raw data
  → admit immutable ConversationInput
  → write durable queue wake
  → BullMQ coalesces lane wake
  → worker claims lane with fencing token
  → worker freezes pending input through watermark W
  → prompt = frozen generation + finalized turns + current batch
  → model and tools run outside transaction
  → generated actions and usage become durable
  → Telegram actions dispatch in order
  → visible transcript finalizes
  → lane releases
  → successor starts if pending watermark advanced past W
```

### Input that arrives during work

```text
run owns inputs 101…105 and invokes model
                       │
message 106 arrives ───┴──▶ durable pending input + successor wake
                       │
current run finishes 101…105
                       │
                       ▼
next run starts at 106
```

The current request never changes after model invocation begins.

### Durable run state

```text
admitted
  → prepared
  → invoking
  → generated
  → dispatching
  → finalized

invoking    → retryable failure → prepared
invoking    → terminal failure
dispatching → delivered | failed | unknown
```

Generated output is stored before Telegram dispatch. A delivery retry uses stored output and never calls the model again.

## System-wide invariants

### Admission

1. A Telegram update or message revision is admitted at most once.
2. A mutable `Message` row is not an immutable prompt event.
3. An admitted input keeps its sender, topic, text, media references, reply target, and forward metadata.
4. The database transaction stores both the input and its durable wake request.

### Lane execution

1. One fenced active run exists per lane.
2. BullMQ deduplication optimizes scheduling; the database fence protects correctness.
3. A run owns an exact admitted-input range.
4. New input never joins a run after its watermark is frozen.
5. A stale worker cannot commit after a newer fence owner takes the lane.

### Model and tools

1. The model profile is pinned before invocation.
2. Retries use the same prepared input and frozen memory revisions.
3. Every provider step records separate usage.
4. Tool calls have durable pending, running, completed, or error state.
5. Side-effecting tools require their own idempotency before automatic retry.

### Delivery

1. Every Telegram action has a stable run-local ordinal.
2. Partial delivery resumes at the first unfinished action.
3. Final prompt history contains user-visible assistant output, not undelivered claims.
4. An ambiguous Telegram send is recorded as `unknown`; product policy decides retry or omission.

### Context

1. One generation has one frozen stable prefix profile.
2. Finalized turns are immutable and ordered.
3. Direct-reply target retrieval never inserts an old record into the middle of finalized history.
4. A checkpoint summarizes an exact finalized boundary.
5. A parent generation has at most one committed child generation.
6. Prompt, tool schema, renderer, or model-profile changes start a new generation.

### Memory

1. Context checkpoints are not long-term semantic memory.
2. User, chat, and topic memory publish independent immutable revisions.
3. Active context is never rewritten when a new memory revision appears.
4. User-memory visibility rules prevent private facts from leaking into groups.
5. Memory generation uses source watermarks and CAS.

## Persistence domains

The exact Prisma interfaces are designed during their owning phase. These are the required durable concepts.

| Domain                      | Main invariant                                              |
| --------------------------- | ----------------------------------------------------------- |
| `ConversationLane`          | One active fenced owner per assistant/chat/topic            |
| `ConversationInput`         | Immutable admitted Telegram event or revision               |
| queue wake outbox           | Database commit cannot lose the Redis wake                  |
| `ConversationRun`           | One frozen batch and model profile per invocation workflow  |
| `ConversationRunAction`     | Ordered and resumable Telegram delivery                     |
| `ConversationToolCall`      | Durable tool lifecycle and immutable completed result       |
| `ConversationContext`       | One frozen context generation                               |
| `ConversationContextTurn`   | Immutable generation-specific prompt rendering              |
| provider-neutral transcript | Supports a future model renderer without losing history     |
| `MemoryRevision`            | Immutable user/chat/topic memory publication                |
| `ModelUsage`                | Per-step billing, cache, provider, and context measurements |

Raw `Message`, `Attachment`, and `MessagePart` remain durable Telegram records. They are not the only copy of model-facing state.

## Prompt and cache model

### Stable prefix and volatile suffix

```text
A  frozen request envelope
   system text + tool schemas + output schema + generation settings
   │
   ▼
B  frozen generation memory
   context checkpoint + selected chat/topic memory revisions
   │
   ▼
C  immutable finalized turns
   user batches + delivered replies + stable tool/media projections
   │
   ├──── logical reusable prefix ends here
   ▼
D  volatile current request
   current date + current batch + linked reply + sender memory + live media
```

For the selected Gemini profile, an explicit breakpoint remains fixed at the end of the generation base in A + B. Finalized turns in C remain append-only and may receive additional implicit reuse, but the cost policy counts only the fixed explicit base. Moving the marker on every turn would create new explicit writes and is not part of the proven profile.

At 25k–75k measured input tokens, current OpenRouter write-plus-read billing was cheaper than cold Gemini input, but new-cache calls averaged 6.8 seconds versus 3.1 seconds for cache reads. Phase 1 does not pay that latency on every turn. A future coarse rebase policy can advance the marker only after enough uncached tail accumulates and separate latency/cost evidence justifies it.

Provider behavior belongs to a model profile:

```text
implicit-prefix       Gemini / native DeepSeek default
explicit-breakpoint   only for a proven provider contract
explicit-cache-object provider resource with write/storage behavior
none                  no reliable cache support
```

The profile also pins:

```text
provider + model + route policy
system prompt version
turn renderer version
tool definitions and order
structured-output schema
reasoning settings
media strategy
context and output limits
prices and cache accounting fields
```

Phase 0 selected this measured profile:

```text
model              google/gemini-3.7-flash
provider endpoint  google-vertex/global
fallbacks          disabled
cache strategy     fixed explicit base + best-effort implicit extension
reasoning effort   minimal
```

`deepseek/deepseek-v4-flash-vision-exp` on the native `deepseek` endpoint showed automatic one-minute cache retention and 95–96% repeat-input savings at 18k–54k actual tokens. It is not selected because named tool choice and strict schema output failed the required endpoint contract, and the sole endpoint is not ZDR-compatible under OpenRouter.

### Cache expiry

```text
generation remains valid
        │
provider cache expires
        │
        ▼
next request is a cold miss
        │
        ▼
same generation warms again
```

Cache expiry does not create a memory job or checkpoint.

## Media projection

```text
live request D
  → immutable S3 object/version + binary vision input
  → model response
  → stable digest/description becomes future C

raw binary remains in storage
changing signed URL never enters C
```

A stable media projection can warm on the next request. Do not reset after every image unless production measurement proves a lasting cache barrier.

## Memory scopes and placement

```text
UserMemory  userId
   └── follows one person across permitted chats

ChatMemory  chatId
   └── shared group rules and facts

TopicMemory chatId + threadKey
   └── one topic's subject and work state
```

Prompt placement:

```text
chat/topic memory selected for generation ──▶ frozen B
current sender memory                     ──▶ bounded D
new memory revision                       ──▶ future request D or next generation B
```

Default privacy rule:

```text
DM fact ──▶ same user's DM                    allowed
DM fact ──▶ group reply                       blocked unless explicitly shareable
group fact ──▶ same group                     allowed
group fact ──▶ unrelated group                blocked by default
public preference ──▶ permitted user contexts allowed
```

## Batching policy

BullMQ gathers a wake burst. PostgreSQL gathers the messages.

```text
first pending input
  → open batch window
  → each new input moves quiet deadline
  → maximum deadline never moves
  → worker claims all eligible inputs through fixed watermark
```

Initial values to validate:

```text
quiet window     750–1,000 ms
maximum wait     2,500–3,000 ms
```

Preserve each sender and source message in the model input:

```text
Alice #101 ─┐
Alice #102 ─┼──▶ one ordered batch ──▶ one model call ──▶ targeted actions
Bob   #103 ─┘
```

Telegram albums stay together. Forwarded messages without a group identifier rely on the bounded quiet window.

## Checkpoint policy

### Soft cost checkpoint

```text
reply with old generation
  → deliver current answer
  → keep lane claimed
  → summarize sealed finalized boundary
  → publish next generation
  → process messages that queued during summary
```

The current user does not wait for the summary. The next message in that topic can wait. Other topics continue.

### Hard safety checkpoint

```text
pending request would exceed safe model budget
  → checkpoint before model reply
  → publish smaller generation
  → run pending request
```

The current user waits because exceeding the model limit is not allowed.

### Retained tail

Keep complete interaction units:

```text
user batch + assistant actions
tool call + tool result
message + media projection
```

Do not cut at an exact token boundary if it splits one of these units.

## Cost policy

At the prices used in the earlier proposal:

| Prefix | Warm cached input | Cold input |
| -----: | ----------------: | ---------: |
|    30k |         $0.001125 |   $0.01125 |
|    64k |         $0.002400 |   $0.02400 |
|   128k |         $0.004800 |   $0.04800 |

A 600-token output costs about `$0.001125`. A warm 128k prefix is not too cheap to meter.

Do not make a checkpoint decision from one turn's cost:

```text
checkpoint cost paid now
        │
        ▼
savings require unknown future turns

break-even turns ≈ checkpoint overhead / expected later per-turn saving
```

Runtime policy uses:

```text
hard safety cap   model-limit protection
soft cost cap     fixed profile threshold selected from real traces
```

Pricing remains telemetry. Thresholds are recalculated offline when traffic, quality, cache behavior, or model prices change.

Initial cost-cap experiments:

```text
16k ── 24k ── 30k ── 48k total serialized input
```

Do not define the cap as only active history. Include system, memory, tools, transcript, live input, and reserves.

## Effect and OpenCode design rules

Copy these OpenCode concepts:

```text
durable input admission ──▶ advisory wake
one serialized runner per conversation key
explicit assistant/tool lifecycle
frozen context epoch
compaction as durable state
```

Do not copy OpenCode's process-local coordinator as distributed correctness. Starlight needs PostgreSQL fencing plus BullMQ coordination.

Use Starlight's flat Effect convention:

```text
Conversation.Service   Context.Service class
Checkpoint.Service     Context.Service class
Memory.Service         Context.Service class
Model.Service          Context.Service class

Prompt                 pure deterministic module
ModelProfile           pure capability/pricing module
ConversationKey        pure identity module
```

Consumers use module-style names such as:

```ts
import * as Conversation from "@/conversation/conversation";
```

Do not add TypeScript `namespace` wrappers, static utility classes, or Controller → Service → Repository pass-throughs.

Keep AI SDK behind `Model.Service` in the first release:

```text
Effect conversation workflow
  → Model.Service
  → AI SDK generateText
  → OpenRouter provider
```

This keeps current structured output and tools while making a future model adapter replaceable.

## Phase summaries and gates

### Phase 0 — Provider cache proof

Prove prefix reuse, cache thresholds, idle behavior, tools, media, and routing for the exact deployed model.

```text
no proof ──▶ no cache-cost assumptions ──▶ PoC profile must change
```

Exit only when cached-input usage is observable and repeatable enough to choose a PoC cache profile.

### Phase 1 — Effect model boundary

Completed. The application-owned boundary returns the durable-domain data needed by later phases while provider details remain private to the adapter and telemetry.

```text
AI SDK result
  → decoded output + canonical transcript + immutable tool events
  → normalized per-step and billing usage
  → typed Effect result
```

The accepted live trace contains AI SDK provider spans plus safe normalized step and generation summaries with no recorded prompt or output content. See the Phase 1 result document for evidence.

### Phase 2 — Durable admission, lanes, and batching

Create durable admission, lane execution, and batching as new PoC boundaries. Use a minimal PoC prompt fixture until Phase 3 supplies the final context prompt.

```text
PoC ingress    ──▶ persist + admit + wake ──▶ return
BullMQ worker  ──▶ claim + PoC prompt + model + delivery
```

Exit when same-lane overlap, lost wake-ups, duplicate jobs, and partial delivery are covered.

### Phase 3 — Context generations

Build the final context-generation model and deterministic prompt projection directly.

```text
provider-neutral transcript
  → generation-specific immutable rendering
  → A+B+C stable prefix + prepared D
```

Exit when deterministic rendering and prefix growth invariants hold for text, replies, media, and tools in isolated PoC tests.

### Phase 4 — End-to-end context runtime

Connect the PoC admission, lane, context, model, delivery, and finalization boundaries into one end-to-end runtime.

```text
admit ──▶ batch ──▶ context request ──▶ model ──▶ delivery ──▶ finalized C
```

Exit when normal PoC turns append without prefix mutation and delivery retries do not duplicate model calls.

### Phase 5 — Checkpoints

Enable soft cost and hard safety compaction.

```text
normal append ──▶ soft cap ──▶ post-reply checkpoint
oversized next request ──────▶ pre-reply hard checkpoint
```

Exit when one parent creates one child, queued messages survive, and summary quality passes PoC evaluation.

### Phase 6 — Scoped memory and DMs

Implemented. User, chat, and topic observations now publish immutable revisions through a separate durable memory queue. Direct messages use an explicit user whitelist. Prepared runs freeze user-memory revision IDs, and context generations freeze chat/topic revisions. `/forget` waits for active user lanes, records durable tombstones, and resets affected context generations before later prompts.

```text
finalized conversation events
  → memory observations
  → scoped revision builders
  → privacy-filtered prompt projection
```

Static privacy checks and PostgreSQL integration tests pass. Exit still requires live builder-quality evaluation and an explicit privacy review; see the Phase 6 result document.

### Phase 7 — Hardening and runtime replacement

Run final PoC load, recovery, privacy, cost, and quality gates. After explicit acceptance, replace the legacy entrypoint and delete the old history, count memory, handler-owned generation, and model-name cache helpers without compatibility shims.

```text
PoC proven ──▶ stop legacy runtime ──▶ activate PoC runtime ──▶ delete legacy code
```

Exit when the PoC runtime passes acceptance, the legacy runtime is no longer reachable, and operational recovery is documented.

## System edge-case ownership

| Edge case                                          |                      Owning phase |
| -------------------------------------------------- | --------------------------------: |
| Model cache has no useful hits                     |                                 0 |
| Cache usage fields are missing or inconsistent     |                              0, 1 |
| Multi-step tool usage is mistaken for context size |                                 1 |
| Duplicate Telegram update                          |                                 2 |
| Queue add fails after database commit              |                                 2 |
| Two workers run one topic                          |                                 2 |
| Message arrives during model invocation            |                                 2 |
| Worker crashes after generation                    |                                 2 |
| Telegram send result is unknown                    |                                 2 |
| Same message renders differently later             |                                 3 |
| Direct reply points outside active context         |                                 3 |
| Edited message would mutate old prompt             |                                 3 |
| Prompt or tool schema changes on deploy            |                              3, 4 |
| Provider fallback causes a cold miss               |                                 4 |
| Tool or media projection grows beyond budget       |                              4, 5 |
| Message arrives during checkpoint                  |                                 5 |
| Checkpoint fails below or at hard cap              |                                 5 |
| Retained tail splits a tool exchange               |                                 5 |
| User speaks in DM and group at the same time       |                                 6 |
| Private memory could appear in a group             |                                 6 |
| User asks the bot to forget something              |                                 6 |
| Legacy data does not fit the new schema            | 7; no compatibility import in PoC |

## Product decisions to confirm

These defaults allow implementation planning to continue. Change them before the owning phase starts if needed.

| Decision                         | Proposed default                                                                                                      | Owning phase |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -----------: |
| Who can use DMs?                 | Known group members plus explicit whitelist                                                                           |            6 |
| Can DM facts appear in groups?   | No, unless explicitly shareable                                                                                       |            6 |
| One call for a multi-user burst? | Yes, with separate source messages and reply targets                                                                  |            2 |
| Quiet and maximum batch delay    | 1 second quiet, 3 seconds maximum                                                                                     |            2 |
| Ambiguous Telegram send          | Prefer possible duplicate over silent omission                                                                        |            2 |
| New input during model call      | Queue for next run; no steering                                                                                       |            2 |
| Soft checkpoint latency          | Deliver current reply, then block only that lane                                                                      |            5 |
| AI SDK after Effect rewrite      | Keep it behind the new `Model.Service` initially                                                                      |            1 |
| Initial cache profile            | `google/gemini-3.7-flash` on `google-vertex/global`, fixed explicit base, best-effort implicit extension, no fallback |            0 |
| Initial cost cap                 | Compare 24k, 30k, and 48k from traces                                                                                 |            5 |

## Repository and validation rules

- All implementation imports in `apps/starlight` use `@/`.
- Use Bun and repository scripts.
- Prisma changes use `bun run db:migrate` and `bun run db:generate`.
- Never hand-edit generated Prisma files or migrations.
- Run narrow tests for changed behavior.
- Run repository `bun run lint` after code changes.
- Run the web build only if `apps/web` changes.
- Keep structured log messages stable and put IDs in fields.

## Final acceptance

The rewrite is complete only when production evidence shows:

```text
same topic       one serial run at a time
different topics concurrent progress
burst input      no dropped messages and bounded latency
normal prompt    stable growing prefix
cache telemetry  real read/write/miss accounting by provider step
checkpoint       one child generation and no lost queued input
delivery retry   no repeated model invocation after output is durable
memory           user continuity without cross-chat privacy leak
context          remains below hard model limit
cost             lower input cost per useful reply
quality          no material regression after compaction
legacy runtime   removed after PoC acceptance
```

The normal rule remains simple:

```text
admit durably → serialize by lane → append finalized turns
soft cap      → answer, then compact
hard cap      → compact, then answer
every call    → measure provider usage
cache expiry  → accept one cold miss; do not rewrite memory
```
