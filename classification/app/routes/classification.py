from typing import Annotated, Any

import structlog
import torch
from fastapi import APIRouter, Body, HTTPException, Request
from transformers import AutoImageProcessor, AutoModelForImageClassification
from transformers.pipelines import ImageClassificationPipeline, pipeline

from app.device import resolve_model_device
from app.imgutils.camie import get_camie_tags
from app.models import ClassificationResult, ImageRequest
from app.otel import pipeline_span
from app.utils import preprocess_image

logger = structlog.get_logger()
model_device = resolve_model_device()

NSFW_MODEL_ID = 'Freepik/nsfw_image_detector'
AESTHETIC_MODEL_ID = 'cafeai/cafe_aesthetic'
STYLE_MODEL_ID = 'cafeai/cafe_style'


def create_classification_pipeline(
    model_id: str,
    dtype: torch.dtype,
) -> ImageClassificationPipeline:
    image_processor = AutoImageProcessor.from_pretrained(model_id, use_fast=False)
    model = AutoModelForImageClassification.from_pretrained(model_id, torch_dtype=dtype)
    return pipeline(
        'image-classification',
        model=model,
        image_processor=image_processor,
        device=model_device,
    )


classification_dtype = torch.float16 if model_device == 'cuda' else torch.float32
# BF16 has the same 8-bit exponent as FP32, so downcasting the FP32 checkpoint is
# less likely to overflow or underflow intermediate activations than FP16's 5-bit
# exponent. This is preferable for threshold-sensitive NSFW scores, and costs no
# extra model memory over FP16 because both use 16 bits and run natively on ROCm.
nsfw_dtype = torch.bfloat16 if model_device == 'cuda' else torch.float32

nsfw_pipe = create_classification_pipeline(NSFW_MODEL_ID, nsfw_dtype)
aesthetic_pipe = create_classification_pipeline(AESTHETIC_MODEL_ID, classification_dtype)
style_pipe = create_classification_pipeline(STYLE_MODEL_ID, classification_dtype)


router = APIRouter()


def classify_nsfw(image: Any) -> list[dict[str, str | float]]:
    return nsfw_pipe(image)  # type: ignore[return-value]


@router.post('/classify')
async def classify(
    request: Request,
    image: Annotated[
        ImageRequest,
        Body(
            description='Image to classify. Provide JSON {"image": "<base64 or URL>"}',
            examples=[
                {'image': 'data:image/png;base64,iVBORw0KGgoAAA...'},
                {'image': 'https://example.com/image.png'},
            ],
        ),
    ],
) -> ClassificationResult:
    try:
        img = await preprocess_image(image.image, request.app.state.http_session)
        with pipeline_span('nsfw_classification', NSFW_MODEL_ID):
            nsfw_outputs = classify_nsfw(img)

        with pipeline_span('aesthetic_classification', AESTHETIC_MODEL_ID):
            aestetic_outputs = aesthetic_pipe(img)

        with pipeline_span('style_classification', STYLE_MODEL_ID):
            style_outputs = style_pipe(img)

        with pipeline_span('tag_generation', 'Camais03/camie-tagger-v2'):
            tags = get_camie_tags(img)

        return ClassificationResult.from_response(
            model_response={
                'cafe': {'aesthetic': aestetic_outputs, 'style': style_outputs},
                'nsfw': nsfw_outputs,
                'tags': tags,
            },
        )
    except Exception as e:  # pragma: no cover
        logger.exception('Model inference failed', error=e)
        raise HTTPException(status_code=500, detail=f'Model inference failed: {e}') from e
