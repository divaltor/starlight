"""
Overview:
    Image tagging utilities for the Camie Tagger ONNX model.

Notes:
    - Only `general`, `character`, and `rating` categories are produced.
    - Category–specific thresholds are supported.
    - Overlapping / redundant tags can be removed via `drop_overlap_tags`.
    - Tags can be converted to underscore form via `underline`.
"""

from __future__ import annotations

import copy
import os
import pathlib
from collections import defaultdict
from collections.abc import Mapping
from typing import Any, BinaryIO, Union

import numpy as np
import orjson
import torch
from huggingface_hub import hf_hub_download
from PIL import Image

from app.imgutils.utils import open_onnx_model, ts_lru_cache

ImageTyping = Union[str, os.PathLike[str], bytes, bytearray, BinaryIO, Image.Image]

_REPO_ID = 'Camais03/camie-tagger-v2'


@ts_lru_cache()
def _get_overlap_tags() -> Mapping[str, list[str]]:
    json_file = hf_hub_download(
        'alea31415/tag_filtering',
        'overlap_tags_simplified.json',
        repo_type='dataset',
    )
    with pathlib.Path(json_file).open('rb') as file:
        data = orjson.loads(file.read())
    return data


def _get_metadata_file() -> Mapping[str, Any]:
    json_file = hf_hub_download(_REPO_ID, 'camie-tagger-v2-metadata.json', repo_type='model')
    with pathlib.Path(json_file).open('rb') as f:
        data = orjson.loads(f.read())
    return data


def drop_overlap_tags(
    tags: list[str] | Mapping[str, float],
) -> list[str] | Mapping[str, float]:
    overlap_tags_dict = _get_overlap_tags()
    result_tags: list[str] = []
    _origin_tags = copy.deepcopy(tags)
    if isinstance(tags, dict):
        tags = list(tags.keys())
    tags_underscore = [tag.replace(' ', '_') for tag in tags]

    for tag, tag_ in zip(tags, tags_underscore, strict=False):
        to_remove = False
        if tag_ in overlap_tags_dict:
            overlap_values = set(val for val in overlap_tags_dict[tag_])
            if overlap_values.intersection(set(tags_underscore)):
                to_remove = True
        for tag_another in tags:
            if tag in tag_another and tag != tag_another:
                to_remove = True
                break
        if not to_remove:
            result_tags.append(tag)

    if isinstance(_origin_tags, list):
        return result_tags
    if isinstance(_origin_tags, dict):
        _rtags_set = set(result_tags)
        return {key: value for key, value in _origin_tags.items() if key in _rtags_set}
    raise TypeError(f'Unknown tags type - {_origin_tags!r}.')  # pragma: no cover


_KAOMOJIS = [
    '0_0',
    '(o)_(o)',
    '+_+',
    '+_-',
    '._.',
    '<o>_<o>',
    '<|>_<|>',
    '=_=',
    '>_<',
    '3_3',
    '6_9',
    '>_o',
    '@_@',
    '^_^',
    'o_o',
    'u_u',
    'x_x',
    '|_|',
    '||_||',
]


def remove_underline(tag: str) -> str:
    tag = tag.strip()
    return tag.replace('_', ' ') if tag not in _KAOMOJIS else tag


def underline(tag: str) -> str:
    tag = tag.strip()
    return tag.replace(' ', '_') if tag not in _KAOMOJIS else tag


@ts_lru_cache()
def _get_camie_model():
    return open_onnx_model(
        hf_hub_download(
            repo_id=_REPO_ID,
            repo_type='model',
            filename='camie-tagger-v2.onnx',
        ),
    )


def _load_image(img: ImageTyping) -> Image.Image:
    if isinstance(img, Image.Image):
        return img
    if isinstance(img, (str, os.PathLike)):
        return Image.open(img)  # type: ignore[arg-type]
    if isinstance(img, (bytes, bytearray)):
        from io import BytesIO

        return Image.open(BytesIO(img))
    if hasattr(img, 'read'):
        return Image.open(img)  # type: ignore[arg-type]
    raise TypeError(f'Unsupported image type: {type(img)!r}')


