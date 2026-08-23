# Phase 2 PLAN — Durable Admission, Conversation Lanes, and Batching

## Purpose

Create a new durable PoC ingress and one distributed serial lane per assistant/chat/topic.

This phase solves concurrency, batching, retries, and partial delivery with a minimal fixed PoC prompt fixture. Context generations are not active yet.

```text
Phase 2 creates the final run/queue lifecycle
Phase 3 replaces the temporary prompt fixture with final context generations
```

Separating these changes makes queue and prompt failures diagnosable. Do not use the old 17-message builder, handler delay, or stale-message logic as temporary adapters.

## Greenfield PoC assumptions

- New ingress, lane, run, action, tool, and queue contracts can replace existing abstractions.
- New Prisma tables start empty. No legacy queue/run backfill is required.
- The existing grammY handler is reference behavior, not a compatibility target.
- The PoC can run through an isolated bot entrypoint, queue name, Redis prefix, and database schema/data set.
- Tests assert the final lane invariants, not old handler call order.

## Dependencies

- Phase 1 supplies `Model.Service` and complete generation results.
- PostgreSQL remains the source of message data and progress.
- Installed BullMQ `6.2.0` supports deduplication debounce and `keepLastIfActive`.
- Private chats remain outside the PoC scenario set until Phase 6.

## Conversation key

```text
ConversationKey
  assistantId
  chatId
  threadKey = messageThreadId ?? 0
```

The key must have one canonical encoding for:

- database uniqueness;
- BullMQ deduplication ID;
- logs and spans;
- stable provider affinity hash;
- metrics.

Do not build keys with ambiguous string concatenation:

```text
bad   12:34:5 if a component can contain the separator
good  canonical schema encoding → stable hash for Redis/provider use
```

Telegram IDs remain safe `number` values in app code and convert to `BigInt` only at the Prisma boundary.

## Target boundaries

### grammY update path

```text
Telegram update
  → parse and validate Telegram boundary
  → store raw Message/Attachment data
  → admit immutable ConversationInput when relevant
  → store queue wake outbox row in same transaction
  → return to grammY runner
```

No model, tool, batching delay, or Telegram AI dispatch runs in this path.

### BullMQ worker path

```text
lane wake
  → claim lane
  → freeze batch watermark
  → evaluate batch reply eligibility
  → prepare durable run
  → build old prompt
  → call Model.Service
  → record generated actions
  → dispatch actions
  → finalize progress
  → release lane
```

## Required persistence

### ConversationLane

Conceptual fields:

```text
assistantId + chatId + threadKey       primary identity
pendingRevision                       increments on admitted input
processedRevision                     latest terminal input progress
activeRunId                           nullable
fencingToken                          monotonic
leaseOwner                            nullable
leaseUntil                            nullable
firstPendingAt                        bounded debounce anchor
nextWakeAt                            current desired wake time
createdAt + updatedAt
```

### ConversationInput

This is an immutable admission record, not a replacement for raw `Message`:

```text
id / global admitted sequence
conversation key
source Telegram update ID
source message ID and revision identity
sender user identity
canonical immutable Telegram payload
reply target
forward metadata
media object versions/digests
admitted revision
claimed run ID nullable
createdAt
```

An edited Telegram message creates an edit/correction input. It does not rewrite an input already used by a model.

### ConversationRun

```text
run ID
conversation key
fencing token
input start/end revision and exact IDs
status
prepared request references/hash
model profile ID
reply-eligibility decision
attempt count
generated output
provider IDs and usage summary
error state
timestamps
```

### ConversationRunAction

```text
run ID + ordinal
action type
target Telegram message ID
immutable action payload
delivery status
Telegram result message ID or reaction result
attempt count
last error
timestamps
```

### ConversationToolCall

```text
run ID + provider call ID
tool name
input hash and immutable input
pending | running | completed | error
bounded model-visible result
raw result reference when retained
timestamps
```

### Queue wake outbox

```text
conversation key
pending revision
desired wake time
publishedAt nullable
attempt count
```

The exact Prisma schema is designed with the Phase 2 interfaces. Create it only with `bun run db:migrate`, then regenerate with `bun run db:generate`.

## Durable admission

Admission and the wake request must commit together:

```text
DB transaction
  → upsert latest raw Message state
  → insert immutable ConversationInput if new
  → increment lane pendingRevision
  → update firstPendingAt/nextWakeAt
  → insert or update wake outbox
commit
```

