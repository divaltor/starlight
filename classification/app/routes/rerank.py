from typing import Any

import structlog
import torch
from fastapi import APIRouter
from sentence_transformers import CrossEncoder

from app.config import config
from app.device import resolve_model_device, run_on_gpu, run_on_gpu_sync
from app.models import CohereRerankRequest, CohereRerankResponse, CohereRerankResult
from app.otel import pipeline_span

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
if model_device == 'cuda':
    _reranker_inner: Any = reranker_model.model
    reranker_model.model = torch.compile(_reranker_inner, dynamic=True)

    def _warmup_reranker() -> None:
        with torch.inference_mode():
            reranker_model.rank(
                'warmup',
                ['warmup document one', 'warmup document two'],
                top_k=2,
                return_documents=False,
                batch_size=2,
                show_progress_bar=False,
            )

    run_on_gpu_sync(_warmup_reranker)

router = APIRouter(prefix='/rerank')

RANK_BATCH_SIZE = 32


def _rank_sync(query: str, documents: list[str], top_n: int) -> Any:
    with pipeline_span('rerank', config.RERANKER_MODEL), torch.inference_mode():
        return reranker_model.rank(
            query,
            documents,
            top_k=top_n,
            return_documents=False,
            batch_size=RANK_BATCH_SIZE,
            show_progress_bar=False,
        )


@router.post('')
async def rerank(payload: CohereRerankRequest) -> CohereRerankResponse:
    top_n = payload.top_n if payload.top_n is not None else len(payload.documents)
    ranked = await run_on_gpu(_rank_sync, payload.query, payload.documents, top_n)

    return CohereRerankResponse(
        results=[
            # rank() returns corpus_id/score pairs sorted by descending score.
            CohereRerankResult(index=int(item['corpus_id']), relevance_score=float(item['score']))
            for item in ranked
        ],
    )
