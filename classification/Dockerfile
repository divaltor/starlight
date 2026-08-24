# syntax=docker/dockerfile:1

FROM python:3.14-slim-trixie AS build

# Shared libraries PyTorch links at import time
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libatomic1 libnuma1 \
    && rm -rf /var/lib/apt/lists/*

# HF cache dir, pre-created so the runtime stage can COPY --chown it
RUN mkdir -p /cache/huggingface

ENV UV_NO_CACHE=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_PYTHON=/usr/local/bin/python3.14
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

FROM python:3.14-slim-trixie AS runtime

# Shared libraries PyTorch ROCm needs at runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libatomic1 libnuma1 \
    && rm -rf /var/lib/apt/lists/*

# Deployment grants GPU device access via group_add (host render group) and
# mounts the HF cache volume at /cache/huggingface; both expect uid/gid 1000
RUN useradd --uid 1000 --user-group --create-home app
USER 1000

WORKDIR /code

ENV PATH="/code/.venv/bin:$PATH"
ENV HF_HOME="/cache/huggingface"
# /code is root-owned; as uid 1000 the app cannot write __pycache__
ENV PYTHONDONTWRITEBYTECODE=1

# Pre-owned by uid 1000 so named volumes initialize writable
COPY --chown=1000:1000 --from=build /cache /cache

COPY --from=build /code /code

COPY . /code

CMD ["/code/.venv/bin/granian", "--interface", "asgi", "--host", "0.0.0.0", "app.main:app"]
