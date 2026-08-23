# Phase 7 PLAN — PoC Hardening and Legacy Runtime Replacement

## Purpose

Finish load, failure, privacy, quality, and cost hardening for the new conversation runtime. After explicit PoC acceptance, replace the legacy runtime and delete its history, cache-control, and count-based memory abstractions.

```text
isolated PoC complete
  → acceptance suite
  → stop legacy runtime at deployment boundary
  → activate new runtime
  → delete legacy code and compatibility-free interfaces
```

This phase does not create dual runtime support, legacy context import, old/new lane assignment, or fallback switches.

## Greenfield PoC assumptions

- The new runtime is the only architecture maintained after acceptance.
- New tables and contracts do not decode or import legacy context/memory rows.
- Legacy raw Telegram data migration, if wanted for a real deployment, is a separate explicit data project.
- The PoC database can be recreated with the final schema.
- Replacement removes old code instead of leaving compatibility flags.
- A failed replacement is fixed forward or the deployment is stopped externally; the new domain does not contain a legacy mode.

## Dependencies

- Phase 4 end-to-end context runtime passes all required scenarios.
- Phase 5 checkpoints operate below hard limits.
- Phase 6 memory and DM privacy gates pass.
- No PoC abstraction imports old prompt selection or old memory injection.

Actual destructive production schema or queue cleanup still requires explicit deployment authorization. This plan defines the target, not permission to delete production data.

## Removal inventory

Confirm exact callers before deletion.

### Old history selection

Candidates:

```text
apps/starlight/src/utils/history.ts
HISTORY_LIMIT
old History.build call sites
direct-reply chronological backfill behavior
```

### Old mutable memory prompt path

Candidates:

```text
apps/starlight/src/services/chat-memory.ts
buildChatMemoryPromptContext call sites
topic/global latest-note injection
```

### Old count-based memory workers

Candidates:

```text
apps/starlight/src/queue/memory.ts topic/global count windows
scheduleChatMemorySummaries call sites
ChatMemoryCursor use
ChatMemoryNote use
```

Keep any unrelated queue behavior discovered during caller inspection. Delete only the replaced topic/global memory subsystem.

### Old cache-control helper

Candidates:

```text
apps/starlight/src/utils/message.ts
withOpenRouterGeminiCacheControl
OPENROUTER_GEMINI_3_FLASH_MODEL_PREFIX
message-level cache-control mutation helpers
```

Explicit cache profiles, if any, remain in the new model-profile/provider adapter.

### Relative media history policy

Candidates:

```text
ATTACHMENT_INLINE_OFFSET
position-dependent historic media rendering
MESSAGE_PART_CONTEXT_RECENT_MESSAGE_LIMIT where replaced by immutable context
```

Do not remove raw attachment loading needed for live D media.

### Direct handler generation

Remove:

```text
response sleep
hasNewerMessages stale-drop reply logic
handler-owned prompt generation
handler-owned AI reply dispatch state that the durable worker replaced
```

Keep Telegram parsing, storage, command handling, and non-AI behavior.

## Accept, replace, and delete

The PoC remains isolated until its complete acceptance suite passes. The code replacement is one architecture change:

```text
step 1  freeze final PoC contracts
step 2  pass end-to-end, load, recovery, privacy, cost, and quality gates
step 3  point application entrypoint at new ingress/runtime
step 4  remove legacy handler generation, history, memory, and cache helpers
step 5  remove obsolete configuration and tests
```

Do not compile two lane modes or keep an old-path switch “just in case.” Repository checks must prove that the legacy owners have no callers after replacement.

Check source ownership:

```text
no History.build import
no ChatMemoryNote/Cursor prompt read
no handler-owned model invocation
no model-name cache helper
no stale-message delay as batching
```

## Legacy queue boundary

The PoC uses new queue names and job contracts from Phase 2. It never consumes old memory jobs.

```text
PoC Redis namespace   new conversation/memory jobs only
legacy Redis jobs     outside PoC contract
```

A real deployment must explicitly stop old producers and clean or terminally handle old jobs before removing their processors. This is a one-time operational action, not a compatibility processor in the new runtime. Do not delete unrelated shared queues.

## Configuration cleanup

Remove with legacy code replacement:

```text
HISTORY_LIMIT
ATTACHMENT_INLINE_OFFSET
old topic/global memory count thresholds
old Gemini model-prefix cache switch
old path switches
```

Keep or add the new explicit configuration:

