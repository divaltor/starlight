# Starlight bot: improvement plans

Written by the improve skill against commit `6fd58ac` on 2026-11-09. Scope: `apps/starlight` only.
Line numbers are from that commit. All paths below are relative to `apps/starlight/src` unless they start with `apps/` or `plans/`.

## Rules for whoever executes a plan

- Run first: `git diff --stat 6fd58ac..HEAD -- apps/starlight/src`. If a file a plan names has changed, compare the plan's excerpt with the live code; on a mismatch, stop and report.
- Gates, from the repo root: `bun run lint` and `bun run typecheck`, both exit 0. Do not run `format`. Run only the test file a plan names: `bun test <path>` from `apps/starlight`.
- Branch `advisor/<plan-slug>`, one conventional commit per plan (example from the log: `fix(starlight): respond to mentions of secondary bot usernames`). Do not push: every push to `main` deploys.
- Read `TESTING.md` before writing a test. Each test below already carries its admission statement; name tests `test_<behavior>_when_<condition>`.
- Load `.agents/skills/effect/SKILL.md` before touching Effect code and `.agents/skills/grammy-bots/SKILL.md` before touching handlers.
- Stop and report instead of improvising when: an excerpt does not match, a gate fails twice, or the fix needs a file the plan does not name.
- When done, update the Status column in the table below.

## Order and status

| #   | Plan                                                       | Priority | Effort | Evidence                                                                | Depends on | Status                          |
| --- | ---------------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------------- | ---------- | ------------------------------- |
| 1   | Checkpoint summaries never export chat content             | P1       | S      | Code path confirmed; no leaked span found                               | —          | DONE `867be34`                  |
| 2   | Reply is sent when its target message was deleted          | P2       | S      | Not seen in 14 days of logs                                             | —          | DONE `a85620b`                  |
| 3   | A Hindsight recall failure does not stall or drop a batch  | P2       | S      | Hindsight outages seen (13 retention failures); recall failure not seen | —          | DONE `8ef3563`                  |
| 4   | Batches reach the model in message order                   | P2       | S      | Mechanism confirmed in code; not measured                               | —          | DONE `d7af4a4`                  |
| 6   | An unprocessable attachment does not drop the message text | P2       | M      | 2 admission failures in 14 days, cause not logged                       | —          | DONE `658c56c`                  |
| 5   | Decide what happens to unanswered batches                  | P3       | S      | Zero occurrences in 14 days                                             | 3          | IGNORED (owner, 2026-11-10)     |
| 7   | Eval loop for the group participation gate                 | P2       | M      | 85 decision spans in 14 days                                            | —          | IN PROGRESS: waiting for labels |

Production evidence is from Loki (`service_name="starlight-bot"`, WARN and ERROR, last 14 days) and Langfuse observation names. Nothing was reproduced locally.

---

## Plan 1: Checkpoint summaries never export chat content

**Why.** Chats are private unless explicitly marked otherwise, and private chats must not export message content to telemetry. The reply path honors this (`"starlight.private": run?.isPrivate !== false`, `conversation/reply.ts:148`). The compaction summarizer does not: it calls `model.generate` without `private`, and `ai/model.ts:221-226` then sets `recordInputs` and `recordOutputs` to true for the whole conversation head of every chat.

**Evidence.** No observation with session id `checkpoint` exists in Langfuse for the last ~70 days, and no AI SDK span names reached Langfuse in the last 14 days. So no leak was found; the code currently relies on spans not being exported instead of on the privacy flag.

**Current code**, `conversation/conversation.ts:176-192`:

```ts
          summarize: async (input) => {
            const generated = await run(
              model.generate({
                instructions: Checkpoint.summaryInstructions,
                ...
                outputSchema: Checkpoint.Records,
                sessionId: "checkpoint",
                telemetryFunctionId: "conversation-checkpoint",
                tools: {},
              }),
            );
```

**Change.** Add one key between `outputSchema` and `sessionId`:

```ts
                // No chat is in scope here, so the summary is treated as private: usage only, no content.
                private: true,
```

Only `conversation/conversation.ts` changes. Do not change the `summarize` signature or `ai/model.ts`.

**Verify.** `rg -n "private: true" apps/starlight/src/conversation/conversation.ts` returns one match inside `summarize`; lint and typecheck pass.

**Test.** None. The flag is a constant at a wiring site that tests replace with a stub (`lane.test.ts:83`, `reply.test.ts:66`); reaching it needs a test-only seam, which `TESTING.md` forbids.