Then an outbox publisher adds or updates the BullMQ wake.

Current behavior schedules memory after commit and logs queue failure. Do not copy that for reply correctness:

```text
DB committed + Redis unavailable
  → outbox remains unpublished
  → publisher retries
  → wake is eventually sent
```

## Idempotent admission

Use the Telegram update ID when available. Also protect the logical message revision.

```text
first delivery   insert input + revision N
retry delivery   uniqueness conflict → return existing input
edit delivery    new revision identity → append correction input
```

A duplicate must not increment `pendingRevision` twice.

If raw message storage succeeds but immutable admission conflicts, the existing admission wins. Verify its conversation identity before accepting it as an exact retry.

## Reply eligibility

Evaluate eligibility from the frozen batch, not independently after a random delay for each message.

Priority:

```text
explicit command handled elsewhere       ──▶ no AI run
direct mention or reply to bot in batch  ──▶ reply eligible
private DM in Phase 6                     ──▶ DM policy
low-signal-only batch                     ──▶ no reply
probabilistic group participation         ──▶ one persisted decision per batch
```

Persist probabilistic decisions. A retry must not roll randomness again.

When one message directly invokes the bot and following forwards arrive inside the batch window, the invocation remains sticky for that batch.

```text
message 101  "@bot look at these"
message 102  forwarded item
message 103  forwarded item
                    │
                    ▼
one eligible batch 101…103
```

## Burst window

Initial target:

```text
quietWindow = 1 second
maxWait     = 3 seconds
```

Timeline:

```text
0.0s  message A ──▶ open batch, quiet deadline 1.0s, max deadline 3.0s
0.6s  message B ──▶ quiet deadline moves to 1.6s
1.2s  message C ──▶ quiet deadline moves to 2.2s
2.2s              ──▶ worker can start
```

Continuous traffic cannot postpone forever:

```text
0.0s first message
0.8s next
1.6s next
2.4s next
3.0s maximum deadline ──▶ freeze current watermark and run
```

New input after the watermark becomes the successor batch.

## BullMQ wake options

Use a delayed deduplicated job per lane:

```ts
{
  delay: computedDelay,
  deduplication: {
    id: laneDeduplicationId,
    ttl: computedDelay,
    extend: true,
    replace: true,
    keepLastIfActive: true,
  },
}
```

Job data contains only:

```text
conversation key
observed pending revision
```

Do not put message bodies, media bytes, or a complete batch in Redis.

`replace: true` means latest job data wins. PostgreSQL preserves all inputs.

### Maximum wait implementation

Trailing debounce alone has no maximum. The producer computes:

```text
quietWake = latestInputAt + quietWindow
hardWake  = firstPendingAt + maxWait
nextWake  = min(quietWake, hardWake)
```

The lane row is authoritative. A stale delayed job reads `nextWakeAt` and either:

```text
now < nextWakeAt ──▶ reschedule/no-op
now ≥ nextWakeAt ──▶ try lane claim
```

## Lane claim and fencing

BullMQ prevents normal same-key overlap. PostgreSQL protects against stale workers and non-queue callers.

Claim transaction:

```text
read lane
  → active lease valid?     yes ──▶ no-op; successor remains pending
  → active lease absent/old no  ──▶ increment fencingToken
                              → set activeRunId + lease owner/expiry
                              → freeze pending watermark W
                              → create prepared run
```

Every later write includes:

```text
lane key + activeRunId + expected fencingToken
```

Stale owner example:

```text
worker A owns fence 7 ──▶ event loop stalls ──▶ lease expires
worker B owns fence 8 ──▶ completes run
worker A resumes      ──▶ update WHERE fence = 7 affects zero rows
                       ──▶ A discards result and sends nothing
```

The lease is a logical ownership record, not a database transaction held during provider work.

## Batch selection

Select admitted inputs in lane order through frozen watermark W.

```text
pending revisions 31 32 33 34 35
worker freezes W = 34
batch            31 32 33 34
revision 35      next run
```

Batch limits:

- maximum source messages;
- maximum estimated live-input tokens;
- media count/size policy;
- complete Telegram album units;
- no split inside one admitted message.

If the first pending interaction unit alone exceeds the batch limit, prepare it as an oversized single input and let the model/context boundary return a controlled size error. Do not leave it pending forever.

## Multiple users in one topic

Preserve each user turn:

```text
Alice #201: question A ─┐
Bob   #202: question B ─┼──▶ one ordered model batch
Alice #203: detail C   ─┘
```

