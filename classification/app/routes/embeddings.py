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
    try:
        # Always encode text
        with pipeline_span('text_embedding', 'jinaai/jina-clip-v2'):
            emb_text_vec: ndarray = embedding_model.encode(
                [payload.text],
                normalize_embeddings=True,
            )

        emb_image: ndarray | None = None

        if payload.image:
            with torch.no_grad():
                img = await preprocess_image(payload.image.strip())

                with pipeline_span('image_embedding', 'jinaai/jina-clip-v2'):
                    emb_image: ndarray = embedding_model.encode([img], normalize_embeddings=True)  # pyright: ignore[reportCallIssue, reportArgumentType]

        return EmbeddingResponse(
            image=emb_image[0].tolist() if emb_image is not None else None,
            text=emb_text_vec[0].tolist(),
        )
    except HTTPException:
        raise
    except Exception as e:  # pragma: no cover
        logger.exception('Embedding generation failed')
        raise HTTPException(status_code=500, detail=f'Embedding generation failed: {e}') from e