**Later, if wanted.** To keep checkpoint content for chats that opted out of privacy, pass `runDoc.isPrivate` from the `beforeCompact` hook (`reply.ts:221-246`) through `Deps.summarize` and use `private: run?.isPrivate !== false`.

---

## Plan 2: Reply is sent when its target message was deleted

**Why.** Messages wait for a quiet window and then for the model. If the user deletes the message meanwhile, Telegram rejects the reply with 400. `mapDeliveryError` (`conversation/delivery.ts:129-136`) retries only 429 and 5xx, so the reply is dropped and the rest of the segment is skipped (`conversation/dispatch.ts:9-15`).

**Evidence.** Not seen in 14 days of logs. This is a known Telegram behavior with a one-line fix, not an incident.

**Current code**, `conversation/delivery.ts:100-104`:

```ts
const sent = await api.sendMessage(input.chatId, action.text, {
  message_thread_id: input.threadKey === 0 ? undefined : input.threadKey,
  reply_parameters: action.replyTo != null && action.replyTo !== 0 ? { message_id: action.replyTo } : undefined,
});
```

**Change.**

```ts
              reply_parameters:
                action.replyTo != null && action.replyTo !== 0
                  ? { allow_sending_without_reply: true, message_id: action.replyTo }
                  : undefined,
```

The flag exists in the installed types (`@grammyjs/types@5.0.0`, `message.d.ts:632`). Only `delivery.ts` changes. Leave `mapDeliveryError`, `dispatch.ts` and `setMessageReaction` alone.

**Verify.** `rg -n "allow_sending_without_reply: true" apps/starlight/src/conversation/delivery.ts` returns one match; lint and typecheck pass.

**Test.** None. The layer builds its own `new Api(token)` (`delivery.ts:75`), so asserting the request needs a test-only seam, and the behavior under test would be Telegram's. Manual check after deploy: address the bot, delete your message while it types; the reply arrives as a plain message.

---

## Plan 3: A Hindsight recall failure does not stall or drop a batch

**Why.** For a compacted lane, the lane task recalls long-term memory before answering (`conversation/lane.ts:326`). A recall error propagates into the lane's catch block (`lane.ts:101-131`):

- A retryable error (no status, 408, 429, 5xx; `memory/hindsight.ts:55`, copied by `memory/memory.ts:95`) backs off up to 5 minutes and retries without limit. While Hindsight is down, every compacted lane stops answering.
- A non-retryable error (any other 4xx) counts as permanent, so the user's batch is released unanswered ("Lane batch blocked").

Memory is context, not a precondition: the compaction summary is still in the prompt. Answering without recall is better than not answering.

**Evidence.** Hindsight did fail in production: 13 "Hindsight conversation retention failed" lines in bursts on 10-30, 11-01 and 11-04. That is the retention path. "Lane batch failed, retrying" appeared zero times in 14 days, so the recall path has not failed yet.

**Current code**, `conversation/conversation.ts:140-152`:

```ts
        recall: async (key, batch) => {
          const recalled = await run(
            memory.recall({
              key: ConversationKey.toDb(key),
              query: RecallQuery.build({
                inputs: batch.map((item) => item.payload),
                maxTokens: options.recallMaxQueryTokens,
              }),
            }),
          );

          return recalled.contextMemory;
        },
```

**Change.** Make recall best effort at this wiring site, the same way `typing` already is (`conversation.ts:157-159`, "Best effort: never rejects" in `Lane.Deps`, `lane.ts:56-57`). On failure, log a warning with stable message `"Memory recall failed, answering without it"` and fields `chatId`, `threadKey`, `errorTag`, then return `null`. Use `Effect.catch`, as `conversation.ts:121` does. Update the `recall` comment in `Lane.Deps` (`lane.ts:54`) to say it never rejects and returns `null` when memory is unavailable.

Files: `conversation/conversation.ts`, `conversation/lane.ts` (comment only).

**Not in this plan, on purpose.**

- `flushMemory` in `reply.ts:228-229` stays strict. Its comment states the invariant: Hindsight must hold every fact before the summary drops it. Relaxing it loses memory.
- No retry cap on the lane. `apps/starlight/ARCHITECTURE.md:32` documents unbounded backoff as the design, a cap drops user messages, and no poison batch was observed. See plan 5.

