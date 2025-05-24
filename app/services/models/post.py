from enum import StrEnum
from typing import Any, Self

from pydantic import AliasChoices, AliasPath, Field, field_validator

from app.services.models.base import BaseModel
from app.services.models.user import TwitterUser
from app.utils import find_key_recursive


class MediaType(StrEnum):
    PHOTO = 'photo'
    VIDEO = 'video'
    GIF = 'animated_gif'

    @property
    def is_photo(self) -> bool:
        return self == MediaType.PHOTO


class PostMedia(BaseModel):
    media_id: int = Field(alias='id_str')
    media_key: str = Field(alias='media_key')
    url: str = Field(alias='media_url_https')
    media_type: MediaType = Field(alias='type')

    @property
    def large_url(self) -> str:
        return f'{self.url}?format=jpg&name=large'

    @property
    def is_photo(self) -> bool:
        return self.media_type.is_photo


class TwitterPost(BaseModel):
    post_id: str = Field(validation_alias=AliasChoices('rest_id', 'entryId'))
    media: list[PostMedia] = Field(
        default_factory=list,
        validation_alias=AliasChoices(
            AliasPath('legacy', 'extended_entities', 'media'),
            AliasPath(''),
        ),
    )
    user: TwitterUser = Field(
        validation_alias=AliasPath('core', 'user_results', 'result'),
    )

    @field_validator('post_id', mode='before')
    def validate_post_id(cls, value: str) -> str:
        return value.removeprefix('tweet-')

    @property
    def url(self) -> str:
        return f'https://x.com/{self.user.username}/status/{self.post_id}'

    @classmethod
    def from_twitter_response(cls, data: Any) -> Self:
        first_post = find_key_recursive(data, 'entries')

        # Probably we already have flat object
        if first_post is None:
            return cls.model_validate(find_key_recursive(data, 'result'))

        return cls.model_validate(find_key_recursive(first_post, 'result'))
