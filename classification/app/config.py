from typing import Final

from pydantic_settings import BaseSettings


class Config(BaseSettings):
    API_TOKEN: str

    LOG_LEVEL: str = 'DEBUG'

    class Config:
        env_file = '.env'
        env_file_encoding = 'utf-8'


config: Final[Config] = Config()
