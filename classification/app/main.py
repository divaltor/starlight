from collections.abc import Callable, Coroutine
from time import perf_counter
from typing import Annotated, Any

import structlog
from fastapi import (
    APIRouter,
    Body,
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Request,
)
from optimum.onnxruntime.modeling_ort import ORTModelForImageClassification
from starlette.responses import Response
from transformers import pipeline
from transformers.models.auto.image_processing_auto import AutoImageProcessor

from app.config import config
from app.imgutils.camie import get_camie_tags
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


@app.middleware('http')
async def log_request_duration(
    request: Request,
    call_next: Callable[[Request], Coroutine[Any, Any, Response]],
) -> Response:
    start = perf_counter()
    response = await call_next(request)
    duration_ms = (perf_counter() - start) * 1000

    logger.debug(
        'Request completed',
        method=request.method,
        path=str(request.url.path),
        status_code=response.status_code,
        duration_ms=duration_ms,
    )

    return response


def verify_api_token(
    x_api_token: str = Header(..., alias='X-API-Token'),  # pyright: ignore[reportCallInDefaultInitializer]
) -> None:  # pragma: no cover - simple guard
    if x_api_token != config.API_TOKEN:
        raise HTTPException(status_code=401, detail='Invalid API token')


protected_router = APIRouter(dependencies=[Depends(verify_api_token)])

# Pipelines are instantiated at startup; adjust if lazy loading becomes necessary.

processor = AutoImageProcessor.from_pretrained('spiele/nsfw_image_detector-ONNX')

model = ORTModelForImageClassification.from_pretrained(
    'spiele/nsfw_image_detector-ONNX',
    file_name='model_quantized.onnx',
)

nsfw_pipe = pipeline(
    'image-classification',
    model=model,
    image_processor=processor,
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

        with pipeline_span('tag_generation', 'Camais03/camie-tagger-v2'):
            tags = get_camie_tags(img)

        return ClassificationResult.from_response(
            model_response={
                'cafe': {'aesthetic': aestetic_outputs, 'style': style_outputs},
                'nsfw': nsfw_outputs,
                'tags': tags,
            },
        )
    except Exception as e:  # pragma: no cover
        logger.exception('Model inference failed', error=e)
        raise HTTPException(status_code=500, detail=f'Model inference failed: {e}') from e


app.include_router(protected_router)
