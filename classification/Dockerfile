FROM ubuntu:26.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        ca-certificates \
        libatomic1 \
        libgomp1 \
        libnuma1 \
        python3.14 \
        python3.14-venv \
    && rm -rf /var/lib/apt/lists/*

ENV UV_NO_CACHE=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_PYTHON=/usr/bin/python3.14
ENV PATH="/code/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.11.29 /uv /bin/uv

WORKDIR /code

COPY uv.lock pyproject.toml /code/

RUN uv sync \
    --frozen \
    --no-default-groups \
    --group otel \
    --no-install-package torch \
    --no-install-package torchvision

RUN uv pip install \
    --python /code/.venv/bin/python \
    --default-index https://repo.amd.com/rocm/whl-multi-arch/ \
    'torch[device-gfx1150]==2.11.0+rocm7.14.0' \
    'torchvision[device-gfx1150]==0.26.0+rocm7.14.0' \
    && uv pip check --python /code/.venv/bin/python \
    && uv run --no-sync python -c \
        "import torch, torchvision; assert torch.version.hip; print(torch.__version__, torchvision.__version__, torch.version.hip)"

COPY . /code

CMD ["uv", "run", "--no-sync", "granian", "--interface", "asgi", "--host", "0.0.0.0", "app.main:app"]
