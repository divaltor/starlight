import base64
import binascii
import io
from typing import Annotated

import aiohttp
import structlog
from fake_useragent import UserAgent
from fastapi import Body, FastAPI, HTTPException
from imgutils.tagging import get_pixai_tags
from PIL import Image
from transformers import pipeline

from app.logger import configure_logger
from app.models import (
    ClassificationResult,
    ImageRequest,
)

configure_logger()

app = FastAPI(title='Image Classification API', version='1.0.0')

logger = structlog.get_logger()

# Pipelines are instantiated at startup; adjust if lazy loading becomes necessary.
nsfw_pipe = pipeline('image-classification', model='Falconsai/nsfw_image_detection')
aesthetic_pipe = pipeline(
    'image-classification',
    model='cafeai/cafe_aesthetic',
)
style_pipe = pipeline(
    'image-classification',
    model='cafeai/cafe_style',
)


@app.get('/health')
def health() -> dict[str, str]:
    return {'status': 'ok'}


@app.post('/classify')
async def classify(
    image: Annotated[
        ImageRequest,
        Body(
            description='Image to classify. Provide JSON {"image": "<base64 or URL>"}',
            examples=[
                {'image': 'data:image/png;base64,iVBORw0KGgoAAA...'},
                {'image': 'https://example.com/image.png'},
            ],
        ),
    ],
) -> ClassificationResult:
    value = image.image.strip()
    raw: bytes

    match value.startswith(('http://', 'https://')):
        case True:
            ua = UserAgent()
            headers = {'User-Agent': ua.random, 'Accept-Encoding': 'gzip, br'}
            try:
                timeout = aiohttp.ClientTimeout(total=10)

                async with (
                    aiohttp.ClientSession(timeout=timeout, headers=headers) as session,
                    session.get(value) as resp,
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
                raw = base64.b64decode(value, validate=True)
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

    try:
        nsfw_outputs = nsfw_pipe(img)
        aestetic_outputs = aesthetic_pipe(img)
        style_outputs = style_pipe(img)
        general, character = get_pixai_tags(  # pyright: ignore[reportGeneralTypeIssues]
            img,
            thresholds={
                'general': 0.5,
                'character': 0.75,
            },
        )

        logger.debug('Aesthetic model output', output=aestetic_outputs)
        logger.debug('Style model output', output=style_outputs)
        logger.debug('Tags model output', general=general, character=character)

        return ClassificationResult.from_response(
            model_response={
                'cafe': {'aesthetic': aestetic_outputs, 'style': style_outputs},
                'nsfw': nsfw_outputs,
                'tags': {'general': general, 'character': character},
            },
        )
    except Exception as e:  # pragma: no cover
        logger.exception('Model inference failed', error=e)
        raise HTTPException(status_code=500, detail=f'Model inference failed: {e}') from e
