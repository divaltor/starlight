import logging.config
from typing import Any

import structlog
from axiom_py.client import Client
from axiom_py.structlog import AxiomProcessor

from app.config import config

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

    if config.AXIOM_API_TOKEN:
        client = Client(config.AXIOM_API_TOKEN)
        # AxiomProcessor must run before wrap_for_formatter so it receives a dict
        base_processors.append(AxiomProcessor(client, config.AXIOM_DATASET))

    # wrap_for_formatter should be last; it converts event_dict for the formatter.
    base_processors.append(structlog.stdlib.ProcessorFormatter.wrap_for_formatter)

    structlog.configure(
        processors=base_processors,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
