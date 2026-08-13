# syntax=docker/dockerfile:1

FROM reg.mini.dev/bun:latest-dev AS base

WORKDIR /code

ENV NODE_ENV=production
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=true
ENV HOME=/root
ENV PATH="$HOME/.local/bin:$PATH"

# For Prisma, ffmpeg tooling and the yt-dlp Python runtime
RUN apk add --no-cache openssl ffmpeg zlib

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/

RUN uv tool install yt-dlp

COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json

# Ignore scripts to prevent installation of msgpackr-extract, can't compile it in docker somehow
RUN bun install --ignore-scripts

COPY . .

FROM reg.mini.dev/bun:latest AS runtime

WORKDIR /code

ENV NODE_ENV=production
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=true
ENV HOME=/root
ENV PATH="$HOME/.local/bin:$PATH"

# Shared libraries for Prisma engines, native modules, ffmpeg and yt-dlp's Python
COPY --from=base /usr/lib /usr/lib

# fontconfig configuration used by ffmpeg filters
COPY --from=base /etc/fonts /etc/fonts

COPY --from=base /usr/bin/ffmpeg /usr/bin/ffmpeg
COPY --from=base /usr/sbin/ffprobe /usr/bin/ffprobe
COPY --from=base /root/.local /root/.local
COPY --from=base /code /code

CMD ["bun", "start:server"]
