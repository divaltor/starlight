# syntax=docker/dockerfile:1

FROM reg.mini.dev/bun:latest-dev AS base

WORKDIR /code

ENV NODE_ENV=production

# For Prisma and build dependencies
RUN apk add --no-cache openssl zlib

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

# Drop dev dependencies and build tooling from the runtime image
RUN rm -rf node_modules && bun install --production --ignore-scripts --filter web \
	&& rm -rf node_modules/vite node_modules/vitefu node_modules/esbuild node_modules/@esbuild \
		node_modules/rollup node_modules/postcss node_modules/nanoid node_modules/@babel \
		node_modules/typescript node_modules/@typescript \
		node_modules/@tanstack/start-plugin-core node_modules/@tanstack/router-plugin \
		node_modules/@tanstack/router-utils node_modules/@tanstack/router-generator \
		node_modules/tinyglobby node_modules/picomatch node_modules/diff \
		node_modules/xmlbuilder2 node_modules/js-yaml \
		node_modules/prisma node_modules/@prisma/dev node_modules/@prisma/studio-core \
		node_modules/@prisma/streams-local node_modules/prisma-json-types-generator \
		node_modules/@visx node_modules/ajv node_modules/fast-uri \
		node_modules/find-my-way node_modules/lodash \
		node_modules/lucide-react \
		bun.lock

FROM reg.mini.dev/bun:latest AS runtime

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
