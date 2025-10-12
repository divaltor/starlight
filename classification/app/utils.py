from __future__ import annotations

import base64
import binascii
import io
from typing import TYPE_CHECKING

import aiohttp
from fake_useragent import UserAgent
from fastapi import HTTPException
from PIL import Image

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage


async def preprocess_image(image: str) -> PILImage:
    match image.startswith(('http://', 'https://')):
        case True:
            ua = UserAgent()
            headers = {'User-Agent': ua.random, 'Accept-Encoding': 'gzip, br'}
            try:
                timeout = aiohttp.ClientTimeout(total=10)

                async with (
                    aiohttp.ClientSession(timeout=timeout, headers=headers) as session,
                    session.get(image) as resp,
                ):
                    if not resp.ok:
                        raise HTTPException(
                            status_code=400,
                            detail=f'Failed to download image: HTTP {resp.status}',
                        )

                    content_type = resp.headers.get('Content-Type', '')

                    if not content_type.startswith('image/'):
                        raise HTTPException(
                            status_code=400,
                            detail='URL does not point to an image',
                        )
                    raw = await resp.read()
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=400, detail=f'Failed to download image: {e}') from e
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
