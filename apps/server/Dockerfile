# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-alpine AS base

WORKDIR /code

ENV NODE_ENV=production
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=true

# For Prisma and the standalone yt-dlp download
RUN apk add --no-cache openssl=3.5.7-r0 zlib=1.3.2-r0 curl=8.14.1-r3

# yt-dlp ships self-contained binaries, so no Python runtime is needed
ARG TARGETARCH
RUN set -eux; \
	arch="${TARGETARCH:-$(uname -m)}"; \
	case "$arch" in \
		arm64|aarch64) ytdlp="yt-dlp_musllinux_aarch64" ;; \
		amd64|x86_64) ytdlp="yt-dlp_musllinux" ;; \
		*) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
	esac; \
	curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/$ytdlp" -o /usr/local/bin/yt-dlp; \
	chmod +x /usr/local/bin/yt-dlp

COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

# Ignore scripts to prevent installation of msgpackr-extract, can't compile it in docker somehow
RUN bun install --production --ignore-scripts --filter server

COPY . .

# Build tooling can leak back via peers; the runtime never uses it
RUN rm -rf node_modules/typescript node_modules/@typescript node_modules/@babel bun.lock

FROM mwader/static-ffmpeg:9.0 AS ffmpeg

FROM oven/bun:1.4.0-alpine AS runtime

WORKDIR /code

ENV NODE_ENV=production
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=true
ENV HOME=/root

# Shared libraries for Prisma engines and native modules
COPY --from=base /usr/lib /usr/lib

# Static ffmpeg/ffprobe; the image also carries the fontconfig config and fonts its filters use
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=ffmpeg /etc/fonts /etc/fonts
COPY --from=ffmpeg /usr/share/fonts /usr/share/fonts

COPY --from=base /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=base /code /code

CMD ["sh", "-c", "bun run --cwd packages/utils db:generate && bun run --cwd packages/utils db:deploy && bun run --cwd apps/server start"]
