from typing import Annotated, Any

import numpy as np
import structlog
from fastapi import APIRouter, Body, HTTPException
from huggingface_hub import hf_hub_download
from transformers import AutoConfig, AutoImageProcessor
from transformers.pipelines import pipeline

from app.imgutils.camie import get_camie_tags
from app.imgutils.utils import open_onnx_model
from app.models import ClassificationResult, ImageRequest
from app.otel import pipeline_span
from app.utils import preprocess_image, resolve_transformers_device

logger = structlog.get_logger()
transformers_device = resolve_transformers_device()

NSFW_MODEL_ID = 'spiele/nsfw_image_detector-ONNX'

processor = AutoImageProcessor.from_pretrained('spiele/nsfw_image_detector-ONNX')
nsfw_config = AutoConfig.from_pretrained(NSFW_MODEL_ID)
nsfw_session = open_onnx_model(
    hf_hub_download(repo_id=NSFW_MODEL_ID, filename='model_quantized.onnx', subfolder='onnx'),
)
nsfw_input_name = nsfw_session.get_inputs()[0].name
nsfw_output_name = nsfw_session.get_outputs()[0].name
aesthetic_pipe = pipeline(
    'image-classification',
    device=transformers_device,
    model='cafeai/cafe_aesthetic',
)
style_pipe = pipeline(
    'image-classification',
    device=transformers_device,
    model='cafeai/cafe_style',
)


router = APIRouter()


def classify_nsfw(image: Any) -> list[dict[str, str | float]]:
    pixel_values = processor(images=image, return_tensors='np')['pixel_values'].astype(np.float32)
    logits = nsfw_session.run([nsfw_output_name], {nsfw_input_name: pixel_values})[0][0]
    probabilities = np.exp(logits - np.max(logits))
    probabilities /= probabilities.sum()

    return sorted(
        [
            {
                'label': str(
                    nsfw_config.id2label.get(index, nsfw_config.id2label.get(str(index), index)),
                ),
                'score': float(score),
            }
            for index, score in enumerate(probabilities.tolist())
        ],
        key=lambda result: float(result['score']),
        reverse=True,
    )


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
            nsfw_outputs = classify_nsfw(img)

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