**Verify.** Lint and typecheck pass; `rg -n "Memory recall failed, answering without it" apps/starlight/src` returns one match.

**Test.** Statement: our product must answer a batch when long-term memory is unavailable, because a memory outage otherwise silences or drops messages in every compacted chat. Recall only runs when `Reply.memoryCompacted(view.head)` is true. `conversation.test.ts:113-117` shows how `Memory.Service` is stubbed. If a compacted head cannot be built from existing fixtures without a production seam, skip the test and say so in the commit body. Do not add a seam.

**Trade-off to accept.** The recall result is frozen in a memo for the batch (`lane.ts:320-330`), so a degraded batch is answered without long-term memory even if Hindsight recovers a second later.

---

## Plan 4: Batches reach the model in message order

**Why.** The bot runs updates concurrently (`index.ts:62`, `run(bot)` without `sequentialize`). The message handler downloads and stores media before admitting (`handlers/message.ts:141-148`, then `conversation.admit` at `:171`). A photo followed quickly by a text is therefore admitted after the text. `LaneDoc.admit` appends in arrival order, and `freeze` slices `pending` as is, so the model reads the batch out of order. The album rule in `freeze` also assumes an album is contiguous.

**Evidence.** Mechanism confirmed in code. Not measured in production.

**Current code**, `conversation/lane-doc.ts:142-143`:

```ts
lane.admittedKeys = [...lane.admittedKeys, ...keys].slice(-ADMITTED_KEY_WINDOW);
lane.pending.push(item);
```

`recent` is already kept sorted the same way (`lane-doc.ts:208-212`).

**Change.** Replace the `push` with an ordered insert:

```ts
lane.pending = [...lane.pending, item].toSorted((left, right) => left.payload.messageId - right.payload.messageId);
```

`toSorted` is stable, so two revisions of the same message keep their admission order. Only `conversation/lane-doc.ts` and `conversation/lane.test.ts` change. Do not add `sequentialize`: it serializes every update per chat and adds latency to fix an ordering that one sort already fixes.

**Test**, in `conversation/lane.test.ts`, using the existing `laneItem` helper (`:376`). Statement: our product must give the model a batch in Telegram message order, because media ingestion delays admission and an out-of-order batch makes the reply answer the wrong message. Name: `test_batch_is_frozen_in_message_order_when_a_later_message_is_admitted_first`. Shape: start from `LaneDoc.empty()`, call `LaneDoc.admit(lane, laneItem(11, "second"), 1, 0, timing)` then `LaneDoc.admit(lane, laneItem(10, "first"), 2, 0, timing)`, and expect `LaneDoc.freeze(lane).map((item) => item.payload.text)` to equal `["first", "second"]`. Confirm it fails before the change.

**Verify.** `bun test src/conversation/lane.test.ts` passes including the new test; lint and typecheck pass.

**Stop if** `LaneDoc.empty()` cannot be passed as the `Draft` argument without a cast; report instead of adding a helper.

---

## Plan 6: An unprocessable attachment does not drop the message text

**Why.** Any media ingestion error fails the whole admission (`handlers/message.ts:142-148`, mapped by `mediaAdmissionError` at `:206-212`). Retryable errors are retried five times with exponential delay (`:196-200`), then the update fails and the user's text is never admitted. Two cases can never succeed and still lose the text:

- Download larger than 20 MiB when Telegram declared no size: `SOURCE_TOO_LARGE` is marked `retryable: true` (`media/media.ts:232-237` and `:245-250`), so the bot downloads the file six times and then drops the message.
- A PDF that cannot be inspected (`media.ts:267`) or an image that cannot be normalized (`media.ts:374`): `retryable: false`, so the message is dropped at once.

`Media.ingest` already has the right outcome for a known-bad attachment: `unavailable(source, reason)` (`media.ts:378-388`), used for declared-oversize and unsupported types (`:256-260`, `:270-272`). The model is then told the attachment was unavailable and still sees the text.

**Evidence.** 2 "Conversation admission attempt failed" warnings in 14 days. The log does not include the cause, so it is unknown whether they were media.

**Change.**

1. `media/media.ts:232-237` and `:245-250`: set `retryable: false` on both `SOURCE_TOO_LARGE` errors. `download` is shared with `load`, but a stored reference was already ingested under the limit, so this does not change `load` in practice.
2. `Media.ingest` (`media.ts:255`): a `MediaError` with `retryable === false` becomes `unavailable(source, error.message)`. Retryable errors still fail. Prefer a trailing pipeable on the existing `Effect.fn("Media.ingest")` over a new named wrapper; confirm the form with the `effect` skill.
3. `handlers/message.ts:189-195`: add `message: error.message` to the fields of the existing "Conversation admission attempt failed" warning, so the next failure shows its cause. The message is a fixed string from our code, not user content.

