# syntax=docker/dockerfile:1

FROM reg.mini.dev/python:3.14-dev AS build

# Minimus python images default to non-root; apk needs root
USER root

# PyTorch ROCm runtime dependencies
RUN apk add --no-cache numactl

# HF cache dir, pre-created so the runtime stage can COPY --chown it
RUN mkdir -p /cache/huggingface

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

FROM reg.mini.dev/python:3.14 AS runtime

# Minimus images default to non-root (uid 1000, home /home/python).
# Deployment grants GPU device access via group_add (host render group) and
# mounts the HF cache volume at /cache/huggingface.
USER 1000

WORKDIR /code

ENV PATH="/code/.venv/bin:$PATH"
ENV HF_HOME="/cache/huggingface"
# /code is root-owned; as uid 1000 the app cannot write __pycache__
ENV PYTHONDONTWRITEBYTECODE=1

# Shared libraries PyTorch ROCm needs at runtime
COPY --from=build /usr/lib/libgomp.so.1 /usr/lib/libatomic.so.1 /usr/lib/libnuma.so.1 /usr/lib/

# Pre-owned by uid 1000 so named volumes initialize writable
COPY --chown=1000:1000 --from=build /cache /cache

COPY --from=build /code /code

COPY . /code

CMD ["/code/.venv/bin/granian", "--interface", "asgi", "--host", "0.0.0.0", "app.main:app"]
