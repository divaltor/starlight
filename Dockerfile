FROM oven/bun:1 AS base

WORKDIR /code

ENV NODE_ENV=production
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true
ENV YOUTUBE_DL_SKIP_PYTHON_CHECK=true
ENV HOME=/root
ENV PATH="$HOME/.local/bin:$PATH"

COPY --from=linuxserver/ffmpeg /usr/local/bin/ffprobe /usr/bin/ffprobe
COPY --from=linuxserver/ffmpeg /usr/local/bin/ffmpeg /usr/bin/ffmpeg

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/

RUN uv tool install yt-dlp

COPY . /code/

RUN bun install

CMD ["bun", "start:backend"]