from __future__ import annotations

import types
from typing import TYPE_CHECKING, Annotated, Any

import torch
from fastapi import APIRouter, Body, Request
from torch.nn import functional
from torchvision.transforms.functional import pil_to_tensor
from transformers import AutoModelForImageClassification

from app.config import config
from app.device import resolve_model_device, run_on_gpu, run_on_gpu_sync
from app.imgutils.pixai import PIXAI_MODEL_ID, TAGGER_VERSION, PixAITagger
from app.models import ClassificationResult, ImageRequest
from app.otel import pipeline_span
from app.utils import preprocess_image

if TYPE_CHECKING:
    from PIL.Image import Image

model_device = resolve_model_device()

NSFW_MODEL_ID = 'Freepik/nsfw_image_detector'
AESTHETIC_MODEL_ID = 'cafeai/cafe_aesthetic'
STYLE_MODEL_ID = 'cafeai/cafe_style'

_BEIT_SIZE = 384


def _cache_beit_relative_position_bias(model: Any) -> None:
    """Precompute static BEiT relative position bias on device.

    Upstream `BeitRelativePositionBias.forward` rebuilds `relative_position_index` on
    CPU and interpolates on every forward pass, causing 12 CPU->GPU syncs per model
    and preventing `torch.compile` / HIP graph capture.
    """
    window_size = (
        model.config.image_size // model.config.patch_size,
        model.config.image_size // model.config.patch_size,
    )
    with torch.no_grad():
        for layer in model.beit.encoder.layer:
            rpb = layer.attention.attention.relative_position_bias
            if rpb is None:
                continue
            cached = rpb(window_size).detach().clone()
            rpb.register_buffer('_cached_bias', cached, persistent=False)

            def _fast_rpb(
                self: Any,
                window_size: Any,  # ruff: ignore[unused-function-argument]
                interpolate_pos_encoding: bool = False,  # ruff: ignore[unused-function-argument]
                dim_size: Any = None,  # ruff: ignore[unused-function-argument]
            ) -> torch.Tensor:
                return self._cached_bias

            rpb.forward = types.MethodType(_fast_rpb, rpb)


def _load_classifier(
    model_id: str,
    dtype: torch.dtype,
    input_size: int,
    *,
    is_beit: bool = False,
) -> tuple[Any, dict[int, str]]:
    model = AutoModelForImageClassification.from_pretrained(model_id, torch_dtype=dtype)
    model = model.eval().to(model_device)
    if is_beit:
        _cache_beit_relative_position_bias(model)

    id2label = {int(k): str(v) for k, v in model.config.id2label.items()}
    if model_device == 'cuda':
        compiled = torch.compile(model, mode='reduce-overhead')

        def _warmup() -> None:
            sample = torch.zeros(1, 3, input_size, input_size, device=model_device, dtype=dtype)
            with torch.inference_mode():
                for _ in range(3):
                    torch.compiler.cudagraph_mark_step_begin()
                    compiled(sample)

        run_on_gpu_sync(_warmup)
        return compiled, id2label

    return model, id2label


classification_dtype = torch.float16 if model_device == 'cuda' else torch.float32
# BF16 has the same 8-bit exponent as FP32, so downcasting the FP32 checkpoint is
# less likely to overflow or underflow intermediate activations than FP16's 5-bit
# exponent. This is preferable for threshold-sensitive NSFW scores, and costs no
# extra model memory over FP16 because both use 16 bits and run natively on ROCm.
nsfw_dtype = torch.bfloat16 if model_device == 'cuda' else torch.float32

