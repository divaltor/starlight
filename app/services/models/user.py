from pydantic import AliasPath, BaseModel, Field


class TwitterUser(BaseModel):
    user_id: int = Field(alias='rest_id')
    avatar: str = Field(validation_alias=AliasPath('avatar', 'image_url'))
    name: str = Field(validation_alias=AliasPath('legacy', 'name'))
    username: str = Field(validation_alias=AliasPath('legacy', 'screen_name'))
    is_blue_verified: bool