```text
batch quiet/max delay
lane lease and retry policy
context soft/hard caps and reserves
retained-tail target
model profile selection
memory projection budgets
DM authorization policy
```

Defaults must come from measured PoC values, not the original planning example.

## Final PoC schema and deployment data decision

The final PoC schema does not contain or decode obsolete memory/context interfaces.

```text
disposable PoC database
  → recreate with final schema
  → no legacy backfill

real deployment database
  → separately decide preserve/export/drop legacy data
  → explicit destructive-action approval required
```

Potential later removals:

```text
ChatMemoryCursor
ChatMemoryNote
ChatMemoryScope enum if unused
obsolete indexes and relations
```

Use `bun run db:migrate` and `bun run db:generate`. Never hand-write migration or generated Prisma files.

Before any real deployment drop:

- confirm no reporting, admin, or other app uses the tables;
- capture needed audit/export data;
- confirm no required data depends on the tables;
- estimate migration lock and duration;
- schedule according to production database policy.

## Data retention

Define retention separately for:

```text
raw Telegram messages and attachments
immutable conversation inputs
provider-neutral transcript
generation-specific renderings
provider attempts and usage
tool raw results
Telegram delivery records
superseded context generations
memory observations/revisions
failed/aborted checkpoint attempts
```

Do not retain large raw tool/media payloads indefinitely only because rendered context needs a small projection.

Retention deletion must preserve:

- active context rendering;
- active prepared-run retry inputs;
- audit requirements;
- forget/deletion obligations;
- usage aggregates needed for cost tuning.

## Operational recovery

Create runbooks for these states.

### Lane stuck with active lease

```text
lease still valid   ──▶ inspect active worker/run
lease expired       ──▶ recovery worker claims new fence
generated run       ──▶ resume delivery
prepared/invoking   ──▶ apply provider retry policy
```

Never clear `activeRunId` without inspecting durable run state.

### Wake outbox backlog

```text
outbox age rises
  → check Redis/BullMQ connectivity
  → restart publisher if needed
  → publish pending revisions
  → workers drain database watermarks
```

Do not create replacement message rows manually.

### Invalid prefix chain

```text
stop affected lane
  → preserve all rows
  → compare transcript and rendered segments
  → identify renderer/finalization defect
  → create controlled new generation from valid canonical turns
```

Never edit active rendered turns in place.

### Hard checkpoint retry exhaustion

```text
lane remains unable to fit pending input
  → inspect summary failure and required input size
  → retry with approved profile or controlled manual transition
  → send user-facing failure only under explicit policy
```

Do not bypass the hard cap.

### Telegram delivery unknown

Use the selected duplicate-versus-omission policy. Record operator decisions against the action row.

### Memory privacy incident

```text
disable memory projection
  → identify namespace/revision/source
  → invalidate affected contexts
  → publish corrected/tombstone revisions
  → follow incident and user-notification policy
```

Do not delete evidence before the incident process allows it.

## Alerts and service indicators

### Queue and lane health

```text
wake outbox oldest age
pending input oldest age
lane lease expiry count
stale-fence commit count
BullMQ stalled/retry-exhausted count
run duration by state
```

### Model and cache health

```text
provider error/timeout rate
cache-read ratio by profile/upstream/idle bucket
input estimate error
context hard-cap proximity
tool failure rate
cost per useful finalized reply
```

### Delivery health

```text
Telegram action failure rate
unknown outcome rate
duplicate-risk retries
generated-to-finalized latency
```

### Checkpoint health

```text
soft/hard trigger count
summary failure and retry count
checkpoint duration
queued messages during checkpoint
child cold-start and later cache result
continuation quality sample failures
```

### Memory and privacy health

```text
memory queue lag
revision CAS conflict/failure
privacy-filter block count
memory projection omission
forget invalidation completion time
DM authorization denial rate
```

Alert thresholds are selected from PoC load-test baselines and later real traffic. Do not invent fixed percentages without evidence.

## Cost review

Use complete provider-step data:

```text
normal reply input/cache/output
  + tool continuation steps
  + checkpoint summary calls
  + child cold-start calls
  + memory builder calls
  = total conversation runtime cost
```

Compare:

```text
old cost per useful reply
new cost per useful reply
cost by model profile
cost by context-size bucket
cost by cache-hit/miss and idle bucket
cost per checkpoint cycle
```

Do not claim savings from cached-input ratio alone. Include output, summaries, tools, memory builders, and failed attempts.

