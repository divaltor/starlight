FROM debian:bookworm-slim

ENV UV_COMPILE_BYTECODE=1
ENV PYTHON_GIL=0
ENV UV_PYTHON=3.14t
ENV UV_PYTHON_DOWNLOADS=auto
ENV PATH=/root/.cargo/bin:${PATH}

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /code

RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkg-config && rm -rf /var/lib/apt/lists/*
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain stable

COPY uv.lock pyproject.toml .python-version /code/

RUN uv sync --python 3.14t --all-groups --locked

COPY . /code

CMD ["uv", "run", "--python", "3.14t", "granian", "--interface", "asgi", "--host", "0.0.0.0", "app.main:app"]
