from enum import StrEnum
from typing import Final

from pydantic import RedisDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    PRODUCTION = 'prod'
    DEVELOPMENT = 'dev'


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    TOKEN: str
    OLD_USERNAME: str = 'BirderBot'

    REDIS_URI: RedisDsn

    ENVIRONMENT: Environment = Environment.DEVELOPMENT

    ALLOWED_USER: int | None = None

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == Environment.PRODUCTION


settings: Final[Settings] = Settings()  # pyright: ignore[reportCallIssue]
