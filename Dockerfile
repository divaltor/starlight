FROM oven/bun:1 AS base

WORKDIR /code

ENV NODE_ENV=production

COPY --from=linuxserver/ffmpeg /usr/local/bin/ffprobe /usr/bin/ffprobe
COPY --from=linuxserver/ffmpeg /usr/local/bin/ffmpeg /usr/bin/ffmpeg

RUN apt-get update && apt-get install -y yt-dlp && rm -rf /var/lib/apt/lists/*

COPY . /code/

RUN bun install

CMD ["bun", "start:backend"]