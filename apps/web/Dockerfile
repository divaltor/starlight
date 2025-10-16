FROM oven/bun:1.3 AS base

WORKDIR /code

ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

RUN bun install

COPY . .

RUN bun run build

bun run db:generate

CMD ["bun", "start"]
