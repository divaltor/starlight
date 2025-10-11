FROM oven/bun:1.2 AS base

WORKDIR /code

ENV NODE_ENV=production

# To disable Prisma warnings
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

RUN bun install

COPY . .

# We depends on runtime generated code and types
RUN bun run db:generate

RUN bun run build

CMD ["bun", "start"]
