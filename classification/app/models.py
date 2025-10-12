from abc import ABC
from typing import Any, Literal, Self, override

from pydantic import BaseModel, ConfigDict, Field, model_serializer


def transform_response(model_response: list[dict[str, Any]]) -> dict[str, float]:
    return {str(item['label']): float(item['score']) for item in model_response}


class ResponseModel(BaseModel, ABC):
    @classmethod
    def from_response(cls, model_response: Any) -> Self:  # pragma: no cover - abstract
        raise NotImplementedError


class ImageRequest(BaseModel):
    image: str


# NSFW scores -> {"normal": <score>, "nsfw": <score>}


class NSFWScores(BaseModel):
    neutral: float
    low: float
    medium: float
    high: float


class NSFWResult(ResponseModel):
    model: Literal['nsfw'] = Field(default='nsfw', exclude=True)
    scores: NSFWScores

    @model_serializer(mode='plain')
    def ser(self) -> dict[str, NSFWScores | bool]:
        return {'scores': self.scores, 'is_nsfw': self.is_nsfw}

    @property
    def is_nsfw(self) -> bool:
        return self.scores.high + self.scores.medium >= 0.5

    @override
    @classmethod
    def from_response(cls, model_response: Any) -> Self:
        # Accept mapping or list of {'label': ..., 'score': ...}
        score_map: dict[str, float] = transform_response(model_response)

        return cls.model_validate(
            {
                'scores': NSFWScores.model_validate(score_map),
            },
        )


# Aesthetic scores -> list or mapping with 'aesthetic' / 'not_aesthetic'


class AestheticScore(ResponseModel):
    aesthetic: float
    not_aesthetic: float

    @override
    @classmethod
    def from_response(cls, model_response: Any) -> Self:
        score_map: dict[str, float] = transform_response(model_response)

        return cls.model_validate(
            {
                'aesthetic': score_map['aesthetic'],
                'not_aesthetic': score_map['not_aesthetic'],
            },
        )


class StyleScore(ResponseModel):
    model_config = ConfigDict(populate_by_name=True)

    anime: float
    other: float
    third_dimension: float = Field(validation_alias='3d')
    real_life: float
    manga_like: float

    @override
    @classmethod
    def from_response(cls, model_response: Any) -> Self:
        score_map: dict[str, float] = transform_response(model_response)

        return cls.model_validate(
            {
                'anime': score_map['anime'],
                'other': score_map['other'],
                '3d': score_map['3d'],
                'real_life': score_map['real_life'],
                'manga_like': score_map['manga_like'],
            },
        )


class AestheticResult(ResponseModel):
    model: Literal['aesthetic'] = Field(default='aesthetic', exclude=True)
    aesthetic: AestheticScore
    style: StyleScore

    @model_serializer(mode='plain')
    def ser(self) -> dict[str, Any]:
        return {
            'aesthetic': self.aesthetic.aesthetic,
            'style': self.style.model_dump(by_alias=True),
        }

    @override
    @classmethod
    def from_response(cls, model_response: dict[str, Any]) -> Self:
        aesthetic_raw = model_response['aesthetic']

        style_raw = model_response['style']

        return cls.model_validate(
            {
                'aesthetic': AestheticScore.from_response(aesthetic_raw),
                'style': StyleScore.from_response(style_raw),
            },
        )


# Tags scores -> {"<tag>": <score>, ...}


class TagsResult(ResponseModel):
    model: Literal['tags'] = Field(default='tags', exclude=True)
    tags: list[str] = []

    @model_serializer(mode='plain')
    def ser(self) -> list[str]:
        return self.tags

    @override
    @classmethod
    def from_response(
        cls,
        model_response: Any,
    ) -> Self:  # Accept list[{'label','score'}] or mapping
        character = model_response['character']
        general = model_response['general']

        return cls.model_validate({'tags': [*list(character), *list(general)]})


class ClassificationResult(ResponseModel):
    aesthetic: float
    style: StyleScore
    nsfw: NSFWResult
    tags: TagsResult

    @override
    @classmethod
    def from_response(cls, model_response: Any) -> Self:
        aesthetic = AestheticResult.from_response(model_response['cafe'])

        return cls.model_validate(
            {
                'aesthetic': aesthetic.aesthetic.aesthetic,  # Don't comment that bullshit
                'style': aesthetic.style,
                'nsfw': NSFWResult.from_response(model_response['nsfw']),
                'tags': TagsResult.from_response(model_response['tags']),
            },
        )
