from enum import StrEnum

from pydantic import AliasPath, BaseModel, Field, field_validator

from app.services.models.user import TwitterUser


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
    post_id: str = Field(alias='entryId')
    media: list[PostMedia] = Field(
        default_factory=list,
        validation_alias=AliasPath('legacy', 'extended_entities', 'media'),
    )
    user: TwitterUser = Field(
        validation_alias=AliasPath('core', 'user_results', 'result'),
    )

    @field_validator('post_id', mode='before')
    def validate_post_id(cls, value: str) -> str:
        if not value.startswith('tweet-'):
            raise ValueError('Invalid post ID')

        return value.removeprefix('tweet-')

    @property
    def url(self) -> str:
        return f'https://x.com/{self.user.username}/status/{self.post_id}'
