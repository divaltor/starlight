FROM oven/bun:1.3-slim AS builder

WORKDIR /code

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

RUN bun install

COPY . .

RUN bun run build

FROM oven/bun:1.3-slim AS runtime

WORKDIR /code

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json
COPY tsconfig.base.json ./tsconfig.base.json
COPY turbo.json ./turbo.json

RUN bun install

COPY --from=builder /code/apps/web/dist ./apps/web/dist
COPY --from=builder /code/apps/web/.output ./apps/web/.output
COPY --from=builder /code/packages ./packages

CMD ["bun", "start:web"]
