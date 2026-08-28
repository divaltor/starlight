# Starlight

Telegram bot system for collecting, classifying, and managing Twitter content with AI-powered search and scheduled publishing.

## Deployment

Configure service env files and copy `hindsight/.env.example` to `hindsight/.env`. Use URL-safe generated secrets because PostgreSQL and Valkey credentials are interpolated into internal URLs.

For local development in a git clone, install hooks manually once with `bunx lefthook install`.

```bash
# Apply reviewed migrations once, then start services
docker compose --env-file hindsight/.env --profile operations run --rm migrate
docker compose --env-file hindsight/.env up -d
```

Alternative deployment: Dokploy, Fly.io, Railway, or manual Docker. Generate encryption key with `openssl rand -hex 32`.

## License

GPL-3.0
