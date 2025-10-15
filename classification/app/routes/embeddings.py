import asyncio
from typing import TYPE_CHECKING, Annotated

import structlog
import torch
from fastapi import APIRouter, Body, HTTPException
from sentence_transformers import SentenceTransformer

from app.models import EmbeddingPayload, EmbeddingResponse
from app.otel import pipeline_span
from app.utils import preprocess_image

if TYPE_CHECKING:
    from numpy import ndarray

logger = structlog.get_logger()


embedding_model = SentenceTransformer(
    'jinaai/jina-clip-v2',
    trust_remote_code=True,
    truncate_dim=1024,
)

router = APIRouter()


@router.post('/embeddings')
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
