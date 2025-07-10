# Starlight

Telegram bot system for collecting and managing Twitter content.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- [Bun](https://bun.sh/) (for local development)

## Required Services

- **PostgreSQL**: Database storage
- **Redis**: Session management and job queues
- **S3 Compatible Storage**: Media storage

## Quick Deployment

### 1. Clone and Setup

```bash
git clone <repository-url>
cd starlight
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

### 2. Configure Environment Variables

Edit `.env` files in both `apps/server` and `apps/web`:

```env
# Required
BOT_TOKEN=your_telegram_bot_token_from_@BotFather
DATABASE_URL=postgresql://starlight-admin:starlight@localhost:5432/starlight
REDIS_URL=redis://localhost:6379
COOKIE_ENCRYPTION_KEY=your_64_character_hex_key_for_cookie_encryption
COOKIE_ENCRYPTION_SALT=your_16_character_salt_here

# S3 Storage
AWS_ENDPOINT=https://your-r2-endpoint.com
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key

# URLs
BASE_FRONTEND_URL=http://localhost:3001
BASE_CDN_URL=https://your-cdn-url.com
```

### 3. Deploy with Docker Compose

```bash
# Start all services
docker-compose up -d

# Setup database
bun db:push

# View logs
docker-compose logs -f
```

## Deployment Options

### Self-Hosted PaaS

- **[Dokploy](https://dokploy.com/)** - Simple deployment platform

### Cloud Platforms

- **[Fly.io](https://fly.io/)** - Global application platform
- **[Railway](https://railway.app/)** - Simple cloud deployment

### Manual Docker Deployment

```bash
# Build images
docker build -t starlight-server -f apps/server/Dockerfile .
docker build -t starlight-web -f apps/web/Dockerfile .

# Run containers
docker run -d --name starlight-server --env-file apps/server/.env --network host starlight-server
docker run -d --name starlight-web --env-file apps/web/.env -p 3001:3001 starlight-web
```

## Maintenance Commands

```bash
# Development
bun dev                  # Start all services
bun dev:web             # Web app only (port 3001)
bun dev:server          # Server/bot only

# Database
bun db:push             # Push schema changes
bun db:migrate          # Run migrations
bun db:studio           # Open Prisma Studio

# Code quality
bun check               # Lint and format
bun check-types         # Type check
```

## Security

Generate encryption key:
```bash
openssl rand -hex 32  # For COOKIE_ENCRYPTION_KEY
```

## License

GPL-3.0