The Phase 2 reply schema expands allowed targets from one live message to all eligible message IDs in the batch.

The model can return:

```text
one group reply targeting #203
or separate actions targeting #201 and #202
or ignore selected messages
```

Keep the configured action limit. If batch size can exceed that limit, the prompt must tell the model to combine related answers rather than silently exceed the schema.

## Forwarded messages and albums

### Telegram album

```text
same media_group_id
  → one interaction unit
  → wait within bounded batch window
  → never split across runs when all parts arrived before W
```

### Forwarded burst without group ID

```text
same lane + close arrival times
  → quiet-window grouping
  → preserve each forward origin
```

No heuristic can know with certainty that a person finished forwarding. The maximum wait is the latency bound, not a perfect semantic boundary.

## Prepared request

Before model invocation, persist:

```text
exact input IDs and order
reply eligibility result
old-history prompt references
current request metadata
model profile
toolset version
media object versions/digests
request hash
```

Do not persist large base64 media in PostgreSQL. Persist immutable object references and digests so a retry reads the same bytes.

## Model invocation and durable generation

```text
prepared run
  → mark invoking with attempt N
  → Model.Service outside transaction
  → short fenced transaction
       persist decoded actions
       persist provider/tool events
       persist usage
       mark generated
```

If the provider call succeeds but the database commit fails, the attempt can repeat. Provider invocation cannot be exactly-once. The fence ensures that only one accepted result can dispatch.

## Tool lifecycle

```text
provider emits call
  → insert pending call
  → mark running
  → execute read-only tool
  → store completed/error result
  → continue model step
```

If AI SDK executes the tool within one process callback, publish state at the earliest safe hooks available. At minimum, the complete call/result sequence must be persisted with generated output before dispatch.

Future side-effecting tools need an idempotency key based on run and tool-call identity.

## Telegram action dispatch

Actions dispatch by ordinal:

```text
action 0 ──▶ delivered, Telegram message 9001
action 1 ──▶ timeout, outcome unknown
action 2 ──▶ not attempted
```

On retry:

```text
action 0 skip
action 1 apply unknown-outcome policy
action 2 wait until action 1 is terminal
```

Do not call the model again after run status is `generated`.

### Initial ambiguous-send policy

Proposed default:

```text
unknown send outcome ──▶ retry once with duplicate-risk metric
```

This prefers eventual delivery over strict duplicate avoidance. Confirm before implementation.

## Finalization

After action delivery is terminal:

```text
fenced transaction
  → mark input range processed
  → record user-visible assistant results
  → mark run finalized
  → clear activeRunId and lease
  → clear firstPendingAt only if no pending input remains
```

Phase 2 stores finalized PoC inputs, generated results, and delivered actions in the new run model. Phase 3 projects these records into provider-neutral transcript and context-generation storage.

Immediately check:

```text
pendingRevision > processedRevision?
  yes ──▶ ensure successor wake
  no  ──▶ lane idle
```

## No-reply and failure progress

### Model chooses ignore

The input still becomes terminal and advances the lane. Phase 4 will append the user turn and a bounded no-reply decision if useful.

### Batch not reply eligible

Mark the batch terminal without model invocation. The immutable PoC inputs remain available for Phase 3 transcript projection; no legacy history path is called.

### Permanent model failure

Choose one explicit state:

```text
terminal failure
  → input marked failed/processed
  → optional user-visible service error
  → later messages can proceed
```

Do not block one topic forever after retry exhaustion.

## Arrival during active work

```text
active run owns W = 50
new input increments pendingRevision to 51
BullMQ keepLastIfActive stores one successor wake
current worker never reloads 51 into its prepared request
after finalization successor drains 51
```

This applies during provider work, tool execution, and Telegram dispatch.

## Crash and retry matrix

| Crash point                                   | Recovery                                           |
| --------------------------------------------- | -------------------------------------------------- |
| Before input transaction commit               | Telegram/Bull retry can admit again                |
| After DB commit, before Redis add             | wake outbox publisher retries                      |
| After Bull activation, before lane claim      | job retry; no active run exists                    |
| After claim, before model call                | recover prepared run or expire lease               |
| During model call                             | provider call may repeat; fence accepts one result |
| After model result, before durable generation | provider call may repeat                           |
| After durable generation, before Telegram     | resume stored actions only                         |
| After Telegram success, before result commit  | outcome becomes ambiguous                          |
| During partial action list                    | skip delivered actions; continue terminal order    |
| After finalization, before Bull completion    | duplicate job sees processed watermark and exits   |

