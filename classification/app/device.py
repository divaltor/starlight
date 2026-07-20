from functools import cache
from typing import Literal

import structlog
import torch

from app.config import config

logger = structlog.get_logger()


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
