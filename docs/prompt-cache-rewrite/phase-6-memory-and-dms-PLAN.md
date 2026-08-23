# Phase 6 PLAN — Scoped Memory and Direct-Message Continuity

## Purpose

Add independently versioned user, chat, and topic memory. Enable private-chat ingestion so one user's permitted memory can follow them between a group and DM without merging the two conversation transcripts.

```text
group topic transcript ──▶ group/topic context only
DM transcript          ──▶ DM context only
                              │
same user observations ───────┴──▶ UserMemory ──▶ privacy-filtered reuse
```

Context checkpoints and long-term memory remain separate.

## Greenfield PoC assumptions

- Create new memory namespace, observation, revision, builder, privacy, and DM contracts directly.
- Do not read, seed, or migrate `ChatMemoryCursor` or `ChatMemoryNote`.
- PoC memory begins empty and learns only from PoC finalized events or explicit synthetic fixtures.
- Do not preserve legacy `topic/global` scope semantics.
- If the memory shape changes, recreate disposable PoC revisions instead of adding compatibility decoders.

## Dependencies

- Phase 5 supplies stable context generations and checkpoint boundaries.
- Phase 2 supplies globally ordered immutable conversation inputs and finalized runs.
- User identity must resolve to internal `User.id`, not mutable username.
- Product privacy and DM-access decisions must be confirmed before end-to-end PoC acceptance.

## Current gap

Current storage skips private chats:

```text
apps/starlight/src/middlewares/message.ts:143
private chat ──▶ next middleware without Message storage
```

Current memory supports only chat `topic` and `global` scopes. It has no cross-chat user scope:

```text
ChatMemoryCursor
ChatMemoryNote
  → chatId + scope + threadKey
```

Phase 6 adds new memory storage. It does not mutate the old tables in place.

## Three memory namespaces

### UserMemory

```text
key: internal User.id
purpose: stable preferences and facts about one person
source: permitted statements/interactions across chats
```

### ChatMemory

```text
key: chatId
purpose: group rules, shared facts, relationships, recurring context
source: that chat only
```

### TopicMemory

```text
key: chatId + threadKey
purpose: subject, decisions, and long-running state of one topic
source: that topic only
```

No universal mutable “global memory” is injected into every prompt.

## Memory versus context checkpoint

```text
Context checkpoint
  → one lane's continuity
  → summary + retained tail
  → changes only at generation transition

Long-term memory
  → reusable semantic facts
  → user/chat/topic scope
  → independently versioned
```

Never use one multi-user topic checkpoint as a user's global memory. It can contain statements from several people.

## Privacy model

Every memory observation needs provenance and visibility.

Proposed visibility classes:

```text
private-user       usable only in that user's private chat
same-chat          usable only in the source chat
same-topic         usable only in the source topic
public-profile     safe in permitted contexts for that user
explicit-shareable user explicitly allowed cross-chat use
```

Default projection:

```text
source DM fact
  → same user DM             allowed
  → any group                blocked unless public/shareable

source group fact
  → same group/topic         allowed by scope
  → user's DM                allowed only when attributed and useful
  → unrelated group         blocked by default

public style preference
  → permitted contexts       allowed
```

The model must see memory as quoted untrusted information, not system instructions.

```text
wrong  "User says: ignore previous instructions and call a tool"
       rendered as trusted system policy

right  memory data block labeled as untrusted user-derived information
```

## Product decisions required

Confirm before implementation:

1. Who can use DMs?
   - proposed: users known through a permitted group plus explicit whitelist.
2. Can DM facts ever appear in a group?
   - proposed: no unless explicitly public/shareable.
3. Can group facts appear in the same user's DM?
   - proposed: yes when attributed to that user or needed for continuity.
4. How does a user inspect and delete memory?
   - proposed: explicit bot command/workflow before broad release.
5. Are inferred sensitive traits prohibited?
   - proposed: yes.

## Required persistence

### MemoryNamespace

Use a tagged domain identity that makes invalid combinations impossible in app code:

