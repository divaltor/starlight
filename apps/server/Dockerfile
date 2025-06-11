FROM oven/bun:1 AS base

WORKDIR /code

ENV NODE_ENV=production
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=true
ENV HOME=/root
ENV PATH="$HOME/.local/bin:$PATH"

# To disable Prisma warnings
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY --from=linuxserver/ffmpeg /usr/local/bin/ffprobe /usr/bin/ffprobe
COPY --from=linuxserver/ffmpeg /usr/local/bin/ffmpeg /usr/bin/ffmpeg

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/

RUN uv tool install yt-dlp

COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/utils/package.json ./packages/utils/package.json

RUN bun install

COPY . .

# We depends on runtime generated code and types
RUN bun run db:generate

CMD ["bun", "dev:server"]