## Quality review

Continue sampling:

```text
short text conversations
long post-checkpoint conversations
multi-user topic bursts
direct replies to old content
media and tool flows
group-to-DM continuity
privacy-negative examples
corrections and forget requests
```

Track user-visible regression signals such as immediate corrections, repeated questions, and failed target references.

## Security review

Before legacy runtime replacement, verify:

- prompts and memory content are absent from ordinary logs;
- opaque provider affinity values do not expose raw IDs;
- media object references are immutable and access-controlled;
- memory visibility checks run before rendering;
- tool result projections cannot define tools or system policy;
- forgotten memory cannot remain in active future prompt generations;
- DM authorization is checked before model invocation and dispatch;
- database and Redis credentials remain outside job data and telemetry.

## Edge cases

### Legacy runtime still has active work at deployment

Stop new legacy admissions and let or force existing work reach a terminal state before activating the new entrypoint. Do not import the active legacy lane into the PoC lane model.

### Delayed old memory job wakes after code deletion

Remove or terminally resolve identified legacy jobs as a one-time deployment operation before the new worker owns its queue namespace. Do not implement a legacy-job compatibility handler in the new worker.

### Replacement deployment fails after legacy deletion

Stop the new runtime and use the separately approved deployment restore or forward-fix procedure. The application does not contain an old-path mode or schema adapter.

### New model loses cache support

The runtime continues for correctness under a `none` cache strategy. Recalculate cost thresholds. Do not restore sliding history automatically.

### Price changes

Update the model profile and offline threshold evaluation. Price changes do not mutate active prompt bytes unless the selected model/settings change.

### Provider cache accounting changes

Mark usage unknown until normalization is updated. Replies continue. Do not treat missing cache-write tokens as proof of no implicit cache.

### Context growth exceeds forecast

Hard cap still protects correctness. Adjust estimator/reserves and soft threshold from actual traces.

### Memory disabled during incident

User/chat/topic projection stops. Context transcripts and checkpoints continue. Do not inject old mutable memory as fallback.

### Redis data loss

Rebuild wakes from database lane/outbox pending state. Redis is not the source of progress.

### Superseded context retention expires

Never delete a generation referenced by an active run, checkpoint, audit hold, or configured diagnostic-retention period.

## Deletion tests

Before deleting old code, add or keep tests that prove:

1. No production entry point imports `History.build`.
2. No reply prompt reads `ChatMemoryNote` or `ChatMemoryCursor`.
3. No model-name string selects cache semantics outside model profiles.
4. No handler invokes the reply model directly.
5. No delayed/stale-message drop controls AI batching.
6. Live media still loads after relative history media code is removed.
7. Direct replies still resolve through context D.
8. Topic/global old memory jobs are no longer enqueued.
9. New lanes recover from database state when Redis jobs are absent.
10. A cache-disabled profile still produces correct replies.

Run relevant repository tests and `bun run lint`. Run the web build only if `apps/web` changes.

## Cleanup sequence

```text
1  pass the complete isolated PoC acceptance suite
2  stop legacy admissions and job producers at deployment boundary
3  drain/remove legacy jobs as one-time operations
4  replace application entrypoint with new ingress/runtime
5  remove old prompt, handler generation, and memory code
6  remove old cache helper and count/position config
7  verify no legacy imports or switches remain
8  recreate the PoC database with final schema
9  handle any real production table drop as separately authorized work
```

Each deletion should be the smallest complete diff. Do not mix unrelated refactors.

## Final PoC acceptance gate

The complete rewrite passes when isolated integration, load, recovery, privacy, quality, and cost evidence shows:

```text
no legacy owner is imported by the PoC
  + same-lane serialization is stable
  + queue/outbox recovery works
  + context prefixes append without mutation
  + hard limits are never exceeded
  + checkpoint quality and cost pass
  + delivery retries do not regenerate
  + user/chat/topic memory privacy passes
  + DM authorization and continuity pass
  + complete cost is lower or justified by quality
  + recovery and incident runbooks are exercised
  = PoC can replace the legacy runtime
```

## Replacement failure policy

The new architecture has no backward-compatibility boundary:

```text
PoC failure before replacement  → fix/recreate isolated PoC
deployment failure              → stop runtime + approved restore or forward fix
domain behavior failure         → fix new owner; do not activate legacy mode
```

Any real production database restoration remains an operational deployment plan, not an interface or code path inside the PoC.
