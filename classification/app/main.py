from collections.abc import Callable, Coroutine
from time import perf_counter
from typing import Any
from uuid import uuid4

import structlog
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from opentelemetry import baggage, trace
from opentelemetry.context import attach, detach
from starlette.responses import Response

from app.config import config
from app.logger import configure_logger
from app.otel import setup_otel

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


protected_router = APIRouter(prefix='/v1', dependencies=[Depends(verify_api_token)])


@app.get('/health')
def health() -> dict[str, str]:
    return {'status': 'ok'}


if config.ENABLE_CLASSIFICATION:
    from app.routes.classification import router as classification_router

    protected_router.include_router(classification_router)

if config.ENABLE_EMBEDDINGS:
    from app.routes.embeddings import router as embeddings_router

    protected_router.include_router(embeddings_router)

app.include_router(protected_router)
