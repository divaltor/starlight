FROM oven/bun:1.3.1-slim AS base

WORKDIR /code

ENV NODE_ENV=production

# For Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

RUN bun install

COPY . .

RUN bun run build

CMD ["bun", "start:web"]