## Queue observability

Record:

```text
admitted input count
duplicate admission count
wake outbox age
Bull deduplicated count
batch quiet wait and total wait
batch message/user/media counts
lane claim conflicts
lease expirations and stale-fence commits
run duration by state
stalled/retried jobs
provider repeat attempts
delivery retries and unknown outcomes
pending watermark lag
```

`QueueEvents` is for monitoring only. Its Redis Stream is not a durable business event store.

## Edge cases

### Out-of-order Telegram updates

Order by the lane's admitted sequence. Preserve Telegram message ID and date as metadata.

```text
message #12 admitted after #13
  → append a late input event
  → never insert it before already finalized work
```

### Edited message arrives during its active run

The active run keeps the frozen original. The edit becomes next-run correction context.

### Message deletion

If Telegram supplies a deletion event, append a tombstone/correction input. Do not mutate an active prepared request.

### Bot sends several actions and one target was deleted

Mark that action permanent-failed. Continue later independent actions only if action ordering permits it. Record the user-visible transcript accordingly.

### Two wake publishers race

BullMQ deduplication keeps one delayed job. Both carry only revisions, so replacement cannot lose message data.

### Worker receives a stale revision

It reads the current lane row. If no work is due, it exits. If newer work is due, it claims through the authoritative watermark.

### Redis is unavailable for longer than the desired batch delay

The outbox age grows. When Redis returns, process the existing pending database range. Do not drop it because the original quiet window passed.

### Continuous topic traffic

The maximum deadline freezes one range. Later messages form successors. Add a maximum consecutive-run or fairness policy only if one hot lane starves the worker pool in real metrics.

### grammY runner timeout

The handler returns after durable admission, so long provider work no longer pins the grammY update slot.

### Multiple bot replicas

All replicas can admit and publish. Lane uniqueness, BullMQ deduplication, and PostgreSQL fencing provide cross-process behavior. Never use an in-memory mutex as the distributed invariant.

## PoC build sequence

1. Add schema and generated Prisma client.
2. Add canonical conversation key and admission.
3. Add wake outbox and publisher.
4. Add BullMQ queue/worker lifecycle to the process Effect runtime.
5. Add lane claim/fence and prepared runs.
6. Invoke `Model.Service` from the worker with a minimal fixed PoC prompt fixture.
7. Add durable actions and resume logic.
8. Exercise the isolated ingress and worker with synthetic Telegram updates.

PoC boundary:

```text
synthetic/isolated Telegram ingress
  → new admission
  → new worker
  → new durable delivery boundary
```

Do not call the legacy handler or history builder from this boundary.

## Tests

Required behavior tests:

1. Duplicate Telegram delivery creates one input and one pending revision.
2. Queue publication failure leaves a retryable outbox row.
3. Three rapid messages create one frozen batch.
4. Continuous input starts at maximum wait instead of starving.
5. Different lanes can overlap provider execution.
6. Same-lane runs never overlap.
7. A stale fence owner cannot store output or dispatch.
8. A message arriving during generation becomes the successor batch.
9. A BullMQ retry after durable generation does not call the model again.
10. Partial Telegram delivery resumes only unfinished actions.
11. A completed job retried after finalization sees no pending work.
12. A direct mention remains eligible when forwarded messages follow it.
13. A probabilistic eligibility decision is stable across retries.
14. An edited message becomes a later correction event.

Use real Prisma against the test database and real BullMQ integration where practical. Mock the model and Telegram external boundaries. Do not mock the lane and persistence collaborators.

Run narrow changed tests and repository `bun run lint`.

## Exit gate

Phase 2 passes when integration tests and isolated PoC traces show:

```text
handler latency ends after durable admission
  + no same-lane provider overlap
  + different lanes progress concurrently
  + forwarded bursts are coalesced without message loss
  + arrivals during active work run later
  + generated output survives worker retry
  + partial Telegram delivery resumes
  + queue outage recovers from the outbox
  = final context-generation work can begin
```

## PoC failure handling

Stop the isolated worker and preserve failed runs/outbox state for diagnosis. Recreate disposable PoC data when schema changes make old PoC rows invalid.

Do not add direct handler generation, a legacy lane mode, or a compatibility adapter. Fix the lane/run abstraction and rerun the failing scenario.
