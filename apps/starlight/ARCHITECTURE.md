# Starlight conversation engine

Map of the durable machinery under `src/`. Every invariant lists the function that owns it. Paths are relative to `src/`.

## Pipeline

```text
Telegram update ──▶ admit() ──▶ ConversationInput + wake outbox ──▶ BullMQ delayed wake ──▶ drain()
```

## Constants

`quietMs` 1000, `maxWaitMs` 3000, `leaseMs` 180000 (`packages/utils/src/env.ts`), model timeout 120s (`ai/model.ts`), batch 20 messages, 5 model attempts, 5 delivery attempts (`conversation/conversation.ts`).

## Admission (`conversation/conversation.ts`, `admit`)

One transaction per update: upserts Chat/Message/lane, then locks the lane row.

- Dedup key: `sourceUpdateId`, or `(chatId, messageId, sourceRevision)` where the revision hashes edit state plus canonical payload — retries and Telegram edits collapse here.
- Wake math: `wakeAt = min(now + quietMs, firstPendingAt + maxWaitMs)`; debounces bursts without starving the first message.

## Wake transport (`conversation/wake-queue.ts`, `wake-outbox.ts`)

BullMQ delayed jobs keyed by lane (`v1/<assistant>/<chat>/<thread>`), deduplicated with `replace`. The outbox row is the durable intent; the queue is a replica. On any ambiguity the drain side recomputes from lane state and republishes.

## Run lifecycle (`drain`, `claimRun`)

Lane keys: `(assistantId, chatId, threadKey)`. Claim rules, in order: no pending → `up-to-date`; not yet due → `not-due` (republish); active run with live lease → `busy`; otherwise claim.

A claim bumps `fencingToken` (lane + run), sets `leaseOwner`/`leaseUntil`, and either revives an expired run or freezes a batch of ≤20 pending inputs into a new run.

```text
prepared ──▶ invoking ──▶ generated ──▶ dispatching ──▶ finalized
    │            │                          │
    │            └─▶ failed (attempts exhausted)
    └─▶ blocked (permanent: checkpoint impossible, oversized input, request-hash drift)
```

Recovery paths in `drain`: `generated`/`dispatching` resumes at dispatch (delivery records are the ledger); `failed` appends the failure turn and finalizes; a still-active `blocked` run releases the lane instead of failing forever. Non-terminal model failure resets the run to `prepared` and expires the lease for fast redrive.

**Fencing**: every stage write goes through `Lane.assertFence` (`conversation/lane.ts`) inside the same transaction. A stale worker's writes throw after a newer claim. Fences protect database state and prevent duplicate Telegram sends; they do not cancel in-flight provider calls.

**Lease renewal**: the transactions that open each long stage — model invocation (`invokeModel`), checkpoint summarization (`summarizeCheckpoint`), and dispatch (`dispatchRun`) — also rewrite `leaseUntil = now + leaseMs` on the lane. Every awaitable stage is bounded by the 120s model timeout or a short delivery burst, so gaps between renewals stay below one lease period without heartbeat timers. A crashed worker stops renewing, so crash-recovery latency stays at one lease period. Before this renewal, a worst-case drain (summary + generation ≈ 240s) outlived the 180s lease and let a second worker re-invoke the model on the same run — duplicate spend with no benefit.

## Model invocation and the tool budget

The reply generation allows at most `maxToolCalls` tool **rounds**, not individual calls. A round is one assistant message containing tool calls; all parallel calls inside a round execute together. Enforcement is two-sided in `ai/model.ts`: `stopWhen: isStepCount(maxToolCalls + 1)` ends the loop, and `prepareStep`/`limitTools` deactivates tools once completed rounds reach the cap.

This is deliberate, not a missing guard: the product rule is "at most one web-research round per reply", because Exa cost per _round_ is what matters and models may legitimately fan a round into a few parallel lookups. Per-call atomic enforcement was considered and rejected — it would need an executor-side gate and would reject valid parallel fan-outs without reducing spend meaningfully. Do not "fix" the step-count check to count individual calls without revisiting that decision.

## Context generations (`context/context.ts`)

Per-lane chain of `ConversationContext` rows (generation N+1 supersedes N). Turns are global per lane (`ConversationTranscriptTurn`) and projected per context with a hash chain: `basePrefixHash = sha256(envelope + memory)`, each turn extends it (`Prompt.extendPrefix`). `verifyPrefix` re-walks the whole chain on every `prepare` — rendering drift or tampering fails the run permanently.

Both context creation paths (`ensureActiveContext`, `transitionProfile`, `commitCheckpoint`) must produce byte-identical seeds via `stableSeed`; divergence breaks every later chain.

**Profile fingerprints**: `Prompt.profileFingerprint(webLookupEnabled)` pins the prompt/toolset pair. A mismatch forces `transitionProfile`, which seals the parent and copies retained turns into a fresh generation.

## Checkpoints (`checkpoint`, `resumeCheckpoint`)

Triggers: soft cap after append (`softCost`), projected hard cap before invocation (`hardSafety`). Attempt states:

```text
prepared ──▶ summarizing ──▶ summarized ──▶ committed
                 │
                 └─▶ failed ──▶ aborted (stale profile) | resumed
```

The summary input is sealed and hash-checked at prepare time; commits create the child generation with `frozenMemory` = rendered summary and retain whole-run tail units toward `retainedTokenTarget`. Failed `hardSafety` attempts resume without an attempt bound by design — a permanent summarization failure must block, not redrive forever.

## Delivery (`dispatchRun`, `deliverStoredAction`)

Actions are validated against the frozen batch's message ids before persistence. Statuses: `pending` → `delivered` | `failed` | `unknown`.

- `unknown` outcome: send result never confirmed. Retried exactly once (`unknownRetryCount` guard) — a second blind resend risks duplicate messages.
- Retryable failures redrive until `MAX_DELIVERY_ATTEMPTS`; non-retryable or exhausted → `failed` (recorded as a transcript turn, never silently dropped).

## Known limitations

- Token estimates use `chars/4`, which under-counts Cyrillic text by roughly 33–57% (Russian runs ~1.7–3.0 chars/token against common BPE encodings). Planned fix: Pi-style anchored deltas — predict `lastObservedInputTokens` (provider-reported, persisted per context) plus heuristic estimates of only the turns added since that measurement. A real BPE tokenizer was evaluated and rejected: o200k counts are exact only for OpenAI-family models, while OpenRouter reports native-tokenizer usage as ground truth after every call; integration adds a dependency without cross-provider exactness. Revisit only if cold-start misses (no anchor before the first successful generation) show up in telemetry.