Files: `media/media.ts`, `media/media.test.ts`, `handlers/message.ts`.

**Not in this plan.** Admitting the text after retryable failures are exhausted (Telegram 5xx, S3 down). No exhausted admission was seen in 14 days, and that change decides between "answer without the photo" and "retry later", which is a product call.

**Test**, in `media/media.test.ts`, modeled on the test at `:41` (`Bun.serve` fixture plus a `getFile` stub). Statement: our product must admit a message's text when its attachment can never be processed, because one oversized or corrupt file otherwise drops the whole message. Name: `test_media_is_marked_unavailable_when_download_exceeds_20_mib_without_declared_size`. Shape: the server returns `new Uint8Array(20 * 1024 * 1024 + 1)`, `ingest` is called with `declaredSize: null`, and the result has `availability: "unavailable"`. Confirm it fails before the change.

**Verify.** `bun test src/media/media.test.ts` passes including the new test; lint and typecheck pass.

**Stop if** the change in step 2 needs `unavailable` exported or a change to the `Reference` type.

---

## Plan 5: Decide what happens to unanswered batches (needs the owner's decision)

**What happens today.** When Pi settles a submission as `unanswered` (reasons seen in the Pi Durable types during the audit: `model_error`, `turn_limit`, `interrupted`, `restart_limit`, `nothing_to_answer`, `run_failed`), the lane logs "Lane batch was not answered" and moves on (`conversation/lane.ts:160-168`). The user gets silence. The model call already retries four times (`conversation.ts:241`). Separately, a failing `run` phase retries the same batch forever with backoff capped at 5 minutes (`lane.ts:101-131`, documented in `apps/starlight/ARCHITECTURE.md:32`).

**Evidence.** Both log lines appeared zero times in 14 days. This is latent.

**Options.**

| Option                      | What it does                                                                                                       | Cost                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| A. Alert only (recommended) | Grafana alert on `"Lane batch was not answered"` and `"Lane batch failed, retrying"` with `failures >= 5`; no code | None; you learn when it first happens                         |
| B. One more attempt         | For `model_error` and `interrupted` only, resubmit once with Pi's `continue`                                       | New state in the lane task; risk of a duplicate partial reply |
| C. Tell the user            | Send a short fallback message when a batch addressed to the bot is unanswered                                      | A product decision about tone; noise in groups                |
| D. Cap run retries          | Release the batch after N failures                                                                                 | Drops user messages; contradicts the documented design        |

**Recommendation.** A. The repository rule is no speculative safeguards, and nothing here has failed yet. Revisit B or C when the alert fires, with the real reason in hand.

**For the executor.** Do not implement B, C or D without a written decision in this file. For A, the LogQL selector is `{service_name="starlight-bot"} |= "Lane batch was not answered"`; creating the alert changes shared Grafana state, so ask the owner first. Before B, confirm `afterFailedRun` and `submit({ type: "continue" })` in the installed `@earendil-works/pi-durable` types: `node_modules` holds more than one version, so check the one `apps/starlight/package.json` pins (1.5.0).

---

## Plan 7: Eval loop for the group participation gate (spike)

**Why this decision first.** `DialogueContinuation.evaluate` (`ai/dialogue-continuation.ts`) decides text, reaction or silence for group messages, then applies `ACTION_THRESHOLD = 0.8` (`:10`, `:161`). It is the one model decision with a typed output, a single number to tune, and a clear cost on both sides: speaking uninvited, or ignoring someone. For non-private chats the span already records `{questions, state}` as input (`:122-124`) and `{answers, decision}` with probabilities as output (`:163-171`). Langfuse shows 85 such spans in the last 14 days. Today the only check is a unit test with a mock model at 0.79 and 0.8 (`ai/dialogue-continuation.test.ts:21-27`), which tests the gate, not the judgment.

**Goal of the spike.** Answer two questions with data: is 0.8 the right threshold, and which kinds of messages does the gate get wrong? No prompt or threshold change ships from the spike.

**Steps.**

