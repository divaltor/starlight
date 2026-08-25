# Prompt Cache Rewrite — Remaining Work

## Decisions

- Keep the durable lane, context-generation, checkpoint, Hindsight, and explicit-cache architecture.
- Chat is agentic: allow multiple tool calls/steps inside the existing run timeout. Bound tool output and total context, not call count.
- Support Telegram photo, sticker, animation/GIF, video, video note, voice/audio, and text/image documents below **20 MiB**. PDFs remain an explicit unavailable marker until their separate pipeline lands. Albums remain one interaction unit.
- Use **24k soft / 48k hard** context caps initially. Recalibrate later from production usage.

## 1. Media

Add `Media` under `apps/starlight/src/media/media.ts` as the single owner of ingestion and retrieval:

```ts
Media.Reference = {
  type, mimeType, size, sha256,
  telegramFileId, telegramFileUniqueId,
  s3Key?, stableDescription?
}

Media.Service.ingest(source) -> Reference
Media.Service.load(reference) -> { bytes, mimeType }
```

Flow:

1. Normalize the Telegram boundary, caption, `media_group_id`, file IDs, MIME, and declared size.
2. Reject declared or downloaded payloads above 20 MiB.
3. Download once, normalize images, hash final bytes, and write to content-addressed S3 (`telegram-media/<sha256>`). Persist the Telegram IDs even when S3 is available.
4. Read S3 first for model invocation. If absent, retry Telegram `getFile`, verify the digest, and repair S3.
5. For replies to old Telegram messages, ingest the attached reply target on demand using its `file_id`.
6. Convert loaded bytes to base64 only while building model D; never persist base64 or signed URLs.
7. If neither source is available, keep the immutable reference and render an explicit unavailable marker.

Image normalization borrows only the design from OpenCode's `image.ts`/`image/photon.ts`: one boundary, typed decode/size failures, pixel and encoded-size limits, and repeated resize/quality attempts. Implement it with `Bun.Image`, not Photon/WASM:

- `maxPixels` protects decoding;
- fit inside 2000×2000 without enlargement;
- JPEG/WebP quality steps until the model payload is bounded;
- preserve video/audio/animation bytes; use a thumbnail only when the original cannot be sent.

Extend `ConversationInput`, prepared-run artifacts, and `Model.Message` with application-owned media parts. Verify the digest on every retry. C stores only type, MIME, digest, and bounded description. Batch selection must not split an arrived Telegram album.

## 2. Tools and stable context

- Remove the one-web-lookup product rule; permit bounded agent steps within the 120-second run deadline.
- Before a tool result returns to the model, canonicalize it and cap it at 50 KiB. Persist the same bounded value plus a digest and truncation marker; do not retain unbounded raw output.
- Enforce a 16 KiB cumulative tool-result budget per generation; stop exposing tools when it is exhausted.
- Keep tool call/result adjacent in C and version the projection in the context fingerprint.
- Changing media or tool rendering starts a new context generation; it never rewrites existing turns.

## 3. Context limits

- Set `CONTEXT_SOFT_TOKEN_CAP=24000` and `CONTEXT_HARD_TOKEN_CAP=48000`.
- Keep the current output/tool reserves.
- Later add an observed-token anchor (`lastObservedInputTokens` plus estimated growth) if real usage shows the conservative 48k boundary is inaccurate.

## 4. Deployment acceptance

Before replacement:

- run text, direct-reply, album, media, tool, checkpoint, delivery-retry, queue-outage, DM, privacy, and forget scenarios on a whitelist-only deployment;
- run live Hindsight retain/profile/forget checks and pin its OpenRouter provider/ZDR policy;
- remove classification's debug auth bypass, unify its API token, and stop publishing PostgreSQL, Valkey, and classification ports;
- move Prisma deployment out of application startup into one approved migration job with backup/restore ownership;
- add queue/lane/delivery/checkpoint/privacy metrics and short recovery/cutover runbooks;
- fix root lint/typecheck, then cut over by stopping and draining the legacy runtime before starting one canary bot replica.

The rewrite is deployable when these checks pass and production telemetry confirms bounded requests, stable context hashes, cache reads after warming, no privacy leak, and no regeneration during delivery retry.

### Cutover and recovery

Assign and verify a PostgreSQL backup/restore owner; stop and drain legacy admission; run `docker compose --profile operations run --rm migrate`; start dependencies; then start one whitelist-only bot replica. Expand only while queue age, delivery failures, privacy events, cache usage, and cost stay within the accepted baseline.

- Queue outage: stop admission growth, restore Valkey, and let the durable outbox republish.
- Expired lane: verify no live owner, then let normal lease fencing resume it.
- Unknown delivery: retry the stored delivery once; never regenerate.
- Privacy incident: stop retention, revoke keys, execute forget, verify audience filtering, then restart.
- Migration failure: keep apps stopped and restore the approved backup or apply a reviewed forward fix.
