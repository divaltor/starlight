import base64
import struct
import threading

import structlog
import torch
from fastapi import APIRouter, HTTPException
from sentence_transformers import SentenceTransformer

from app.config import config
from app.device import resolve_model_device
from app.models import (
    OpenAIEmbeddingData,
    OpenAIEmbeddingRequest,
    OpenAIEmbeddingResponse,
    OpenAIEmbeddingUsage,
)
from app.otel import pipeline_span

logger = structlog.get_logger()
model_device = resolve_model_device()
model_dtype = torch.float16 if model_device == 'cuda' else torch.float32

text_embedding_model = SentenceTransformer(
    config.TEXT_EMBEDDING_MODEL,
    revision=config.TEXT_EMBEDDING_MODEL_REVISION,
    device=model_device,
    model_kwargs={'torch_dtype': model_dtype},
)
text_embedding_lock = threading.Lock()

router = APIRouter(prefix='/openai')


@router.post('/embeddings')
def create_text_embeddings(payload: OpenAIEmbeddingRequest) -> OpenAIEmbeddingResponse:
    inputs = [payload.input] if isinstance(payload.input, str) else payload.input

    expected_dimensions = text_embedding_model.get_sentence_embedding_dimension()
    if payload.dimensions not in {None, expected_dimensions}:
        raise HTTPException(
            status_code=422,
            detail=f'unsupported dimensions {payload.dimensions}, model serves {expected_dimensions}',
        )

    with pipeline_span('text_embedding', config.TEXT_EMBEDDING_MODEL), text_embedding_lock:
        vectors = text_embedding_model.encode(
            inputs,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )

    data = [
        OpenAIEmbeddingData(
            object='embedding',
            index=index,
            embedding=encode_vector(vector)
            if payload.encoding_format == 'base64'
            else vector.tolist(),
        )
        for index, vector in enumerate(vectors)
    ]

    return OpenAIEmbeddingResponse(
        object='list',
        data=data,
        model=payload.model,
        usage=count_tokens(inputs),
    )


def encode_vector(vector: torch.Tensor) -> str:
    # OpenAI base64 format is little-endian float32.
    return base64.b64encode(struct.pack(f'<{len(vector)}f', *vector.tolist())).decode('ascii')


def count_tokens(texts: list[str]) -> OpenAIEmbeddingUsage:
    tokenizer = text_embedding_model.tokenizer
    encoded = tokenizer(texts, truncation=True, max_length=text_embedding_model.max_seq_length)
    prompt_tokens = sum(len(ids) for ids in encoded['input_ids'])

    return OpenAIEmbeddingUsage(prompt_tokens=prompt_tokens, total_tokens=prompt_tokens)