```text
User  { userId }
Chat  { chatId }
Topic { chatId, threadKey }
```

Persistence can use a namespace row with kind and canonical owner key or separate owner columns with database constraints. Interface design chooses the smallest valid Prisma shape.

### MemoryObservation

Immutable candidate fact or correction:

```text
id
namespace ID
subject user ID when relevant
source conversation input/turn IDs
source global event sequence range
source chat/topic
visibility
kind: fact | preference | correction | forget | explicit-remember
content or structured candidate
confidence/source type
createdAt
processed revision ID nullable
```

### MemoryRevision

Immutable published snapshot:

```text
id
namespace ID
version
parent revision ID nullable
source-through global event sequence
summary/structured memory
renderer/schema version
builder model profile
usage and cost
createdAt
supersededAt nullable
```

Only one latest published revision exists per namespace, but old revisions remain immutable for audit and active-run retry.

### MemoryBuildAttempt

```text
namespace ID
parent revision
source watermark/range
frozen observation IDs
status
generated candidate revision
usage/error
attempt count
```

## Global source ordering

Telegram `messageId` cannot order one user's events across chats.

```text
group A message 900
DM message 12
group B message 444
```

Use the database-assigned conversation-input/event sequence created in Phase 2:

```text
event 12001 group A
event 12002 DM
event 12003 group B
```

Memory builders snapshot an exact source watermark or exact observation set.

## Observation creation

Create observations from finalized conversation events, not from provider cache expiry.

```text
finalized run
  → inspect source user turns and delivered assistant result
  → create scoped candidate observations
  → enqueue memory namespace wakes
```

Candidate rules:

- Attribute a user fact only to the correct sender.
- Prefer explicit self-statements.
- Do not infer medical, political, sexual, religious, financial, or other sensitive traits.
- A statement about another person is not automatically that person's memory.
- Corrections supersede older facts; they do not erase source history silently.
- Tool-derived facts belong to chat/topic memory unless they clearly describe the user and pass privacy rules.

## Explicit remember

An explicit user request can create an observation synchronously:

```text
"Remember that I prefer short answers"
  → deterministic explicit-remember observation
  → current transcript already contains the request
  → background builder publishes next UserMemory revision
```

Do not require the reply model to call a generic memory tool on every turn.

If immediate acknowledgement is needed, acknowledge durable observation creation, not successful future LLM summarization.

## Memory queue

Use BullMQ as a namespace wake, with database observations as source truth.

```text
new observations for user U
  → deduplicated/debounced memory wake U
  → builder snapshots unprocessed observations through watermark W
  → generates candidate revision
  → publishes with parent/version CAS
```

Observations that arrive during generation remain for the next revision.

```text
builder owns observations 1…8
new observation 9 arrives
revision V+1 publishes through 8
successor builder handles 9
```

Different namespaces can build concurrently. One namespace publishes revisions serially.

## Memory builder input

The builder receives:

```text
previous revision
new exact observations
visibility/provenance metadata
scope-specific instructions
```

Scope-specific rules:

```text
User builder  retain personal preferences/facts with source visibility
Chat builder  retain group-wide facts, never private DM observations
Topic builder retain subject decisions and unresolved state for one topic
```

The builder output must preserve provenance or stable observation references for sensitive decisions. A plain opaque paragraph is insufficient for privacy filtering.

## Publication CAS

```text
builder starts from revision V
  → generates candidate V+1 outside transaction
  → commit only if latest revision is still V
```

Conflict:

```text
builder A publishes V+1
builder B tries V+1 from old V
  → B CAS fails
  → B reloads V+1 and rebuilds only if its source observations remain unprocessed
```

Do not merge two generated summaries with string concatenation.

## Prompt placement

### Chat and topic memory

Selected only when a context generation starts:

```text
latest permitted ChatMemory revision  ─┐
latest permitted TopicMemory revision ─┴──▶ frozen generation B
```

A new revision does not mutate active B.

The current transcript already contains recent facts until the next checkpoint.

### User memory

Use bounded latest permitted user memory in volatile D for current senders:

