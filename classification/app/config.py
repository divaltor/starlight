from typing import Final, Literal

from pydantic_settings import BaseSettings


class Config(BaseSettings):
    DEBUG: bool = False

    API_TOKEN: str

    ENABLE_EMBEDDINGS: bool = False
    ENABLE_CLASSIFICATION: bool = False
    MODEL_DEVICE: Literal['auto', 'cpu', 'cuda'] = 'auto'

    LOG_LEVEL: str = 'DEBUG'
    DISABLE_OPENAPI: bool = False

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


config: Final[Config] = Config()
