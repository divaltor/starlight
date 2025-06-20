# Starlight

A powerful Telegram bot system for collecting and managing Twitter content, built with TypeScript and modern web technologies.

## Features

- 🤖 **Telegram Bot**: Built with Grammy.js for seamless user interactions
- 🔄 **Background Processing**: BullMQ with Redis for efficient job queues
- 🎥 **Media Handling**: Support for images and videos with perceptual hashing for finding duplicates
- 🌐 **Web Dashboard**: React-based interface for content management
- ⚡ **High Performance**: Optimized for speed with Bun runtime
- 🔒 **Secure**: Encrypted cookie storage and secure authentication
- 📊 **Monitoring**: Optional Axiom integration for production logging

## Architecture

**Starlight** consists of two main applications:

- **Server** (`apps/server`): Telegram bot and background workers
- **Web** (`apps/web`): Dashboard interface (couple integration with Telegram Mini Apps) built with TanStack Start

## Prerequisites

Before you begin, ensure you have the following installed:

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- [Bun](https://bun.sh/) (for local development)

## Required Services

- **PostgreSQL**: Persistent storage for user data and media
- **Redis**: Session management and job queue storage
- **S3 Compatible Storage**: For storing scraped media (R2 recommended, but not required)
- **Axiom** (Optional): Logging service for production environments

## Quick Start

### 1. Clone the Repository

```bash
git clone <repository-url>
cd starlight
```

### 2. Environment Configuration

Create environment files from the examples:

```bash
# Server environment
cp apps/server/.env.example apps/server/.env

# Web environment
cp apps/web/.env.example apps/web/.env
```

### 3. Configure Environment Variables

Edit the `.env` files in both `apps/server` and `apps/web` with your configuration:

#### Required Variables

```env
# Telegram Bot Configuration
BOT_TOKEN=your_telegram_bot_token_from_@BotFather

# Database URLs
DATABASE_URL=postgresql://starlight-admin:starlight@localhost:5432/starlight
REDIS_URL=redis://localhost:6379

# Security Keys (generate secure random strings)
SECRET_KEY=your_32_character_minimum_secret_key_here
COOKIE_ENCRYPTION_KEY=your_64_character_hex_key_for_cookie_encryption
COOKIE_ENCRYPTION_SALT=your_16_character_salt_here

# S3 Storage Configuration
AWS_ENDPOINT=https://your-r2-endpoint.com
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key

# URL Configuration
BASE_FRONTEND_URL=http://localhost:3001
BASE_CDN_URL=https://your-cdn-url.com
DEFAULT_MEDIA_PATH=media/
```

#### Optional Variables

```env
# Logging (Production only)
AXIOM_DATASET=your_axiom_dataset
AXIOM_TOKEN=your_axiom_token

# Additional Configuration
YOUTUBE_DL_PATH=yt-dlp
ENVIRONMENT=dev
```

### 4. Start Services with Docker Compose

Start all services (PostgreSQL, Redis, Server, and Web) using Docker Compose:

```bash
# Start all services
docker-compose up -d

# Or start only infrastructure services for development
docker-compose up -d redis postgresql
```

### 5. Database Setup

Run database migrations:

```bash
# From project root
bun db:push
```

### 6. Development Mode

Start all services in development mode:

```bash
# From project root
bun dev
```

Or start services individually:

```bash
# Web application only (port 3001)
bun dev:web

# Server/bot only
bun dev:server
```

## Docker Deployment

### Build Docker Images

#### Server Image

```bash
docker build -t starlight-server -f apps/server/Dockerfile .
```

#### Web Image

```bash
docker build -t starlight-web -f apps/web/Dockerfile .
```

### Run with Docker

#### Server Container

```bash
docker run -d \
  --name starlight-server \
  --env-file apps/server/.env \
  --network host \
  starlight-server
```

#### Web Container

```bash
docker run -d \
  --name starlight-web \
  --env-file apps/web/.env \
  -p 3001:3001 \
  starlight-web
```

### Docker Compose Deployment

The project includes a complete `docker-compose.yaml` file that builds and runs all services:

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down

# Rebuild and restart
docker-compose up -d --build
```

The `docker-compose.yaml` includes:
- **PostgreSQL 17**: Database with persistent storage
- **Redis 8**: Cache and job queue storage
- **Starlight Server**: Telegram bot and background workers
- **Starlight Web**: Dashboard interface (port 3001)

## Deployment Options

### Vercel (Web App Only)

For Vercel deployment, update the web app preset:

```typescript
// apps/web/app.config.ts
export default defineConfig({
  // ... other config
  server: {
    preset: "vercel", // Change from "bun" to "vercel"
  },
});
```

### Bare Metal / VPS

#### Recommended: Self-Hosted PaaS Solutions

For easy bare-metal server management, we recommend using:

- **[Coolify](https://coolify.io/)** - Open-source, self-hostable Heroku/Netlify alternative
- **[Dokploy](https://dokploy.com/)** - Simple deployment platform for Docker applications

These platforms provide:
- One-click Docker deployments
- Automatic SSL certificates
- Database management
- Environment variable management
- Built-in monitoring and logging

#### Manual Deployment

1. Clone the repository on your server
2. Install Docker and Docker Compose
3. Configure environment variables
4. Build and run the containers

### Cloud Platforms

Thanks to Docker containerization, Starlight can be deployed on virtually any platform:

- **[Fly.io](https://fly.io/)** - Global application platform
- **[Railway](https://railway.app/)** - Simple cloud deployment
- **[AWS](https://aws.amazon.com/)** - ECS, Fargate, or EC2
- **[Google Cloud](https://cloud.google.com/)** - Cloud Run or GKE
- **[Azure](https://azure.microsoft.com/)** - Container Instances or AKS
- **[DigitalOcean](https://www.digitalocean.com/)** - App Platform or Droplets
- **[Render](https://render.com/)** - Managed cloud services

Each platform may require specific configuration adjustments for networking and environment variables.

## Development Commands

```bash
# Start all services
bun dev

# Start individual services
bun dev:web      # Web application (port 3001)
bun dev:server   # Server/bot

# Build applications
bun build

# Linting and formatting
bun check        # Run Biome with auto-fix
bun check-types  # Type check all applications

# Database operations
bun db:push      # Push schema changes
bun db:studio    # Open Prisma Studio
bun db:generate  # Generate Prisma client
bun db:migrate   # Run migrations

# Security operations (server)
cd apps/server
bun run migrate-cookies  # Encrypt existing cookies
bun test                 # Run tests
bun test --watch        # Run tests in watch mode
```

## Security Notes

- Generate secure random strings for `SECRET_KEY` (32+ characters) and `COOKIE_ENCRYPTION_KEY` (64+ characters)
  ```bash
  # Generate SECRET_KEY (32 characters)
  openssl rand -hex 16

  # Generate COOKIE_ENCRYPTION_KEY (64 characters)
  openssl rand -hex 32
  ```
- Use environment-specific encryption keys

## Support

For issues, questions, or contributions, please use the project's issue tracker.

## License

GPL-3.0, see LICENSE file