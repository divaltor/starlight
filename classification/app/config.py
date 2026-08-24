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

    # Memory-retrieval models served to Hindsight. Revisions are pinned because
    # the reranker executes repository code (trust_remote_code=True).
    TEXT_EMBEDDING_MODEL: str = 'sergeyzh/BERTA'
    TEXT_EMBEDDING_MODEL_REVISION: str = '914c8c8aed14042ed890fc2c662d5e9e66b2faa7'
    RERANKER_MODEL: str = 'jinaai/jina-reranker-v2-base-multilingual'
    RERANKER_MODEL_REVISION: str = '9cfeff2df7d40d1b78e75e5e9cebec92a99813c9'

    LOG_LEVEL: str = 'DEBUG'
    DISABLE_OPENAPI: bool = False

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


config: Final[Config] = Config()
