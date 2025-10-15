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


class AestheticScore(ResponseModel):
    aesthetic: float
    not_aesthetic: float


class EmbeddingResult(BaseModel):
    type: Literal['image', 'text']
    model: str
    embedding: list[float]


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

    @property
    def danboru_style(self) -> str | None:
        if self.anime > 0.8:
            return 'anime'
        if self.third_dimension > 0.8 or self.real_life > 0.8:
            return '3d'
        if self.manga_like > 0.8:
            return 'manga'

        return None


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
        aesthetic_raw = transform_response(model_response['aesthetic'])

        style_raw = transform_response(model_response['style'])

        return cls.model_validate(
            {
                'aesthetic': AestheticScore.model_validate(aesthetic_raw),
                'style': StyleScore.model_validate(style_raw),
            },
        )


# Camie tag scores schema -> mapping of category -> list[(tag, score)]


class CamieTags(ResponseModel):
    model: Literal['tags'] = Field(default='tags', exclude=True)
    tags: list[str] = Field(default_factory=list)

    @model_serializer(mode='plain')
    def ser(self) -> list[str]:
        return self.tags

    @override
    @classmethod
    def from_response(
        cls,
        model_response: Any,
    ) -> Self:  # Accept mapping category -> list[(tag, score)]
        general_pairs = model_response.get('general', [])
        character_pairs = model_response.get('character', [])

        general = [tag for tag, _ in general_pairs]
        character = [tag for tag, _ in character_pairs]

        return cls.model_validate({'tags': [*character, *general]})


class ClassificationResult(ResponseModel):
    aesthetic: float
    style: StyleScore
    nsfw: NSFWResult
    tags: CamieTags

    @override
    @classmethod
    def from_response(cls, model_response: Any) -> Self:
        print(model_response)
        aesthetic = AestheticResult.from_response(model_response['cafe'])

        return cls.model_validate(
            {
                'aesthetic': aesthetic.aesthetic.aesthetic,
                'style': aesthetic.style,
                'nsfw': NSFWResult.from_response(model_response['nsfw']),
                'tags': CamieTags.from_response(model_response['tags']),
            },
        )


class EmbeddingPayload(BaseModel):
    image: str

    tags: list[str] = []


class EmbeddingResponse(BaseModel):
    image: list[float]
    text: list[float]