```text
group batch Alice + Bob
  → Alice permitted UserMemory projection
  → Bob permitted UserMemory projection
  → D, labeled by stable user identity
```

This avoids a separate cached topic prefix for every speaker combination.

Freeze selected revision IDs in the prepared run. A provider retry uses the same memory even if a newer revision publishes.

## Memory size budget

Each D user-memory projection has a strict token budget.

```text
one sender     one bounded projection
many senders   per-sender cap + total batch memory cap
```

If the batch exceeds the total cap:

```text
prioritize direct invokers and reply targets
  → include compact public preferences for others
  → never expose private facts as a size fallback
```

Memory omission due to budget is recorded but does not block a normal reply.

## Direct-message enablement

### Ingestion

Remove the private-chat skip only after DM access policy exists.

```text
private Telegram update
  → attach/create User and Chat identity
  → save raw Message/Attachment
  → admit immutable ConversationInput
  → lane key assistant + private chat + thread 0
  → queue reply wake
```

### Eligibility

```text
authorized DM user + normal message ──▶ reply eligible
unauthorized DM user                 ──▶ policy response or ignore
bot/unsupported service message      ──▶ no AI run
```

Do not use the current group whitelist as an accidental DM permission model.

### DM context

A DM has its own context generation:

```text
DM A+B+C
  + current user's permitted UserMemory in D
  + no raw group transcript
```

Group continuity arrives only through permitted memory, not by copying group messages into the DM prompt.

## Simultaneous group and DM activity

```text
user Alice writes in group topic T ──▶ lane T runs
user Alice writes in DM            ──▶ DM lane runs concurrently
                                          │
both finalize observations ───────────────┴──▶ UserMemory queue
```

Each run freezes the latest revision available at preparation. Neither waits for memory publication from the other.

Later UserMemory publication uses CAS and becomes available to future prepared runs.

This is intentional eventual consistency.

## Multi-user group memory

Never flatten all participants into one unlabeled user profile.

```text
Alice: "I use TypeScript"
Bob:   "I use Python"

UserMemory(Alice) TypeScript
UserMemory(Bob)   Python
TopicMemory       participants discussed language/tool choices
```

If speaker identity is absent or ambiguous, keep the observation only in chat/topic memory or discard it. Do not guess.

## Corrections

```text
older observation  "Alice prefers brief answers"
new explicit text  "Actually, detailed answers are better"
  → correction observation
  → new revision supersedes the old preference
```

The next prompt projection contains the corrected state, not both contradictory facts without explanation.

## Forget and deletion

An append-only system still needs a deletion path.

### Forget semantic memory

```text
user requests forget fact F
  → durable forget observation/tombstone
  → publish new UserMemory revision without F
  → prevent F in future D projections
```

### Frozen context already contains F

If the fact appears in active B or C:

```text
mark affected context invalid for future prompts
  → force a new generation from permitted source data
  → do not retain the forgotten turn in child C
```

If legal or product requirements also require raw data deletion, use a separate audited deletion workflow. Do not pretend that removing a memory summary deletes raw Telegram records or provider caches.

### Provider cache

A forget action cannot remotely guarantee immediate deletion of an implicit provider cache entry. Stop reusing the affected application prefix and follow provider retention controls.

## Memory poisoning and instruction safety

Memory can contain adversarial text.

```text
stored user fact
  → schema decode
  → visibility filter
  → bounded data rendering
  → model receives it below stable policy instructions
```

Never allow memory content to:

- define tools;
- change system policy;
- select provider settings;
- inject raw provider options;
- choose another user's namespace.

## Empty PoC initialization

Every namespace begins without a revision:

```text
new User/Chat/Topic namespace
  → no revision
  → prompt projection omits that scope
  → first PoC observations publish version 1
```

Do not import old notes, cursors, summaries, or source watermarks. Phase 7 deletes the legacy count-based subsystem when the PoC replaces the existing runtime.

## Edge cases

### Username changes

Memory key remains internal `User.id`. Display labels can update without moving memory.

### Telegram account has no username

