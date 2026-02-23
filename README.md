# Starlight

Telegram bot system for collecting, classifying, and managing Twitter content with AI-powered search and scheduled publishing.

## Deployment

Configure environment variables in `apps/server/.env` and `apps/web/.env` including BOT_TOKEN from @BotFather, DATABASE_URL, REDIS_URL, and S3 credentials.

```bash
# Start all services with Docker Compose
docker-compose up -d

# Initialize database
bun db:push
```

Alternative deployment: Dokploy, Fly.io, Railway, or manual Docker. Generate encryption key with `openssl rand -hex 32`.

## License

GPL-3.0
