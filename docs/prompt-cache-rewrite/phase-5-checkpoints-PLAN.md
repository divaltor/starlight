# Phase 5 PLAN — Context Checkpoints and Compaction

## Purpose

Keep append-only context below a safe model limit and below a selected cost threshold without returning to a sliding window.

Use two checkpoint triggers:

```text
soft cost cap   answer current batch, then compact
hard safety cap compact before answering pending batch
```

Cache expiry is not a trigger.

## Greenfield PoC assumptions

- Define checkpoint attempts, generation transitions, tail units, and summary schemas directly.
- Do not import or preserve `ChatMemoryNote` summaries.
- Generation 1 starts from PoC transcript state; later summaries only consume new checkpoint state.
- No sliding-window fallback exists when compaction fails.
- Disposable PoC data can be recreated after incompatible schema or summary-format changes.

## Dependencies

- Phase 4 supplies end-to-end PoC context generations, immutable turns, and real usage.
- Phase 2 supplies one fenced active run per lane.
- Phase 0 supplies cache behavior and minimum-prefix evidence.
- A summary model/profile and summary quality rubric must be selected.

## Terms

```text
generation       one frozen A+B+C prompt epoch
checkpoint       durable summary of an exact finalized boundary
retained tail    complete recent interaction units copied/re-rendered into child
soft cap         fixed total-input cost threshold
hard cap         model safety threshold with reserves
```

Do not use “checkpoint” for the provider's ephemeral cache entry.

## Required persistence

### CheckpointAttempt

Conceptual fields:

```text
id
conversation key
parent context ID
parent fencing token
sealed through transcript ordinal
head end ordinal
retained tail start/end ordinals
reason: soft-cost | hard-safety | profile-change | manual
status: prepared | summarizing | summarized | committed | aborted | failed
summary profile ID
summary input hash
summary output
summary usage/provider metadata
attempt count and last error
child context ID nullable
timestamps
```

One parent generation can have at most one committed child.

### Context status transition

```text
active
  → checkpointing
  → superseded

checkpointing
  → active       soft abort/failure with remaining capacity
  → retry-needed hard failure
```

The lane remains claimed while its context is `checkpointing`.

## Token budgets

Define explicit total-request budgets:

```text
estimated input
  = A + B + C + D + provider serialization allowance

projected request
  = estimated input
  + output reserve
  + tool-loop reserve
  + estimator safety margin
```

Suggested configuration vocabulary:

```text
CONTEXT_SOFT_TOKEN_CAP
CONTEXT_HARD_TOKEN_CAP
CONTEXT_RETAINED_TOKEN_TARGET
CONTEXT_OUTPUT_RESERVE_TOKENS
CONTEXT_TOOL_RESERVE_TOKENS
CONTEXT_ESTIMATE_SAFETY_RATIO
```

The hard cap must remain below the provider context limit.

```text
hard cap + output/tool reserve + estimator error < model context limit
```

Do not reuse the old `HISTORY_LIMIT` meaning.

## Initial thresholds

Select with real Phase 4 traces. Initial experiment set:

```text
soft cap candidates  24k ── 30k ── 48k total serialized input
retained target      enough for complete recent units and proven cache minimum
hard cap             model limit minus measured reserves and safety margin
```

For a model with a proven 4k cache minimum, a retained A+B+C target around 6–8k is safer than targeting exactly 4k.

These are experiment values, not universal defaults.

## Trigger decision

Before model invocation:

```text
projected request ≥ hard cap?
  yes ──▶ hard checkpoint before answer
  no  ──▶ answer normally
          │
          ▼
       finalized context ≥ soft cap?
          yes ──▶ soft checkpoint after delivery
          no  ──▶ release lane
```

Use the last valid observed input as calibration, but estimate the pending D and reserves locally.

Do not trigger from one calculated dollar value. The future number of turns is unknown.

## Soft checkpoint flow

The user who crossed the cost threshold gets a normal response first:

```text
old generation G
  → run current batch
  → persist generated actions
  → deliver Telegram reply
  → finalize turns into G
  → keep lane claimed
  → seal finalized ordinal N for checkpoint
  → summarize head
  → create child G+1 = new memory + retained tail
  → release lane
```

Messages received during summary:

```text
G checkpoint seals transcript ordinal N
                         │
new Telegram inputs ─────┴──▶ durable inbox only
                         │
G+1 commits              │
                         ▼
next run uses G+1 + pending batch
```

They are not added to the summary and are not lost.

## Hard checkpoint flow

The pending batch cannot fit safely in the old generation:

```text
claim lane and freeze pending batch D
  → do not invoke reply model
  → seal current finalized G boundary N
  → summarize head and retain tail
  → commit G+1
  → rebuild request as G+1 + same frozen D
  → verify projected size
  → invoke reply model
```

The pending batch remains the same across checkpointing. Sender memory, reply target, and media digests are already frozen by the prepared run.

If `G+1 + D` still cannot fit, apply the oversized-request policy. Do not run another normal checkpoint loop without changing the input size.

## Sealing protocol

Short transaction:

```text
verify lane owner + fence
  → verify parent context active
  → verify no committed child
  → choose exact finalized boundary N
  → select head and retained interaction units
  → create prepared CheckpointAttempt
  → mark parent checkpointing
commit
```

Then generate the summary outside the transaction.

Commit transaction:

```text
verify same lane fence
  → parent still checkpointing
  → boundary and attempt still match
  → no child already committed
  → create child context
  → freeze new B
  → add retained C turns
  → mark parent superseded
  → mark attempt committed
  → set lane activeContextId = child
commit
```

A stale summary result that fails the CAS is retained as an aborted attempt for usage accounting. It never becomes active memory.

## Interaction-unit selection

Build units before token selection:

```text
unit A  linked context + user batch + assistant reply
unit B  user message + tool call + tool result + assistant reply
unit C  user media + media projection + assistant action
```

Walk backward by complete units until the retained target is reached or the next unit would exceed an allowed retained maximum.

```text
oldest ── head to summarize ──┬── retained complete units ── newest
                              │
                         split only here
```

Never split:

- a tool call from its result;
- a user message from required linked context;
- one Telegram album;
- one assistant multi-action response when those actions answer one batch.

If one unit is larger than the target, keep the whole unit unless it would make the child unsafe. If unsafe, create a bounded special projection or return a controlled oversized-context failure.

## Summary input

Summarize:

```text
previous checkpoint memory
  + finalized head after the previous summary boundary
  = new checkpoint memory
```

Do not summarize pending inputs or generated-but-not-finalized assistant text.

Summary output must preserve:

```text
conversation purpose and open questions
stable decisions and constraints
named people with correct attribution
important reply relationships
tool-derived facts still needed
media facts from stable projections
unresolved failures/corrections
current work/topic state
```

Drop:

```text
repeated greetings
obsolete intermediate wording
large raw tool payloads
facts explicitly corrected later
private data not permitted in this lane
```

User, chat, and topic semantic memories are not merged here until Phase 6 defines their privacy projection. A checkpoint summarizes lane continuity only.

## Summary model choices

### Same reply model/profile

Potential advantage:

```text
same A+B+C prefix + compaction instruction D
  → provider may reuse warm prefix if Phase 0 proved this request shape
```

Costs:

- same model output price;
- tool/output schema must remain stable if required for caching;
- compaction instructions must not permit normal reply actions.

### Separate cheaper summary model

```text
provider-neutral head projection
  → cheaper model, likely cold input
  → summary output
```

Costs:

- no assumption of old-prefix cache reuse;
- another profile and quality evaluation;
- possible weaker attribution/media understanding.

Start with the model that passes summary quality and measure both total cost and latency. Do not assume the cheaper output price gives the cheaper checkpoint.

## Summary retry

The checkpoint attempt has an immutable summary input hash.

```text
attempt 1 provider timeout
  → retry same input/profile
  → attempt 2 summary stored
  → one child context committed
```

Provider summary invocation can repeat. Only one successful child can commit.

## Child generation construction

For the same model profile:

```text
A child  same frozen envelope bytes
B child  new checkpoint memory and permitted frozen scope memory
C child  retained tail with unchanged generation rendering where compatible
```

For a profile change:

```text
A child  new envelope
B child  new checkpoint memory
C child  provider-neutral retained turns rendered once for new profile
```

The child starts a new cache epoch. Its first provider request can be a cold miss.

## New-generation cache minimum

Check before commit:

```text
estimated A+B+C ≥ proven minimum cacheable prefix?
```

If not, this is allowed for correctness, but record that early child turns can have no cache reads. Prefer a retained target that avoids this when quality and cost permit.

## Checkpoint cost accounting

The complete cost includes:

```text
summary input
summary cache reads/writes
summary output
first reply against new child generation
future warm reads
```

Do not reuse the old incomplete reset formula.

Conceptual break-even:

```text
checkpoint overhead
  = summary cost
  + extra cold/write cost for child prefix
  + operational latency cost if measured

later saving per turn
  ≈ expected old-prefix cost - expected child-prefix cost

break-even future turns
  ≈ checkpoint overhead / later saving per turn
```

The number of future turns is not known per request. Use trace replay to choose a fixed soft threshold.

## Offline threshold evaluation

Replay real, privacy-safe usage traces:

```text
for each candidate soft cap
  → simulate context growth
  → apply observed inter-message idle gaps
  → apply measured cache-hit probabilities
  → add real summary input/output distributions
  → add child cold-start cost
  → compare total cost and context quality
```

Evaluate at least:

```text
16k  24k  30k  48k  64k
```

Do not select only the lowest dollar result. Review summary quality, lost detail, latency, and provider limits.

## Oversized current request

After a hard checkpoint, reduce only optional D content in this order:

```text
extra retrieval/tool context
  → nonessential linked context beyond required reply target
  → optional sender-memory detail
  → media resolution/number where a safe bounded representation exists
```

Never silently remove:

- live user text;
- required direct-reply target identity/context;
- required media if the user's request depends on it.

If the required request still does not fit:

```text
mark controlled oversized-input failure
  → optional user-facing explanation
  → finalize or hold according to explicit retry policy
```

Do not checkpoint repeatedly because a single live request is intrinsically too large.

## Tool-loop overflow

Reserve for tool results before the first provider call. Every tool has a bounded model-visible result.

```text
tool result exceeds bound
  → store full raw result separately when needed
  → append deterministic truncated/summary projection to model loop
```

If a provider still reports context overflow before assistant output begins:

```text
one overflow recovery checkpoint allowed
  → rebuild once
  → second overflow becomes controlled failure
```

Do not create an unbounded compact/retry loop.

## Cache expiry

```text
likely cache expired + context below soft cap
  → normal cold request
  → no checkpoint

likely cache expired + context above soft cap
  → threshold policy already requires checkpoint
  → expiry is telemetry, not the reason
```

Summarizing solely on idle would pay summary cost and lose detail without knowing whether the user returns.

## Arrival and concurrency edge cases

### Input arrives during soft checkpoint

It remains pending beyond the sealed transcript boundary and runs against the child.

### Two checkpoint wake-ups exist

The lane fence and unique committed child rule allow one attempt to own publication. Other jobs no-op or observe the active attempt.

### Lane lease expires during summary

A new owner can resume the attempt or create a retry using the same sealed input. The old owner's commit fails its fence check.

### Parent already has a child after retry

Return the existing child and mark the duplicate attempt superseded. Never create a sibling active generation.

### Summary succeeds but child commit fails transiently

Persist the summary result on the attempt. Retry the commit without invoking the model again if the parent/fence state still permits it.

### New operator profile requested during checkpoint

Pin the checkpoint's intended child profile at preparation. A later profile change waits for this attempt to finish or aborts it explicitly before another transition.

## Failure policy

### Soft checkpoint failure

```text
remaining safety capacity exists
  → mark attempt failed/aborted
  → return parent to active
  → release lane
  → retry checkpoint on later run/backoff
```

Avoid retrying after every new message with no backoff.

### Hard checkpoint failure

```text
pending request cannot fit parent
  → keep lane blocked/retry-needed
  → retry with bounded backoff
  → send controlled service failure only after policy exhaustion
```

Do not invoke the oversized parent request.

### Invalid or empty summary

Treat as checkpoint failure. Do not publish an empty child memory.

### Summary omits mandatory structure

Decode against a summary schema when feasible. If invalid, retry according to policy; do not repair with untracked string concatenation.

## Quality evaluation

Create a representative replay set containing:

```text
long factual conversation
several participants with attributed facts
corrections and changed decisions
direct replies to old messages
tool-derived facts
media descriptions
unfinished tasks/questions
multiple previous checkpoints
```

After compaction, ask continuation questions and compare against raw source truth.

Measure:

```text
fact retention
speaker attribution
latest correction wins
open task retention
privacy preservation
hallucinated facts
response latency
summary tokens and cost
```

## Observability

Record:

```text
trigger reason
parent/child generation IDs
sealed/head/tail ordinals
head/tail estimated tokens
summary input/output/cache usage and cost
summary duration and retries
child initial token size
first child cache result
queued input count during checkpoint
soft abort and hard failure counts
overflow-recovery count
summary quality evaluation version
```

## Tests

Required behavior tests:

1. Crossing the soft cap delivers the current reply before checkpointing.
2. A hard-cap request checkpoints before model invocation.
3. Input arriving during checkpoint becomes the first child-generation batch.
4. Two concurrent checkpoint attempts commit one child.
5. A stale fence owner cannot publish a child.
6. Tail selection keeps complete tool and user/assistant units.
7. Previous summary and new head produce one replacement summary.
8. Child generation retains the selected tail in exact order.
9. A same-profile child preserves compatible rendered tail bytes.
10. A profile-change child re-renders from provider-neutral turns.
11. Soft failure reactivates the parent when capacity remains.
12. Hard failure does not invoke an oversized reply request.
13. A stored summary result can retry child commit without another model call.
14. Cache expiry alone does not create a checkpoint.
15. One oversized live request does not cause an infinite checkpoint loop.
16. Tool overflow recovery occurs at most once.
17. Final child A+B+C is below the hard budget and records cache-minimum status.

Run narrow checkpoint/context/queue tests and `bun run lint`.

## Exit gate

Phase 5 passes when long-running PoC scenarios show:

```text
soft checkpoints do not delay the current reply
  + hard checkpoints protect the model limit
  + queued input survives and runs against the child
  + one parent produces one child
  + failed summaries never become active
  + first-child cold misses and later cache reads match expectations
  + total cost includes summary and child cold-start cost
  + continuation quality passes review
  = long-running context PoC is safe
```

## PoC failure handling

Stop long-running PoC scenarios and disable new automatic checkpoint triggers while the owner is fixed.

Allow active attempts to:

```text
commit valid prepared child
or abort and reactivate parent when safe
```

Do not add a sliding-history or legacy-summary fallback. A lane whose parent cannot fit remains blocked until the checkpoint abstraction is fixed or its disposable PoC data is recreated.
