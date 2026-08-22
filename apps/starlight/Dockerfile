# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine

WORKDIR /code

ENV NODE_ENV=production

RUN apk add --no-cache openssl=3.5.7-r0 zlib=1.3.2-r0

COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/starlight/package.json ./apps/starlight/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

RUN bun install --production --ignore-scripts --filter @starlight/bot

COPY . .

RUN rm -rf node_modules/typescript node_modules/@typescript node_modules/@babel bun.lock

CMD ["sh", "-c", "bun run --cwd packages/utils db:generate && bun run --cwd packages/utils db:deploy && bun run --cwd apps/starlight start"]
