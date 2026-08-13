# syntax=docker/dockerfile:1

FROM reg.mini.dev/bun:latest-dev AS base

WORKDIR /code

ENV NODE_ENV=production

# For Prisma and build dependencies
RUN apk add --no-cache openssl zlib

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

RUN bun install

COPY . .

RUN bun run build

FROM reg.mini.dev/bun:latest AS runtime

WORKDIR /code

ENV NODE_ENV=production

# Shared libraries for Prisma client and native modules
COPY --from=base /usr/lib /usr/lib

COPY --from=base /code /code

CMD ["bun", "start:web"]
