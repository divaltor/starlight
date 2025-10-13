from typing import Annotated

import structlog
from fastapi import (
    APIRouter,
    Body,
    Depends,
    FastAPI,
    Header,
    HTTPException,
)
from imgutils.tagging import get_pixai_tags
from transformers import pipeline

from app.config import config
from app.logger import configure_logger
from app.models import (
    ClassificationResult,
    ImageRequest,
)
from app.otel import pipeline_span, setup_otel
from app.utils import preprocess_image

configure_logger()

app = FastAPI(
    title='Image Classification API',
    version='1.0.0',
    openapi_url=None if config.DISABLE_OPENAPI else '/openapi.json',
    docs_url=None if config.DISABLE_OPENAPI else '/docs',
    redoc_url=None if config.DISABLE_OPENAPI else '/redoc',
)
setup_otel(app)

logger = structlog.get_logger()


def verify_api_token(
    x_api_token: str = Header(..., alias='X-API-Token'),  # pyright: ignore[reportCallInDefaultInitializer]
) -> None:  # pragma: no cover - simple guard
    if x_api_token != config.API_TOKEN:
        raise HTTPException(status_code=401, detail='Invalid API token')


protected_router = APIRouter(dependencies=[Depends(verify_api_token)])

# Pipelines are instantiated at startup; adjust if lazy loading becomes necessary.
nsfw_pipe = pipeline(
    'image-classification',
    model='Freepik/nsfw_image_detector',
)
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


@protected_router.post('/classify')
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
    img = await preprocess_image(image.image.strip())

    try:
        with pipeline_span('nsfw_classification', 'Freepik/nsfw_image_detector'):
            nsfw_outputs = nsfw_pipe(img)

        with pipeline_span('aesthetic_classification', 'cafeai/cafe_aesthetic'):
            aestetic_outputs = aesthetic_pipe(img)

        with pipeline_span('style_classification', 'cafeai/cafe_style'):
            style_outputs = style_pipe(img)

        with pipeline_span('tag_generation', 'imgutils/pixai_tags'):
            general, character = get_pixai_tags(  # pyright: ignore[reportGeneralTypeIssues]
                img,
                thresholds={
                    'general': 0.5,
                    'character': 0.75,
                },
            )

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


app.include_router(protected_router)
