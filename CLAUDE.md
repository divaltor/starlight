# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

This is a monorepo managed with Turbo and Bun:

- `bun dev` - Start all services in development mode
- `bun dev:web` - Start only the web application (port 3001)  
- `bun dev:server` - Start only the server/bot
- `bun build` - Build all applications
- `bun check` - Run Biome linter and formatter with auto-fix
- `bun check-types` - Type check all applications

Database operations (uses Prisma):
- `bun db:push` - Push schema changes to database
- `bun db:studio` - Open Prisma Studio
- `bun db:generate` - Generate Prisma client
- `bun db:migrate` - Run database migrations

Security operations (server app):
- `cd apps/server && bun run migrate-cookies` - Encrypt existing unencrypted cookies in Redis
- `cd apps/server && bun test` - Run cookie encryption tests
- `cd apps/server && bun test --watch` - Run tests in watch mode

## Architecture

**Starlight** is a Telegram bot system for collecting and managing Twitter content, consisting of:

### Server (`apps/server`)
- **Telegram Bot**: Built with Grammy.js framework for handling user interactions
- **Queue System**: Uses BullMQ with Redis for background job processing
  - `image-collector.ts` - Processes image collection jobs
  - `scrapper.ts` - Handles Twitter scraping jobs
- **Handlers**: Process different media types (image, video)
- **Services**: Business logic for image and video processing
- **Storage**: Redis integration for session management and job queues

### Web App (`apps/web`)
- **Framework**: TanStack Start (React-based meta-framework) with Vinxi
- **Routing**: TanStack Router with type-safe routing
- **State Management**: TanStack Query for server state
- **UI**: Radix UI components with Tailwind CSS
- **Database**: Prisma ORM with PostgreSQL

### Database Schema
Core entities:
- **Users**: Telegram user information with UUID primary keys
- **Tweets**: Stores tweet data as JSON with composite keys (id, userId)
- **Photos**: Media files with S3 storage paths and perceptual hashing

### Key Integration Points
- Bot communicates with users via Telegram API
- Background workers process Twitter content scraping
- Web interface provides dashboard for content management
- Shared database stores all user data and collected content
- Redis handles session state and job queues

The system uses tab indentation and double quotes (configured in Biome), and follows a microservices pattern with the bot and web app as separate deployable units.