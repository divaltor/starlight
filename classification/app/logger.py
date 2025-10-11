import logging.config
from typing import Any

import structlog

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
            'plain': {
                '()': structlog.stdlib.ProcessorFormatter,
                'processors': [
                    structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                    structlog.dev.ConsoleRenderer(colors=False),
                ],
                'foreign_pre_chain': pre_chain,
            },
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
    structlog.configure(
        processors=[
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            timestamper,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
