from typing import TYPE_CHECKING, Annotated

import torch
from fastapi import APIRouter, Body, Request
from sentence_transformers import SentenceTransformer

from app.device import resolve_model_device
from app.models import EmbeddingPayload, EmbeddingResponse
from app.otel import pipeline_span
from app.utils import preprocess_image

if TYPE_CHECKING:
    from numpy import ndarray

model_device = resolve_model_device()


embedding_model = SentenceTransformer(
    'jinaai/jina-clip-v2',
    trust_remote_code=True,
    truncate_dim=1024,
    device=model_device,
    config_kwargs={
        'use_text_flash_attn': False,
        'use_vision_xformers': False,
    },
)

router = APIRouter()


@router.post('/embeddings')
async def embeddings(
    request: Request,
    payload: Annotated[
        EmbeddingPayload,
        Body(
            description='Create embedding for text or image. JSON {"image": "<url-or-base64>", "tags": ["tag1", "tag2"]}',
            examples=[
                {
                    'image': 'https://example.com/image.png',
                    'tags': ['mountains', 'sunrise'],
                },
            ],
        ),
    ],
) -> EmbeddingResponse:
    with pipeline_span('text_embedding', 'jinaai/jina-clip-v2', payload.encoding_mode):
        emb_text_vec: ndarray = embedding_model.encode(
            [payload.text],
            prompt_name=payload.encoding_mode.value,
            normalize_embeddings=True,
        )

    emb_image: ndarray | None = None

    if payload.image:
        with torch.no_grad():
            img = await preprocess_image(payload.image.strip(), request.app.state.http_session)

            with pipeline_span('image_embedding', 'jinaai/jina-clip-v2', payload.encoding_mode):
                emb_image = embedding_model.encode(  # ty: ignore[no-matching-overload]
                    [img],
                    prompt_name=payload.encoding_mode.value,
                    normalize_embeddings=True,
                )

    return EmbeddingResponse(
        image=emb_image[0].tolist() if emb_image is not None else None,
        text=emb_text_vec[0].tolist(),
    )
