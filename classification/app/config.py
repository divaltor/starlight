from typing import Final

from pydantic_settings import BaseSettings


class Config(BaseSettings):
    DEBUG: bool = False

    API_TOKEN: str

    AXIOM_API_TOKEN: str | None = None
    AXIOM_DATASET: str = 'starlight'
    AXIOM_BASE_URL: str = 'https://api.axiom.co'

    LOG_LEVEL: str = 'DEBUG'
    DISABLE_OPENAPI: bool = False

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


config: Final[Config] = Config()
