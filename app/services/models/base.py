from typing import Any, Self

from pydantic import BaseModel as PydanticBaseModel


class BaseModel(PydanticBaseModel):
    @classmethod
    def from_twitter_response(cls, data: Any) -> Self:
        return cls.model_validate(data)
