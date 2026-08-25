from typing import Final, Literal

from pydantic_settings import BaseSettings


class Config(BaseSettings):
    DEBUG: bool = False

    API_TOKEN: str

    ENABLE_EMBEDDINGS: bool = False
    ENABLE_CLASSIFICATION: bool = False
    ENABLE_TEXT_EMBEDDINGS: bool = False
    ENABLE_RERANKER: bool = False
    MODEL_DEVICE: Literal['auto', 'cpu', 'cuda'] = 'auto'

    # Memory-retrieval models served to Hindsight at pinned revisions.
    TEXT_EMBEDDING_MODEL: str = 'BAAI/bge-m3'
    TEXT_EMBEDDING_MODEL_REVISION: str = '5617a9f61b028005a4858fdac845db406aefb181'
    RERANKER_MODEL: str = 'BAAI/bge-reranker-v2-m3'
    RERANKER_MODEL_REVISION: str = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e'

    LOG_LEVEL: str = 'DEBUG'
    DISABLE_OPENAPI: bool = False
    OTEL_EXPORTER_OTLP_ENDPOINT: str | None = None

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


config: Final[Config] = Config()
