FROM oven/bun:1.3-slim AS base

WORKDIR /code

ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

RUN bun x turbo prune web --docker

FROM base AS install

WORKDIR /code

COPY --from=base /code/out/full/ .

RUN bun install

COPY . .

RUN bun run db:generate

CMD ["bun", "start"]