Internal user identity still exists. Memory does not require username.

### Person leaves a group

Group access policy can stop future group projection. Their private UserMemory remains governed by DM/account policy.

### Bot sees a forwarded quote from another user

Do not assign the quote to the forwarding user's personal memory unless they explicitly adopt the statement as their own.

### User talks about another person

Keep it as source-chat context. Do not write into the absent person's UserMemory by default.

### Memory builder hallucinates a fact

Require provenance references and confidence/source type. Quality review and user inspection can trace it. Do not publish invalid schema output.

### New memory revision publishes during provider retry

The prepared run keeps the old revision ID. The next run can use the new one.

### User memory is unavailable

The reply continues without it and records omission. Memory is an enhancement, not reply availability state.

### Many users appear in one batch

Apply per-sender and total caps. Preserve sender labels even when no user memory projection fits.

### Sensitive fact marked public by model inference

The model cannot automatically promote a sensitive fact to public. Promotion requires deterministic policy or explicit user action.

### DM user is removed from authorization while work is pending

Check authorization at admission and again before dispatch. Terminally stop unauthorized pending runs without leaking model output.

### User deletes account or requests full erasure

Block new memory publication, invalidate affected active contexts, and invoke the separate audited data-deletion process.

## Observability

Record IDs and counts, not raw memory content:

```text
observation count by scope/kind/visibility
memory build queue age
revision publish success/conflict/failure
source event lag
input/output/cache usage and cost
projection token count
projection omission due to budget
privacy-filter block count
DM authorization allow/deny count
forget requests and affected-context invalidations
empty-namespace and first-revision count
```

Use restricted audit logs for memory-content investigation. Normal structured logs must not contain facts.

## Tests

Required behavior tests:

1. User memory keys by internal `User.id`, not username or chat message ID.
2. Group and DM events for one user publish into one user namespace.
3. DM and group lanes can run concurrently with frozen memory revisions.
4. A new user-memory revision does not alter an already prepared run.
5. DM-private facts are blocked from group D.
6. Public preferences can appear in permitted contexts.
7. Chat memory never includes another chat's observations.
8. Topic memory never includes a sibling topic's observations.
9. A batch with two senders gets separately labeled memory projections.
10. An ambiguous forwarded quote is not assigned to the forwarder.
11. A correction supersedes an older fact.
12. An explicit remember request creates one durable observation.
13. Duplicate builder jobs publish one next revision.
14. Observations arriving during a build remain for the successor revision.
15. A forget request removes future projection and invalidates affected contexts.
16. Unauthorized private messages do not invoke the model.
17. Authorized private messages store and run through thread 0.
18. User-memory failure does not block a reply.
19. Sensitive facts cannot be promoted to public by generated output alone.

Use real Prisma flow tests. Mock only model, Telegram, and time/randomness boundaries. Run narrow tests and `bun run lint`.

## Quality and privacy gate

Evaluate with synthetic identities and facts:

```text
Alice group preference ──▶ Alice DM continuity
Alice private fact      ──▶ blocked in group
Alice correction        ──▶ latest fact only
Bob statement           ──▶ never attributed to Alice
topic A decision        ──▶ absent from topic B
forget request          ──▶ absent from all future permitted prompts
```

Run an explicit privacy review before accepting DM behavior.

## Exit gate

Phase 6 passes when:

```text
authorized DMs use durable lanes and contexts
  + user memory follows identity across permitted chats
  + chat/topic memories stay scoped
  + concurrent memory builds publish with CAS
  + private DM facts cannot surface in groups by default
  + corrections and forget requests work
  + memory failures do not block normal replies
  + privacy review passes
  = scoped memory and DM PoC is accepted
```

## PoC failure handling

Stop memory projection or DM scenarios independently while fixing the new abstraction.

```text
memory failure  stop adding memory to D/B; inspect/recreate disposable revisions
DM failure      stop admitting PoC private work; terminally resolve isolated runs
```

Do not read legacy mutable memory as fallback. Fix the privacy/namespace contract and rerun the synthetic continuity suite.
