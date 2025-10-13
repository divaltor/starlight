from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.threading import ThreadingInstrumentor
from opentelemetry.instrumentation.transformers import TransformersInstrumentor
from opentelemetry.instrumentation.urllib import URLLibInstrumentor
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from app.config import config

resource = Resource(
    attributes={
        SERVICE_NAME: 'starlight-classification',
    },
)

provider = TracerProvider(resource=resource)

if config.AXIOM_API_TOKEN:
    otlp_exporter = OTLPSpanExporter(
        endpoint=f'{config.AXIOM_BASE_URL}/v1/traces',
        headers={
            'Authorization': f'Bearer {config.AXIOM_API_TOKEN}',
            'X-Axiom-Dataset': config.AXIOM_DATASET,
        },
    )

    processor = BatchSpanProcessor(otlp_exporter)
    provider.add_span_processor(processor)


def setup_otel(app: FastAPI) -> None:
    FastAPIInstrumentor().instrument_app(app)
    ThreadingInstrumentor().instrument()
    TransformersInstrumentor().instrument()
    URLLibInstrumentor().instrument()
    trace.set_tracer_provider(provider)
