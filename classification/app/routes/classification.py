from typing import Annotated

import structlog
from fastapi import APIRouter, Body, HTTPException
from optimum.onnxruntime.modeling_ort import ORTModelForImageClassification
from transformers import AutoImageProcessor
from transformers.pipelines import pipeline

from app.imgutils.camie import get_camie_tags
from app.models import ClassificationResult, ImageRequest
from app.otel import pipeline_span
from app.utils import preprocess_image

logger = structlog.get_logger()

processor = AutoImageProcessor.from_pretrained('spiele/nsfw_image_detector-ONNX')

nsfw_model = ORTModelForImageClassification.from_pretrained(
    'spiele/nsfw_image_detector-ONNX',
    file_name='model_quantized.onnx',
)

nsfw_pipe = pipeline(  # pyright: ignore[reportCallIssue]
    'image-classification',
    model=nsfw_model,  # pyright: ignore[reportArgumentType]
    image_processor=processor,
)
aesthetic_pipe = pipeline(
    'image-classification',
    model='cafeai/cafe_aesthetic',
)
style_pipe = pipeline(
    'image-classification',
    model='cafeai/cafe_style',
)


router = APIRouter()


@router.post('/classify')
async def classify(
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
        img = await preprocess_image(image.image)
        with pipeline_span('nsfw_classification', 'Freepik/nsfw_image_detector'):
            nsfw_outputs = nsfw_pipe(img)

        with pipeline_span('aesthetic_classification', 'cafeai/cafe_aesthetic'):
            aestetic_outputs = aesthetic_pipe(img)

        with pipeline_span('style_classification', 'cafeai/cafe_style'):
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
