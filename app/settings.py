import base64
import json
from enum import StrEnum
from typing import Final, cast

from pydantic import RedisDsn, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(StrEnum):
    PRODUCTION = 'prod'
    DEVELOPMENT = 'dev'


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    TOKEN: str

    REDIS_URI: RedisDsn

    ENVIRONMENT: Environment = Environment.DEVELOPMENT

    X_COOKIES: dict[str, str] | None = None
    ALLOWED_USER: int | None = None

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == Environment.PRODUCTION

    @field_validator('X_COOKIES', mode='before')
    def decode_base64(cls, value: str | None) -> dict[str, str] | None:
        if value is None:
            return None

        try:
            decoded = json.loads(base64.b64decode(value).decode())
        except Exception:  # noqa: BLE001
            decoded = json.loads(value)

        # Exported via extension `Cookie Quick Manager`
        if any(value.get('Host raw') for value in decoded):
            return {value['Name raw']: value['Content raw'] for value in decoded}

        # Just default cookies
        return cast('dict[str, str]', decoded)


settings: Final[Settings] = Settings()  # pyright: ignore[reportCallIssue]