1. Inventory what exists. Langfuse held experiment runs in September (`starlight-baseline-v2`, `starlight-candidate-v2` to `v4`, `starlight-edge-v1-*`). List datasets and decide whether one is reusable. Do not reuse `emotional-support-output`: project rule 12 forbids emotional-support eval cases.
2. Count the usable material: `DialogueContinuation.evaluate` observations with a non-null input. Only non-private chats have one. This count was not obtained during the audit. If it is under about 100, extend the window before going on.
3. Build a dataset `starlight-participation-v1`: one item per observation, input = recorded `state`, metadata = recorded `answers` and observation id. The owner labels the expected action (`text`, `reaction`, `silence`) by hand; a Langfuse annotation queue fits. Labels must come from a person, not from the model being evaluated.
4. Threshold sweep with no model calls: the recorded probabilities are enough to recompute the decision at 0.5 to 0.95 in steps of 0.05 and compare with the labels. Report a confusion matrix per threshold, with the false-speak rate (text or reaction where the label is silence) as the primary number.
5. Only then compare prompt variants as Langfuse experiments against the same dataset. This needs the `questions` object (`:86-120`) reachable from a script; it is defined inside the function today, so moving it is a small production change to propose, not to make during the spike.

**Deliverable.** A section appended to this file: dataset size, the sweep table, the three most common error patterns with observation ids, and a recommendation (keep 0.8, change it, or change a criterion).

**Boundaries.**

- Never read, export or label content from private chats. Private spans carry no input by design; do not work around that.
- No emotional-support cases, in the dataset or as generic prompt tests.
- Reply quality (`final_output`, 999 spans) is the next candidate but needs a subjective judge. Do it after this loop works.
- Do not build an eval runner or add a dependency before step 4 shows the labels are useful.

### Progress, 2026-11-10

**Data.** 193 `DialogueContinuation.evaluate` observations exist, all with input, from 2026-09-29 to 2026-11-10; none earlier. 192 have an output (one has none). Two prompt versions: 29 spans on 2026-10-07 only, 163 on the current prompt since 2026-10-08. No existing dataset or annotation queue was reusable.

**Created in Langfuse.**

- Score config `participation-expected-action` (categorical: silence 0, reaction 1, text 2), id `532f76e7-e770-4677-9c73-86969b9991e1`.
- Annotation queue `starlight-participation-v1`, id `cmwaxekbc0001mw671hx1csuu`, with all 192 observations pending.
- Dataset `starlight-participation-v1`, id `cmwaxekid0003mw67qbtdihqd`: 192 items, item id `participation-v1-<observationId>`, input = recorded `state`, metadata = recorded `answers`, `decision`, `promptVersion`, `startTime`. `expectedOutput` is empty until labels exist (the expected-output schema was removed because Langfuse rejects unlabeled items against it).

**Label-free sweep, current prompt (163 decisions).** How often the gate would speak at each threshold:

| Threshold | 0.50 | 0.55 | 0.60 | 0.65 | 0.70 | 0.75 | 0.80 | 0.90 | 0.95 |
| --------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| Speaks    | 14   | 9    | 6    | 4    | 3    | 3    | 1    | 1    | 0    |

- The model chose `text` 14 times, with probabilities 0.50, 0.51, 0.52, 0.54, 0.54, 0.57, 0.57, 0.59, 0.60, 0.63, 0.69, 0.75, 0.77, 0.91. At 0.8 only one passes.
- `reaction` was never chosen; its highest probability was 0.17. The reaction path is effectively dead on this prompt.
- Whether those 13 silenced texts were right is the open question the labels answer.

**Next.** The owner labels the queue. Then: write labels into `expectedOutput`, compute confusion matrices per threshold with the false-speak rate as the main number, and list the top error patterns with observation ids.

---

## Considered and rejected

- Non-premium admission: deliberate, per commit `750c0ab`.
- Media position mismatch: `run.media` holds stored references only.
- Replies over 4096 characters: `ai/system-prompt.txt:42` caps replies at about 320 characters.
- Startup `Effect.orDie`: the wrapped effect cannot fail.

## Found but not planned

- Delivery ignores `retry_after` on 429; its `Api` has no `autoRetry`, unlike `bot.ts:12`.
- A defect in the Hindsight retention worker (the source of the 13 logged failures).
- Guest reply error handling.
- Dead schemas in `conversation/run-artifacts.ts:45-58`.

## Not audited

`apps/server`, `apps/web`, `packages/api`, `classification`, and the `pi-durable-postgres` patch.
