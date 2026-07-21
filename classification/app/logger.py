import logging.config
from typing import Any, override

import structlog
from opentelemetry import trace

from app.config import config

_SUPPRESSED_TRANSFORMERS_ADVISORIES = (
    'You seem to be using the pipelines sequentially on GPU',
    'Using a slow image processor as `use_fast` is unset',
)


class SuppressTransformersAdvisories(logging.Filter):
    @override
    def filter(self, record: logging.LogRecord) -> bool:
        return not record.getMessage().startswith(_SUPPRESSED_TRANSFORMERS_ADVISORIES)


def add_open_telemetry_spans(_, __, event_dict: dict[str, Any]) -> dict[str, Any]:  # pyright: ignore[reportUnknownParameterType, reportMissingParameterType]
    span = trace.get_current_span()
    if not span.is_recording():
        event_dict['span'] = None
        return event_dict

    ctx = span.get_span_context()
    parent = getattr(span, 'parent', None)

    event_dict['span'] = {
        'span_id': format(ctx.span_id, '016x'),
        'trace_id': format(ctx.trace_id, '032x'),
        'parent_span_id': None if not parent else format(parent.span_id, '016x'),
    }

    return event_dict


timestamper = structlog.processors.TimeStamper(fmt='%Y-%m-%d %H:%M:%S')
pre_chain = [
    # Add the log level and a timestamp to the event_dict if the log entry
    # is not from structlog.
    structlog.stdlib.add_log_level,
    # Add extra attributes of LogRecord objects to the event dictionary
    # so that values passed in the extra parameter of log methods pass
    # through to log output.
    structlog.stdlib.ExtraAdder(),
    timestamper,
    add_open_telemetry_spans,
]


def extract_from_record(_, __, event_dict: dict[str, Any]) -> dict[str, Any]:  # pyright: ignore[reportUnknownParameterType, reportMissingParameterType]
    """Extract thread and process names and add them to the event dict."""
    record = event_dict['_record']
    event_dict['thread_name'] = record.threadName
    event_dict['process_name'] = record.processName
    return event_dict


logging.config.dictConfig(
    {
        'version': 1,
        'disable_existing_loggers': False,
        'filters': {
            'suppress_transformers_advisories': {
                '()': SuppressTransformersAdvisories,
            },
        },
        'formatters': {
            'colored': {
                '()': structlog.stdlib.ProcessorFormatter,
                'processors': [
                    extract_from_record,
                    structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                    structlog.dev.ConsoleRenderer(colors=True),
                ],
                'foreign_pre_chain': pre_chain,
            },
        },
        'handlers': {
            'default': {
                'level': config.LOG_LEVEL,
                'class': 'logging.StreamHandler',
                'formatter': 'colored',
                'filters': ['suppress_transformers_advisories'],
            },
        },
        'loggers': {
            '': {
                'handlers': ['default'],
                'level': 'WARNING',
                'propagate': True,
            },
            'app': {
                'handlers': ['default'],
                'level': config.LOG_LEVEL,
                'propagate': False,
            },
        },
    },
)


def configure_logger() -> None:
    base_processors = [
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        timestamper,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    # wrap_for_formatter should be last; it converts event_dict for the formatter.
    base_processors.append(structlog.stdlib.ProcessorFormatter.wrap_for_formatter)

    structlog.configure(
        processors=base_processors,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
