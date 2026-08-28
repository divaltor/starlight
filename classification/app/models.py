from abc import ABC
from enum import StrEnum
from typing import Annotated, Any, Literal, Self, override

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StringConstraints,
    model_serializer,
    model_validator,
)


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
    characters: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

    @model_serializer(mode='plain')
    def ser(self) -> dict[str, list[str]]:
        return {
            'characters': self.characters,
            'tags': self.tags,
        }

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

        return cls.model_validate({'characters': character, 'tags': general})


class ClassificationResult(ResponseModel):
    aesthetic: float
    style: StyleScore
    nsfw: NSFWResult
    characters: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)

    @override
    @classmethod
    def from_response(cls, model_response: Any) -> Self:
        aesthetic = AestheticResult.from_response(model_response['cafe'])
        tag_groups = CamieTags.from_response(model_response['tags'])

        return cls.model_validate(
            {
                'aesthetic': aesthetic.aesthetic.aesthetic,
                'style': aesthetic.style,
                'nsfw': NSFWResult.from_response(model_response['nsfw']),
                'characters': tag_groups.characters,
                'tags': tag_groups.tags,
            },
        )


class EncodingMode(StrEnum):
    DOCUMENT = 'document'
    QUERY = 'retrieval.query'


# Wire-contract limits for the memory-model endpoints; enforced by Pydantic so
# routes only handle checks that depend on loaded-model state.
MAX_EMBEDDING_INPUTS = 64
MAX_TEXT_CHARS = 16_000
MAX_DOCUMENTS = 100
MAX_QUERY_CHARS = 4_000
MAX_DOCUMENT_CHARS = 16_000


def _require_content(value: str) -> str:
    if not value.strip():
        raise ValueError('must contain non-whitespace characters')

    return value


MemoryText = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_TEXT_CHARS),
    AfterValidator(_require_content),
]
QueryText = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_QUERY_CHARS),
    AfterValidator(_require_content),
]
DocumentText = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_DOCUMENT_CHARS),
    AfterValidator(_require_content),
]
EmbeddingInputs = Annotated[list[MemoryText], Field(min_length=1, max_length=MAX_EMBEDDING_INPUTS)]
Documents = Annotated[list[DocumentText], Field(min_length=1, max_length=MAX_DOCUMENTS)]


class OpenAIEmbeddingRequest(BaseModel):
    model: str = Field(min_length=1)
    input: MemoryText | EmbeddingInputs
    dimensions: StrictInt | None = None
    encoding_format: Literal['float', 'base64'] | None = None


class OpenAIEmbeddingData(BaseModel):
    object: Literal['embedding']
    index: int
    embedding: list[float] | str


class OpenAIEmbeddingUsage(BaseModel):
    prompt_tokens: int
    total_tokens: int


class OpenAIEmbeddingResponse(BaseModel):
    object: Literal['list']
    data: list[OpenAIEmbeddingData]
    model: str
    usage: OpenAIEmbeddingUsage


class CohereRerankRequest(BaseModel):
    model: str | None = None
    query: QueryText
    documents: Documents
    top_n: StrictInt | None = None
    return_documents: Literal[False] | None = None

    @model_validator(mode='after')
    def _check_top_n(self) -> Self:
        if self.top_n is not None and not 1 <= self.top_n <= len(self.documents):
            raise ValueError(f'top_n must be between 1 and {len(self.documents)}')

        return self


class CohereRerankResult(BaseModel):
    index: int
    relevance_score: float


class CohereRerankResponse(BaseModel):
    results: list[CohereRerankResult]


class EmbeddingPayload(BaseModel):
    image: str | None = None

    tags: list[str] | str = Field(default_factory=list)

    encoding_mode: EncodingMode = EncodingMode.DOCUMENT

    @property
    def text(self) -> str:
        if isinstance(self.tags, str):
            return self.tags

        return ', '.join(self.tags)


class EmbeddingResponse(BaseModel):
    image: list[float] | None = None
    text: list[float]
