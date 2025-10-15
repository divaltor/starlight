import asyncio
from collections.abc import Callable, Coroutine
from time import perf_counter
from typing import TYPE_CHECKING, Annotated, Any
from uuid import uuid4

import structlog
import torch
from fastapi import APIRouter, Body, Depends, FastAPI, Header, HTTPException, Request

# from llama_cpp import Llama
from opentelemetry import baggage, trace
from opentelemetry.context import attach, detach
from optimum.onnxruntime.modeling_ort import (
    ORTModelForImageClassification,
)
from sentence_transformers import SentenceTransformer
from starlette.responses import Response
from transformers.models.auto.image_processing_auto import AutoImageProcessor
from transformers.pipelines import pipeline

from app.config import config
from app.imgutils.camie import get_camie_tags
from app.logger import configure_logger
from app.models import (
    ClassificationResult,
    EmbeddingPayload,
    EmbeddingResponse,
    ImageRequest,
)
from app.otel import pipeline_span, setup_otel
from app.utils import preprocess_image

if TYPE_CHECKING:
    from numpy import ndarray

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
    # Obtain or generate a request id
    request_id = request.headers.get('X-Request-Id') or str(uuid4())

    # Attach request id to OTEL baggage & current span
    ctx = baggage.set_baggage('request.id', request_id)
    token = attach(ctx)
    span = trace.get_current_span()

    span.set_attribute('request.id', request_id)
    span.set_attribute('http.request_id', request_id)

    start = perf_counter()
    try:
        response = await call_next(request)
    finally:
        detach(token)

    duration_ms = (perf_counter() - start) * 1000

    # Echo back request id so clients can correlate
    response.headers['X-Request-Id'] = request_id

    logger.debug(
        'Request completed',
        method=request.method,
        path=str(request.url.path),
        status_code=response.status_code,
        duration_ms=duration_ms,
        request_id=request_id,
    )

    return response


def verify_api_token(
    x_api_token: str = Header(..., alias='X-API-Token'),  # pyright: ignore[reportCallInDefaultInitializer]
) -> None:  # pragma: no cover - simple guard
    if config.DEBUG:
        return

    if x_api_token != config.API_TOKEN:
        raise HTTPException(status_code=401, detail='Invalid API token')


protected_router = APIRouter(dependencies=[Depends(verify_api_token)])

processor = AutoImageProcessor.from_pretrained('spiele/nsfw_image_detector-ONNX')

nsfw_model = ORTModelForImageClassification.from_pretrained(
    'spiele/nsfw_image_detector-ONNX',
    file_name='model_quantized.onnx',
)

nsfw_pipe = pipeline(  # pyright: ignore[reportCallIssue]
    'image-classification',
    model=nsfw_model,  # pyright: ignore[reportArgumentType]
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

embedding_model = SentenceTransformer(
    'jinaai/jina-clip-v2',
    trust_remote_code=True,
    truncate_dim=1024,
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
    try:
        img = await preprocess_image(image.image)
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


@protected_router.post('/embeddings')
async def embeddings(
    payload: Annotated[
        EmbeddingPayload,
        Body(
            description='Create embedding for text or image. JSON {"type": "image|text", "data": "<url-or-base64>|<text>"}',
            examples=[
                {
                    'image': 'https://example.com/image.png',
                    'tags': ['mountains', 'sunrise'],
                },
            ],
        ),
    ],
) -> EmbeddingResponse:
    try:
        with torch.no_grad():
            # Kick off image preprocessing early while encoding text
            img_task = asyncio.create_task(preprocess_image(payload.image.strip()))

            with pipeline_span('text_embedding', 'jinaai/jina-clip-v2'):
                emb_text_vec: ndarray = embedding_model.encode(
                    [payload.text],
                    normalize_embeddings=True,
                )

            img = await img_task

            with pipeline_span('image_embedding', 'jinaai/jina-clip-v2'):
                emb_image: ndarray = embedding_model.encode([img], normalize_embeddings=True)  # pyright: ignore[reportCallIssue, reportArgumentType]

        return EmbeddingResponse(image=emb_image[0].tolist(), text=emb_text_vec[0].tolist())
    except HTTPException:
        raise
    except Exception as e:  # pragma: no cover
        logger.exception('Embedding generation failed')
        raise HTTPException(status_code=500, detail=f'Embedding generation failed: {e}') from e


app.include_router(protected_router)
