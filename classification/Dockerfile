FROM python:3.13

ENV UV_SYSTEM_PYTHON=1
ENV UV_COMPILE_BYTECODE=1

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /code

COPY uv.lock pyproject.toml /code/

RUN uv sync

COPY . /code

CMD ["uv", "run", "granian", "--interface", "asgi", "--host", "0.0.0.0", "app.main:app"]