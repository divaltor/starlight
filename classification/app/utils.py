from __future__ import annotations

import base64
import binascii
import io
from typing import TYPE_CHECKING

import aiohttp
import structlog
from fake_useragent import UserAgent
from fastapi import HTTPException
from PIL import Image

from app.otel import pipeline_span

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage

logger = structlog.get_logger()


async def preprocess_image(image: str) -> PILImage:
    with pipeline_span('preprocess_image'):
        match image.startswith(('http://', 'https://')):
            case True:
                headers = {'Accept-Encoding': 'gzip, br'}
                try:
                    async with aiohttp.ClientSession(
                        timeout=aiohttp.ClientTimeout(total=25),
                    ) as session:
                        resp = await session.get(image, headers=headers)

                        if not resp.ok:
                            raise HTTPException(
                                status_code=400,
                                detail=f'Failed to download image: HTTP {resp.status}',
                            )

                        raw = await resp.read()
                except HTTPException:
                    raise
                except Exception as e:
                    logger.exception('Failed to download image %s', image)
                    raise HTTPException(
                        status_code=400,
                        detail=f'Failed to download image: {e}',
                    ) from e
            case False:
                try:
                    raw = base64.b64decode(image, validate=True)
                except (binascii.Error, ValueError) as e:  # pragma: no cover
                    raise HTTPException(status_code=400, detail=f'Invalid base64 input: {e}') from e
            case _:  # pyright: ignore[reportUnnecessaryComparison]
                raise HTTPException(  # pyright: ignore[reportUnreachable]
                    status_code=400,
                    detail='Invalid image data',
                )

        try:
            img = Image.open(io.BytesIO(raw))
            img = img.convert('RGB')
        except Exception as e:  # pragma: no cover
            raise HTTPException(status_code=400, detail=f'Invalid image data: {e}') from e

        return img
