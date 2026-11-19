from __future__ import annotations

import asyncio
import contextvars
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from typing import TYPE_CHECKING, Literal

import structlog
import torch

from app.config import config

if TYPE_CHECKING:
    from collections.abc import Callable

logger = structlog.get_logger()

# Single dedicated GPU worker thread: serializes GPU work across all routes while
# keeping every torch.compile / cudagraph_trees TLS / HIP graph capture & replay
# pinned to one OS thread (AnyIO's threadpool rotates threads and breaks TLS).
_gpu_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='gpu-worker')


def run_on_gpu_sync[T](fn: Callable[..., T], *args: object, **kwargs: object) -> T:
    ctx = contextvars.copy_context()
    return _gpu_executor.submit(lambda: ctx.run(fn, *args, **kwargs)).result()


async def run_on_gpu[T](fn: Callable[..., T], *args: object, **kwargs: object) -> T:
    loop = asyncio.get_running_loop()
    ctx = contextvars.copy_context()
    return await loop.run_in_executor(_gpu_executor, lambda: ctx.run(fn, *args, **kwargs))


@cache
def resolve_model_device() -> Literal['cpu', 'cuda']:
    cuda_available = torch.cuda.is_available()
    if config.MODEL_DEVICE == 'cuda' and not cuda_available:
        raise RuntimeError('MODEL_DEVICE=cuda, but ROCm/CUDA is unavailable')

    device: Literal['cpu', 'cuda']
    if config.MODEL_DEVICE == 'auto':
        device = 'cuda' if cuda_available else 'cpu'
    else:
        device = config.MODEL_DEVICE

    logger.info(
        'Using model device %s (torch=%s, hip=%s)',
        device,
        torch.__version__,
        torch.version.hip,
    )
    return device
