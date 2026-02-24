## Architecture & Data Flow

```
Bot/Mini App ──> Scraper (BullMQ) ──> AI (CLIP/pHash) ──> PostgreSQL (pgvector) <── API (oRPC)
```

## Project Structure

| Path              | Purpose                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `apps/server`     | Grammy Telegram bot, and BullMQ worker implementations.             |
| `apps/web`        | React 19 Telegram Mini App dashboard (Uber-style aesthetics).       |
| `packages/api`    | API Layer: oRPC router definitions and shared contract types.       |
| `packages/utils`  | Infrastructure: Prisma schema, database client, and business logic. |
| `packages/crypto` | Security: Session encryption and perceptual image hashing (pHash).  |

## Critical Rules

1. Use `@/` alias for all internal imports; relative imports are forbidden in apps.
2. Prefer Bun APIs (`Bun.file`, `Bun.write`, etc.) over Node.js `fs` equivalents.
3. Treat Telegram IDs as JS safe integers (`number`) in app code; convert to `BigInt` only where required by Prisma/db types.

## Maintenance & Tasks

- MUST use `bun` for package management.
- MUST use `bun run format` to apply Biome formatting for `apps/web` and `apps/server`. DON'T use `tsc` or `bunx <formatter|linter>`
- ALWAYS use scripts from package.json to create and apply migrations via Prisma. Never write migration files manually.
- ALWAYS look for skills you could apply before editing files.
