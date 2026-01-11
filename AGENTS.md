# Starlight

AI-powered media management system for collecting, classifying, and managing Twitter content via Telegram.

## Architecture & Data Flow
Modular Turborepo monorepo with automated quality (Biome, oRPC) and semantic search (CLIP, pgvector).

```text
Bot/Mini App ──> Scraper (BullMQ) ──> AI (CLIP/pHash) ──> PostgreSQL (pgvector) <── API (oRPC)
```

1. Telegram Bot receives links or Mini App triggers timeline scraping.
2. BullMQ workers fetch media, generate CLIP embeddings, and pHash for duplicate detection.
3. React 19 Mini App queries oRPC API for semantic search and media management.

## Project Structure
| Path | Purpose |
|------|---------|
| `apps/server` | Hono API, Grammy Telegram bot, and BullMQ worker implementations. |
| `apps/web` | React 19 Telegram Mini App dashboard (Uber-style aesthetics). |
| `packages/api` | API Layer: oRPC router definitions and shared contract types. |
| `packages/utils` | Infrastructure: Prisma schema, database client, and business logic. |
| `packages/crypto` | Security: Session encryption and perceptual image hashing (pHash). |

## Critical Rules
1. Use `@/` alias for all internal imports; relative imports are forbidden in apps.
2. Use strict typing and oRPC inference capabilities.
3. All client-server communication MUST use oRPC routers in `packages/api`.
4. Uber-style design via DaisyUI + React Aria. Use semantic HTML and alt text.
- DON'T run typechecks and build scripts.

## Maintenance & Tasks
- Use `bun add <pkg> --filter <workspace>`. Never edit `package.json` manually.
- Keep this file updated; it is the primary source of truth for agents.
