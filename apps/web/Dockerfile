# syntax=docker/dockerfile:1

FROM reg.mini.dev/bun:1.3.14-dev AS base

WORKDIR /code

ENV NODE_ENV=production

# For Prisma and build dependencies
RUN apk add --no-cache openssl=3.5.7-r0 zlib=1.3.2-r1

COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

RUN bun install

COPY . .

RUN bun run --cwd packages/utils db:generate && bun run --cwd apps/web build

# .output is self-contained: strip files that are never loaded under NODE_ENV=production
RUN find apps/web/.output/server/node_modules -name "*.development.js" -delete

# The Nitro output bundles and traces everything the server imports,
# so workspace installs and build caches are dead weight in the runtime image
RUN rm -rf node_modules bun.lock apps/*/node_modules packages/*/node_modules

FROM reg.mini.dev/bun:1.3.14 AS runtime

WORKDIR /code

ENV NODE_ENV=production

# Shared libraries for Prisma client and native modules
COPY --from=base /usr/lib /usr/lib

# No shell is needed at runtime; remove busybox to cut its CVEs
RUN sed -i '/^P:busybox$/,/^$/d' /lib/apk/db/installed && rm -f /bin/busybox /usr/sbin/sh

# The base entrypoint is a shell shim; the runtime CMD invokes bun directly
ENTRYPOINT []

COPY --from=base /code /code

CMD ["bun", "run", "--cwd", "apps/web", ".output/server/index.mjs"]
