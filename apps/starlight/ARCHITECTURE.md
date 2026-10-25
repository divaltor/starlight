# Starlight conversation engine

Map of the conversation engine under `src/`. It runs on a Pi Durable harness (`@earendil-works/pi-durable`) with the Postgres backend `@netzlabor/pi-durable-postgres` (patched in `patches/` for Pi 1.4). Every invariant lists the function that owns it. Paths are relative to `src/`.

## Pipeline

```text
Telegram update ──▶ Conversation.admit ──▶ Lane.admit (one Pi commit) ──▶ starlight.lane task
                                                                            │
                     ┌──────────────────────┬───────────────────────────────┼─────────────────────┐
                     ▼                      ▼                               ▼                     │
              silent batch           Jev-only batch                  model batch                  │
           batch entry only     reactions → delivery task    Pi submission → final_output         │
                                                                     → delivery task              │
                     └──────────────────────┴───────────────────────────────┴──▶ settle ──────────┘
```

Telegram facts (chats, users, messages, memory observations) stay in Prisma tables. Everything about running a conversation — batching state, transcripts, runs, compaction, delivery progress, crash recovery — lives in the harness's own `durable` schema. One process owns it at a time through the storage's advisory lock.

## Constants

`quietMs` 1000, `maxWaitMs` 3000 (`env.ts`), album settle 35s, batch 20 messages (+10 to finish an album) (`conversation/lane-doc.ts`), model stream timeout 40s and 5 model attempts (`conversation/conversation.ts`), 4 delivery attempts (`conversation/dispatch.ts`).

## Lanes (`conversation/lane-doc.ts`, `conversation/lane.ts`)

A lane is `(assistantId, chatId, threadKey)`, one Pi conversation each. The session doc family `starlight.lane-index` maps the lane key to its conversation; the conversation doc `starlight.lane` holds the pending batch, dedup keys, `wakeAt`, the claiming `runner`, the newest `sleeper`, and the recent history the next prompt and dialogue continuation read.

- Admission (`Lane.admit`): dedups on update id and message revision, then `wakeAt = min(now + quietMs, firstPendingAt + maxWaitMs)`. It creates a background lane task only when no runner exists and no sleeper wakes early enough. Pi commits are serialized, so this read-modify-write needs no locks or fencing.
- The lane task runs `wait → run → answer → settle`. `wait` sleeps durably until `wakeAt`, then claims the lane and freezes a batch. A sleeping task cannot be re-armed, so an admission that moves `wakeAt` earlier starts another sleeper; whichever wakes first claims and the rest exit.
- `run` checks premium access, then: a silent batch is appended as a `starlight.batch` entry without a model call; a batch answered only by Jev reactions goes straight to a delivery task; anything else freezes recall and the date in a memo and writes `starlight.run`.
- `answer` submits the batch with a stable `requestId`, so a rerun after a crash finds the same submission instead of asking twice.
- Retryable failures back off exponentially (cap 300s) on the same frozen batch. Permanent ones (`Lane.BlockedError`, or errors with `retryable: false`) drop only that batch.

## Reply (`conversation/reply.ts`)

The `starlight` Pi extension supplies the system prompt sections, tools and hooks.

- `final_output` validates against the chat's reply limit, merges precomputed Jev reactions (`mergePrecomputedReactions`), creates the delivery task once (linked through the task doc `starlight.delivery-ref`), waits for it, and terminates the run without another model request.
- Research tools wrap the AI SDK toolset with a 3-call and 16 KiB output budget tracked in `starlight.run`.
- `beforeRequest` rewrites only the outgoing request: date, recalled memory, media and sign-off guidance go next to the live batch, so the stored transcript stays stable for provider-side caching.
- `onYield` nudges a model that answered in plain text, at most twice per batch.

## Checkpoints (`CompactionTask.beforeCompact` in `conversation/reply.ts`)

Pi decides when to compact and where to cut (`settings.compaction`, from `CONTEXT_COMPACTION_TRIGGER_TOKENS` and `CONTEXT_RETAINED_TOKEN_TARGET`). The hook flushes Hindsight first, then summarizes the dropped head into typed `Checkpoint.Records` and stores the summary in a memo so a retry reuses it. Assistant turns reach the summarizer as delivered reply text only. Recall runs only once the lane's context starts from a compaction summary; before that the transcript still holds the full history.

## Delivery (`conversation/dispatch.ts`)

The `starlight.delivery` task commits its intent before every send.

- A crash between intent and result is an unknown outcome and gets exactly one more send; a second blind resend risks duplicate messages.
- Known transient failures retry after 1, 2.5 and 5 seconds; non-retryable or exhausted actions fail.
- A failure closes delivery for the rest of its segment. The precomputed reaction prefix and the model suffix are separate segments.
- Consecutive text replies wait 1.5–2.5s through a durable sleep.

## Memory

Finalized batches write canonical message observations to PostgreSQL, unique per message revision. The memory worker scans every 30 seconds and flushes a lane after 15 minutes idle, 8K pending characters, or a correction. A flush sends one full canonical transcript as one `replace` item to the lane's stable `transcript` document.

## Known limitations

- `@netzlabor/pi-durable-postgres` is a community package pinned at 0.2.0 with a local patch; an upstream release for Pi ≥ 1.2 should replace the patch.
- pi-ai user messages carry only text and images; non-image media rides as an image part and `ai/openrouter.ts` rewrites it into OpenRouter's `video_url`, `input_audio` or `file` parts.
- Telemetry is not connected to Pi yet.
