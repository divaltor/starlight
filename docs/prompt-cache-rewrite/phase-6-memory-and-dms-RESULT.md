# Phase 6 RESULT — Scoped Memory and Direct Messages

## Status

The Phase 6 runtime is implemented. Live memory-quality evaluation and the privacy acceptance review remain Phase 7 gates.

## Product decisions

- Direct messages are default-deny and use `WHITELIST_DM_USER_IDS`.
- DM-private memory never enters a group prompt.
- Attributed group memory can support the same user's DM.
- Sensitive inferred traits require `MEMORY_SENSITIVE_CONFIDENCE_MIN`, default `0.9`.
- `/forget <text>` is available in authorized DMs. Memory inspection remains deferred.
- A forget request conservatively removes all items attributed to that user in affected namespaces when exact semantic deletion cannot be proved.

## Implemented runtime

```text
finalized run
  → immutable user/chat/topic observations
  → PostgreSQL namespace scan
  → deduplicated BullMQ memory wake
  → model builds one candidate revision
  → parent/version CAS publishes one immutable revision

prepared reply
  → freeze user revision IDs in D
  → freeze chat/topic revisions when generation B starts
  → apply visibility filter and size bounds
```

Main owners:

- `apps/starlight/src/memory/memory.ts` owns observations, revision building, publication CAS, privacy projection, and forget behavior.
- `apps/starlight/src/memory/queue.ts` owns advisory memory wakes and database reconciliation.
- `apps/starlight/src/context/context.ts` freezes scoped memory into context generations and prepared requests.
- `apps/starlight/src/handlers/memory.ts` owns the authorized `/forget` command boundary.
- `packages/utils/prisma/migrations/20260824135542_scoped_memory_and_dms/migration.sql` adds the new persistence model.

## Privacy and retry behavior

- User memory keys by internal `User.id`.
- A prepared run stores immutable user-memory revision IDs.
- Mixed-group memory items are blocked from all group prompts rather than exposed in one source group.
- Pending forget observations suppress old memory projection.
- Forget publication locks the user and all known user lanes. It waits for active runs before confirmation.
- A forget request marks affected lanes for a new empty-tail context generation, so old B/C data is not reused.
- Memory build failures do not block conversation workers. PostgreSQL observations remain the retry source.

## Validation

- `bun run db:migrate -- --name scoped_memory_and_dms` created and applied the migration against fresh PostgreSQL.
- `bun run db:deploy` applied all 58 migrations from an empty database.
- Focused context, conversation, and privacy tests: 14 passed.
- The DM-private-to-group regression test was proven red under a deliberate privacy mutation.
- `bun run lint` and `bun run typecheck` pass.

## Remaining acceptance work

1. Run live memory-builder quality evaluation for attribution, corrections, sensitive inference, and forget results.
2. Run the explicit privacy review with synthetic DM/group identities.
3. Exercise DM authorization changes across process restarts and pending generated runs.
4. Establish queue, revision-conflict, omission, and privacy-block baselines.
5. Close the earlier media/album admission and bounded stable tool-projection gaps before final acceptance.
6. Keep legacy `ChatMemoryCursor` and `ChatMemoryNote` tables until a separately approved data-retention decision. No runtime code reads them.
