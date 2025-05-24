from typing import Any, Self

from jsonpath_ng.ext import parse
from pydantic import AliasChoices, AliasPath, Field

from app.services.models.base import BaseModel
from app.utils import find_key_recursive

USER_ENTRY = parse('$..result')


class TwitterUser(BaseModel):
    user_id: int = Field(alias='rest_id')
    avatar: str = Field(
        validation_alias=AliasChoices(
            AliasPath('avatar', 'image_url'),
            AliasPath('legacy', 'profile_image_url_https'),
        ),
    )
    name: str = Field(validation_alias=AliasPath('legacy', 'name'))
    username: str = Field(validation_alias=AliasPath('legacy', 'screen_name'))
    is_blue_verified: bool

    @classmethod
    def from_twitter_response(cls, data: dict[str, Any]) -> Self:
        return cls.model_validate(find_key_recursive(data, 'result'))
