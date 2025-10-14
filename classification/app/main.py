import asyncio
from collections.abc import Callable, Coroutine
from time import perf_counter
from typing import Annotated, Any
from uuid import uuid4

import structlog
import torch
from fastapi import APIRouter, Body, Depends, FastAPI, Header, HTTPException, Request

# from llama_cpp import Llama
from opentelemetry import baggage, trace
from opentelemetry.context import attach, detach
from optimum.onnxruntime.modeling_ort import ORTModelForImageClassification
from starlette.responses import Response
from transformers import AutoModel, pipeline
from transformers.models.auto.image_processing_auto import AutoImageProcessor

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
from app.utils import l2norm, preprocess_image

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
    x_api_token: str = Header(..., alias='X-API-Token'),
) -> None:  # pragma: no cover - simple guard
    if config.DEBUG:
        return

    if x_api_token != config.API_TOKEN:
        raise HTTPException(status_code=401, detail='Invalid API token')


protected_router = APIRouter(dependencies=[Depends(verify_api_token)])

# Pipelines are instantiated at startup; adjust if lazy loading becomes necessary.

processor = AutoImageProcessor.from_pretrained('spiele/nsfw_image_detector-ONNX')

model = ORTModelForImageClassification.from_pretrained(
    'spiele/nsfw_image_detector-ONNX',
    file_name='model_quantized.onnx',
)

nsfw_pipe = pipeline(  # pyright: ignore[reportCallIssue]
    'image-classification',
    model=model,  # pyright: ignore[reportArgumentType]
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

model_name = 'BAAI/BGE-VL-large'
embedding_model = AutoModel.from_pretrained(model_name, trust_remote_code=True)

# Some remote code provides set_processor; guard if missing.
if hasattr(embedding_model, 'set_processor'):
    embedding_model.set_processor(model_name)

embedding_model.eval()

# caption_model = Llama.from_pretrained(
#     'unsloth/Qwen3-4B-Instruct-2507-GGUF',
#     filename='Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
#     n_ctx=4096,
#     n_gpu_layers=-1,  # auto-offload all layers to GPU if available
#     logits_all=False,
# )


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
    # Start preprocessing concurrently (e.g., network fetch / base64 decode)
    img_task = asyncio.create_task(preprocess_image(image.image.strip()))

    try:
        # Await the image only when first needed for model inference
        img = await img_task
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
                    'image': 'https://cdn.starlight.click/media/URDMgL5PlTWcwXxCqSuct3AC74vklEGmfQBSiLtkBwJhkKH0VHHyZdP.jpg',
                    'tags': ['mountains', 'sunrise'],
                    'style': {
                        'anime': 0.5,
                        'other': 0.5,
                        '3d': 0.5,
                        'real_life': 0.5,
                        'manga_like': 0.5,
                    },
                },
            ],
        ),
    ],
) -> EmbeddingResponse:
    try:
        with torch.no_grad():
            # Kick off image preprocessing early while encoding text
            img_task = asyncio.create_task(preprocess_image(payload.image.strip()))

            with pipeline_span('text_embedding', 'BAAI/BGE-VL-large'):
                emb_text: torch.Tensor = l2norm(
                    embedding_model.encode(text=payload.text),  # pyright: ignore[reportUnknownArgumentType]
                )

            img = await img_task

            with pipeline_span('image_embedding', 'BAAI/BGE-VL-large'):
                emb_image: torch.Tensor = l2norm(embedding_model.encode(images=img))  # pyright: ignore[reportUnknownArgumentType]

        return EmbeddingResponse(image=emb_image.tolist(), text=emb_text.tolist())  # pyright: ignore[reportUnknownArgumentType]
    except HTTPException:
        raise
    except Exception as e:  # pragma: no cover
        logger.exception('Embedding generation failed')
        raise HTTPException(status_code=500, detail=f'Embedding generation failed: {e}') from e


# @protected_router.post('/captionize')
# async def captionize(
#     payload: Annotated[
#         CaptionizePayload,
#         Body(
#             description='Generate a short natural caption (<=64 tokens) from tags and style scores.',
#             examples=[
#                 {
#                     'tags': ['mountain', 'sunrise', 'mist', 'valley'],
#                     'style': {
#                         'anime': 0.9,
#                         'other': 0.05,
#                         '3d': 0.01,
#                         'real_life': 0.02,
#                         'manga_like': 0.02,
#                     },
#                 },
#             ],
#         ),
#     ],
# ) -> CaptionResponse:
#     try:
#         with pipeline_span('caption_generation', 'unsloth/Qwen3-4B-Instruct-2507-GGUF'):
#             result = caption_model.create_chat_completion(
#                 messages=[{'role': 'user', 'content': payload.prompt}],
#                 max_tokens=77,
#                 temperature=0.0,
#                 top_p=0.8,
#                 min_p=0,
#                 top_k=20,
#                 presence_penalty=1,
#             )
#         return CaptionResponse(caption=result['choices'][0]['message']['content'])
#     except HTTPException:
#         raise
#     except Exception as e:  # pragma: no cover
#         logger.exception('Caption generation failed')
#         raise HTTPException(status_code=500, detail=f'Caption generation failed: {e}') from e


app.include_router(protected_router)
