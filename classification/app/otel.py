from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
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
            'Authorization': f'Bearer {config.API_TOKEN}',
            'X-Axiom-Dataset': config.AXIOM_DATASET,
        },
    )

    processor = BatchSpanProcessor(otlp_exporter)
    provider.add_span_processor(processor)


def setup_otel() -> None:
    trace.set_tracer_provider(provider)
