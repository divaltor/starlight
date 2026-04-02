FROM rocm/pytorch:rocm7.2.1_ubuntu24.04_py3.12_pytorch_release_2.9.1 AS runtime-rocm

ENV UV_SYSTEM_PYTHON=1
ENV UV_NO_CACHE=1
ENV UV_COMPILE_BYTECODE=1

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /code

COPY uv.lock pyproject.toml /code/

RUN uv sync --all-groups --frozen --inexact --no-install-project --no-install-package torch --no-install-package torchvision

COPY . /code

RUN uv sync --all-groups --frozen --inexact --no-install-package torch --no-install-package torchvision

CMD ["uv", "run", "granian", "--interface", "asgi", "--host", "0.0.0.0", "app.main:app"]


FROM python:3.14 AS runtime

ENV UV_SYSTEM_PYTHON=1
ENV UV_NO_CACHE=1
ENV UV_COMPILE_BYTECODE=1

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /code

COPY uv.lock pyproject.toml /code/

RUN uv sync --all-groups --frozen --no-install-project

COPY . /code

RUN uv sync --all-groups --frozen

CMD ["uv", "run", "granian", "--interface", "asgi", "--host", "0.0.0.0", "app.main:app"]