_nsfw_raw = AutoModelForImageClassification.from_pretrained(NSFW_MODEL_ID, torch_dtype=nsfw_dtype)
_nsfw_cfg = _nsfw_raw.config.pretrained_cfg
_NSFW_SIZE: int = int(_nsfw_cfg['input_size'][1])
_NSFW_MEAN = torch.tensor(_nsfw_cfg['mean'], device=model_device, dtype=torch.float32).view(
    1, 3, 1, 1,
)
_NSFW_STD = torch.tensor(_nsfw_cfg['std'], device=model_device, dtype=torch.float32).view(
    1, 3, 1, 1,
)
_nsfw_labels: dict[int, str] = {int(k): str(v) for k, v in _nsfw_raw.config.id2label.items()}
_nsfw_raw = _nsfw_raw.eval().to(model_device)
if model_device == 'cuda':
    nsfw_model: Any = torch.compile(_nsfw_raw, mode='reduce-overhead')

    def _warmup_nsfw() -> None:
        sample = torch.zeros(1, 3, _NSFW_SIZE, _NSFW_SIZE, device=model_device, dtype=nsfw_dtype)
        with torch.inference_mode():
            for _ in range(3):
                torch.compiler.cudagraph_mark_step_begin()
                nsfw_model(sample)

    run_on_gpu_sync(_warmup_nsfw)
else:
    nsfw_model = _nsfw_raw

aesthetic_model, _aesthetic_labels = _load_classifier(
    AESTHETIC_MODEL_ID,
    classification_dtype,
    _BEIT_SIZE,
    is_beit=True,
)
style_model, _style_labels = _load_classifier(
    STYLE_MODEL_ID,
    classification_dtype,
    _BEIT_SIZE,
    is_beit=True,
)
tagger = run_on_gpu_sync(PixAITagger, model_device)

router = APIRouter()


def _run_classifier(
    model: Any,
    pixel_values: torch.Tensor,
    id2label: dict[int, str],
) -> list[dict[str, str | float]]:
    with torch.inference_mode():
        if model_device == 'cuda':
            torch.compiler.cudagraph_mark_step_begin()
        probs = functional.softmax(model(pixel_values).logits.float(), dim=-1)[0].cpu().tolist()
    return [{'label': id2label[idx], 'score': float(score)} for idx, score in enumerate(probs)]


def _prepare_inputs(
    img: Image,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    # Single host->device upload shared across all classification (and optional embedding) models.
    with torch.inference_mode():
        raw = pil_to_tensor(img).to(model_device)[None].float().div_(255.0)
        nsfw_resized = functional.interpolate(
            raw,
            size=(_NSFW_SIZE, _NSFW_SIZE),
            mode='bicubic',
            antialias=True,
            align_corners=False,
        )
        nsfw_in = ((nsfw_resized - _NSFW_MEAN) / _NSFW_STD).to(nsfw_dtype)
        beit_in = (
            functional.interpolate(
                raw,
                size=(_BEIT_SIZE, _BEIT_SIZE),
                mode='bilinear',
                antialias=True,
                align_corners=False,
            )
            * 2.0
            - 1.0
        ).to(classification_dtype)
        pixai_in = tagger.preprocess_tensor(raw)
    return raw, nsfw_in, beit_in, pixai_in


def _classify_sync(img: Image, *, include_embeddings: bool = False) -> ClassificationResult:
    raw, nsfw_in, beit_in, pixai_in = _prepare_inputs(img)

    with pipeline_span('nsfw_classification', NSFW_MODEL_ID):
        nsfw_outputs = _run_classifier(nsfw_model, nsfw_in, _nsfw_labels)

    with pipeline_span('aesthetic_classification', AESTHETIC_MODEL_ID):
        aesthetic_outputs = _run_classifier(aesthetic_model, beit_in, _aesthetic_labels)

    with pipeline_span('style_classification', STYLE_MODEL_ID):
        style_outputs = _run_classifier(style_model, beit_in, _style_labels)

    with pipeline_span('tag_generation', PIXAI_MODEL_ID):
        tags = tagger.predict_pixel_values(pixai_in)

    result = ClassificationResult.from_response(
        model_response={
            'cafe': {'aesthetic': aesthetic_outputs, 'style': style_outputs},
            'nsfw': nsfw_outputs,
            'tags': tags,
            'tagger': TAGGER_VERSION,
        },
    )

    if include_embeddings and config.ENABLE_EMBEDDINGS:
        from app.routes.embeddings import encode_from_gpu_tensor

        tags_text = ', '.join([*result.characters, *result.tags])
        result.embeddings = encode_from_gpu_tensor(tags_text, raw)

    return result


@router.post('/classify', response_model_exclude_none=True)
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
    img = await preprocess_image(image.image, request.app.state.http_session)
    return await run_on_gpu(_classify_sync, img, include_embeddings=image.include_embeddings)