def preprocess_image(pil_img: Image.Image, image_size: int = 512) -> torch.Tensor:
    from torchvision import transforms

    transform = transforms.Compose(
        [
            transforms.ToTensor(),
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ],
    )

    if pil_img.mode in ('RGBA', 'P'):
        pil_img = pil_img.convert('RGB')

    width, height = pil_img.size
    aspect_ratio = width / height
    if aspect_ratio > 1:
        new_width = image_size
        new_height = int(new_width / aspect_ratio)
    else:
        new_height = image_size
        new_width = int(new_height * aspect_ratio)

    pil_img = pil_img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    pad_color = (124, 116, 104)
    new_image = Image.new('RGB', (image_size, image_size), pad_color)
    paste_x = (image_size - new_width) // 2
    paste_y = (image_size - new_height) // 2
    new_image.paste(pil_img, (paste_x, paste_y))

    return transform(new_image)


def get_camie_tags(
    img: ImageTyping,
    *,
    general_threshold: float = 0.5,
    character_threshold: float = 0.8,
    top_k: int = 50,
    apply_drop_overlap: bool = True,
    use_underline: bool = False,
) -> dict[str, list[tuple[str, float]]]:
    """Generate tags for an image.

    Parameters:
        img: Image in any supported form (path, bytes, file-like, PIL image).
        general_threshold: Minimum probability for `general` tags.
        character_threshold: Minimum probability for `character` tags.
        rating_threshold: Minimum probability for `rating` tags.
        top_k: Max number of tags to keep per category after sorting by probability.
        apply_drop_overlap: If True applies `drop_overlap_tags` per category.
        use_underline: Return tags with underscores if True, else with spaces.

    Returns:
        Dictionary mapping category -> list of (tag, probability) pairs.
    """
    metadata = _get_metadata_file()
    dataset_info = metadata['dataset_info']
    tag_mapping = dataset_info['tag_mapping']
    idx_to_tag: dict[str, str] = tag_mapping['idx_to_tag']
    tag_to_category: dict[str, str] = tag_mapping['tag_to_category']

    session = _get_camie_model()

    pil_img = _load_image(img)
    img_tensor = preprocess_image(pil_img, image_size=metadata['model_info']['img_size'])
    img_numpy = img_tensor.unsqueeze(0).numpy()

    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: img_numpy})

    if len(outputs) >= 2:
        main_logits = outputs[1]
    else:
        main_logits = outputs[0]

    main_probs = 1.0 / (1.0 + np.exp(-main_logits))
    probs = main_probs[0]

    wanted_categories = {'general', 'character'}
    thresholds = {
        'general': general_threshold,
        'character': character_threshold,
    }

    tags_by_category: dict[str, list[tuple[str, float]]] = defaultdict(list)

    for idx in range(probs.shape[0]):
        prob = float(probs[idx])
        idx_str = str(idx)
        tag_name = idx_to_tag.get(idx_str)
        if not tag_name:
            continue
        category = tag_to_category.get(tag_name, 'general')
        if category not in wanted_categories:
            continue
        threshold = thresholds[category]
        if prob < threshold:
            continue
        tags_by_category[category].append((tag_name, prob))

    for category in list(tags_by_category.keys()):
        tags_by_category[category].sort(key=lambda x: x[1], reverse=True)
        if top_k > 0:
            tags_by_category[category] = tags_by_category[category][:top_k]

    if apply_drop_overlap:
        for category, pairs in list(tags_by_category.items()):
            mapping = {name: score for name, score in pairs}
            filtered_mapping = drop_overlap_tags(mapping)  # type: ignore[arg-type]
            filtered_pairs = sorted(filtered_mapping.items(), key=lambda x: x[1], reverse=True)
            tags_by_category[category] = filtered_pairs

    formatter = underline if use_underline else remove_underline
    for category, pairs in list(tags_by_category.items()):
        tags_by_category[category] = [(formatter(name), score) for name, score in pairs]

    return dict(tags_by_category)
