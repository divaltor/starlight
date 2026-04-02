from __future__ import annotations

import base64
import binascii
import io
from typing import TYPE_CHECKING

import structlog
from fastapi import HTTPException
from PIL import Image

from app.otel import pipeline_span

if TYPE_CHECKING:
    from niquests import AsyncSession
    from PIL.Image import Image as PILImage

logger = structlog.get_logger()


async def preprocess_image(image: str, session: AsyncSession) -> PILImage:
    with pipeline_span('preprocess_image'):
        match image.startswith(('http://', 'https://')):
            case True:
                headers = {'Accept-Encoding': 'gzip'}
                try:
                    response = await session.get(image, headers=headers, timeout=25)

                    if not response.ok:
                        raise HTTPException(
                            status_code=400,
                            detail=f'Failed to download image: HTTP {response.status_code}',
                        )

                    if response.content is None:
                        raise HTTPException(
                            status_code=400, detail='Failed to download image: empty body',
                        )

                    raw = response.content
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
