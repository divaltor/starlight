import threading

import structlog
import torch
from fastapi import APIRouter
from sentence_transformers import CrossEncoder

from app.config import config
from app.device import resolve_model_device
from app.models import CohereRerankRequest, CohereRerankResponse, CohereRerankResult

logger = structlog.get_logger()
model_device = resolve_model_device()
model_dtype = torch.float16 if model_device == 'cuda' else torch.float32

reranker_model = CrossEncoder(
    config.RERANKER_MODEL,
    revision=config.RERANKER_MODEL_REVISION,
    device=model_device,
    max_length=1024,
    model_kwargs={'torch_dtype': model_dtype},
)
reranker_lock = threading.Lock()

router = APIRouter(prefix='/rerank')

RANK_BATCH_SIZE = 16


@router.post('')
def rerank(payload: CohereRerankRequest) -> CohereRerankResponse:
    top_n = payload.top_n if payload.top_n is not None else len(payload.documents)

    with reranker_lock:
        ranked = reranker_model.rank(
            payload.query,
            payload.documents,
            top_k=top_n,
            return_documents=False,
            batch_size=RANK_BATCH_SIZE,
            show_progress_bar=False,
        )

    return CohereRerankResponse(
        results=[
            # rank() returns corpus_id/score pairs sorted by descending score.
            CohereRerankResult(index=int(item['corpus_id']), relevance_score=float(item['score']))
            for item in ranked
        ],
    )
