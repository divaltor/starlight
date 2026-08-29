# Starlight

Telegram bot that turns liked tweets into a searchable, self-hosted media library — collect, classify, and browse Twitter images with AI.

```text
Telegram ─▶ apps/starlight (bot)          user chat, AI conversations, media intake
                │
                ▼
            apps/server (worker)           scrapes liked tweets, stores images to S3,
                │                          enqueues BullMQ jobs over Valkey
                ├─▶ classification (ML)    CLIP tagging, pHash dedup, embeddings
                │
                ▼
            PostgreSQL ◀── apps/web        TanStack Start UI to browse and search
```

## Layers

**`apps/starlight`** — the Telegram bot users talk to: GrammY handlers for media and group events, AI conversations with long-term memory served by Hindsight. Setup: copy `.env.example` to `.env` and fill in `BOT_TOKEN` (from @BotFather), `DATABASE_URL`, and `REDIS_URL`; run with `bun dev`.

**`apps/server`** — the media pipeline worker: scrapes liked tweets via `@the-convocation/twitter-scraper`, uploads images to S3-compatible storage, and runs BullMQ queues that call `classification` for tagging and embeddings, writing results to PostgreSQL. Setup: copy `.env.example` to `.env` and fill in database, Redis, S3 (`AWS_*` + `BASE_CDN_URL`), and `ML_BASE_URL`/`ML_API_TOKEN` pointing at the classification service; run with `bun dev`.

**`classification`** — the Python ML service: FastAPI endpoints wrapping CLIP models for image classification, pHash duplicate detection, and the text embedding/reranker models Hindsight uses for memory retrieval. Setup: copy `.env.example` to `.env`, pick models and `CLASSIFICATION_API_TOKEN` (match `ML_API_TOKEN` in `apps/server`), install with `uv sync`, serve `app.main:app` (Docker uses `granian`; first start downloads model weights, a GPU via `docker-compose.rocm.yaml` is optional).

**`apps/web`** — the browsing UI: TanStack Start app with oRPC over PostgreSQL for browsing classified media and searching it by tags and embeddings. Setup: copy `.env.example` to `.env` and fill in `DATABASE_URL`, `REDIS_URL`, and `BASE_CDN_URL`; run with `bun dev` (port 3001).

**`hindsight`** — the memory service behind the bot's conversations, pulled as a prebuilt image. Setup: copy the root `.env.example` to `.env` (compose-wide secrets).

### How memory works

```text
apps/starlight (bot)
  run finalized ─▶ memoryObservation rows in PostgreSQL
                        │
                        ▼ HindsightRetention worker scans every 30s,
                          renders ordered transcript, sends retain()
                          (replace-mode, idempotent operationId,
                          watermark advances only on success)
                                   │
                                   ▼
Hindsight (ghcr.io/vectorize-io/hindsight)
  LLM (OpenRouter) extracts facts ▸ stored as pgvector in the shared PostgreSQL
                        │                    ▲ embeddings from classification /v1/openai
                        ▼                    ▲ rerank from classification /v1/rerank
                                   │
                                   ▼
Memory.recall(query) ◀── top matches (≤800 tokens)
  │
  ▼ deduped lines rendered into the bot prompt (≤3200 chars)
```

Each conversation gets one memory namespace (`assistantId:chatId:threadKey`). Raw transcripts are never stored as text by Hindsight (`HINDSIGHT_API_STORE_DOCUMENT_TEXT=false`) — the bot's PostgreSQL remains the source of truth.

### The ML layer is optional

`classification` is a replaceable implementation of two HTTP shapes: OpenAI-shaped embeddings (`/v1/openai`) and Cohere-shaped rerank (`/v1/rerank`). Hindsight only talks to those endpoints, so any compatible service works — point `CLASSIFICATION_URL` (or directly `HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL` / `HINDSIGHT_API_RERANKER_COHERE_BASE_URL`) at it and match the model names. Image classification for `apps/server` is the other consumer; disable it with `ENABLE_CLASSIFICATION=false` and `ENABLE_EMBEDDINGS=false` in `apps/server/.env`. If you keep `classification`, models are pinned by commit in `classification/.env.example`.

### Hindsight configuration

The root `.env` (copy from `.env.example`) holds only the secrets the Compose file interpolates: `OPENROUTER_API_KEY` (LLM that extracts and consolidates memories), `CLASSIFICATION_API_TOKEN` (must match `ML_API_TOKEN` in `apps/server/.env`), `HINDSIGHT_API_KEY` (must match `apps/starlight/.env`), plus `POSTGRES_PASSWORD`, `POSTGRES_DB`, and `VALKEY_PASSWORD`. All non-secret `HINDSIGHT_API_*` settings — LLM provider and model, embeddings/reranker endpoints, retain chunk sizes, OTel — are set inline in the `hindsight:` service of `docker-compose.yaml`, so the whole stack ships one reviewed configuration.

## Deployment

Configure service env files and copy the root `.env.example` to `.env`. Use URL-safe generated secrets because PostgreSQL and Valkey credentials are interpolated into internal URLs.

For local development in a git clone, install hooks manually once with `bunx lefthook install`.

```bash
# Apply reviewed migrations once, then start services
docker compose --env-file .env --profile operations run --rm migrate
docker compose --env-file .env up -d
```

Alternative deployment: Dokploy, Fly.io, Railway, or manual Docker. Generate encryption key with `openssl rand -hex 32`.

## License

MIT
