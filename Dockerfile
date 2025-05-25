FROM python:3.13-slim-bookworm

ENV PYTHONPATH "${PYTHONPATH}:/code"
ENV PATH "/code:${PATH}"

ENV UV_SYSTEM_PYTHON=true
ENV UV_COMPILE_BYTECODE=true

WORKDIR /code

COPY --from=linuxserver/ffmpeg /usr/local/bin/ffprobe /usr/bin/ffprobe
COPY --from=linuxserver/ffmpeg /usr/local/bin/ffmpeg /usr/bin/ffmpeg

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/

COPY pyproject.toml uv.lock /code/

RUN uv sync

COPY . /code/

CMD ["uv", "run", "python", "-m", "app"]