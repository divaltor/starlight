"""Image tagging with PixAI Tagger v1.0 (https://huggingface.co/pixai-labs/pixai-tagger-v1.0)."""

from __future__ import annotations

import json
import re
import types
from operator import itemgetter
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import torch
from huggingface_hub import hf_hub_download
from torchvision.transforms.functional import pil_to_tensor
from transformers import AutoModel

if TYPE_CHECKING:
    from PIL.Image import Image

PIXAI_MODEL_ID = 'pixai-labs/pixai-tagger-v1.0'
REVISION = '9fe10addf9326e292da8a85a98ea74cd91b41771'
CATEGORIES = ('general', 'character')
TOP_K = 50
# Stored with each classification; bump when tags change so the backfill re-enqueues photos.
TAGGER_VERSION = 'pixai-v1.0'
_QUALIFIED_TAG = re.compile(r'(.+?)((?:_\([^()]+\))+)')
_QUALIFIER = re.compile(r'_\([^()]+\)')

_KAOMOJIS = frozenset(
    {
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
    },
)


class PixAITagger:
    def __init__(self, device: Literal['cpu', 'cuda']) -> None:
        self.device = device
        self.dtype = torch.bfloat16 if device == 'cuda' else torch.float32
        # Load directly in the target dtype: a later `.to(dtype)` also casts the complex
        # RoPE buffers and silently changes predictions.
        model = AutoModel.from_pretrained(
            PIXAI_MODEL_ID,
            revision=REVISION,
            trust_remote_code=True,
            torch_dtype=self.dtype,
        )
        for block in model.blocks:
            attn = block.attn
            attn.register_buffer('rope_cos', attn.freqs_cis.real.float(), persistent=False)
            attn.register_buffer('rope_sin', attn.freqs_cis.imag.float(), persistent=False)
            attn._apply_rope = types.MethodType(_apply_real_rope, attn)  # ruff: ignore[private-member-access]
        model = model.eval().to(device)
        # On the Radeon 890M, compiling cuts the forward pass from 0.91 s to 0.80 s.
        self.model = torch.compile(model) if device == 'cuda' else model

        config = model.config
        self.size: int = config.img_size
        self.tags: list[str] = config.tags
        self.categories: list[tuple[str, int, int, float]] = []
        self.base_characters: dict[str, str] = {}
        start = 0
        for name, count in config.tags_split:
            if name in CATEGORIES:
                threshold = config.category_best_threshold[name]
                self.categories.append((name, start, start + count, threshold))
            if name == 'character':
                self.base_characters = _base_characters(self.tags[start : start + count])
            start += count

        overlap_file = hf_hub_download(
            'alea31415/tag_filtering',
            'overlap_tags_simplified.json',
            repo_type='dataset',
        )
        self.overlap_tags: dict[str, list[str]] = json.loads(
            Path(overlap_file).read_text(encoding='utf-8'),
        )

        # Compile at startup instead of on the first request.
        with torch.inference_mode():
            self.model(torch.zeros(1, 3, self.size, self.size, device=device, dtype=self.dtype))

    def __call__(self, img: Image) -> dict[str, list[tuple[str, float]]]:
        with torch.inference_mode():
            probs = self.model(self._pixel_values(img)).float().sigmoid()[0].cpu()

        result: dict[str, list[tuple[str, float]]] = {}
        for name, start, end, threshold in self.categories:
            scores = probs[start:end]
            pairs = sorted(
                (
                    (self.tags[start + i], scores[i].item())
                    for i in (scores > threshold).nonzero().flatten().tolist()
                ),
                key=itemgetter(1),
                reverse=True,
            )[:TOP_K]
            if name == 'general':
                pairs = self._drop_overlap(pairs)
            if name == 'character':
                # Pairs are sorted by score, so setdefault keeps each base's best score.
                collapsed: dict[str, float] = {}
                for tag, score in pairs:
                    collapsed.setdefault(self.base_characters.get(tag, tag), score)
                pairs = list(collapsed.items())
            result[name] = [
                (tag if tag in _KAOMOJIS else tag.replace('_', ' '), score) for tag, score in pairs
            ]

        return result

    def _pixel_values(self, img: Image) -> torch.Tensor:
        # Upstream RescalePadProcessor (fit inside a square, center-pad with black,
        # scale to [-1, 1]), done on the GPU: 11 ms instead of 32 ms on the CPU.
        x = pil_to_tensor(img).to(self.device)[None].float().div_(255)
        height, width = x.shape[-2:]
        scale = min(self.size / height, self.size / width)
        new_height, new_width = int(height * scale), int(width * scale)
        x = torch.nn.functional.interpolate(
            x,
            size=(new_height, new_width),
            mode='bilinear',
            antialias=True,
            align_corners=False,
        )
        pad_w, pad_h = self.size - new_width, self.size - new_height
        x = torch.nn.functional.pad(
            x,
            (pad_w // 2, pad_w - pad_w // 2, pad_h // 2, pad_h - pad_h // 2),
        )
        return (x * 2 - 1).to(self.dtype)

    def _drop_overlap(self, pairs: list[tuple[str, float]]) -> list[tuple[str, float]]:
        names = {tag for tag, _ in pairs}
        return [
            (tag, score)
            for tag, score in pairs
            if not names.intersection(self.overlap_tags.get(tag, ()))
            and not any(tag in other and tag != other for other in names)
        ]


def _base_characters(characters: list[str]) -> dict[str, str]:
    """Map outfit/form variants such as `hoshino_(swimsuit)_(blue_archive)` to `hoshino_(blue_archive)`.

    Prefers the name with only its series qualifier, then the longest qualifier prefix
    (`fujimaru_ritsuka_(male)_(polar_chaldea_uniform)` -> `fujimaru_ritsuka_(male)`),
    and only maps to tags the model itself knows.
    """
    vocabulary = set(characters)
    bases: dict[str, str] = {}
    for tag in characters:
        match = _QUALIFIED_TAG.fullmatch(tag)
        if match is None:
            continue
        name, qualifiers = match[1], _QUALIFIER.findall(match[2])
        if len(qualifiers) < 2:
            continue
        candidates = [name + qualifiers[-1]] + [
            name + ''.join(qualifiers[:end]) for end in range(len(qualifiers) - 1, -1, -1)
        ]
        base = next((candidate for candidate in candidates if candidate in vocabulary), None)
        if base is not None:
            bases[tag] = base
    return bases


def _apply_real_rope(
    self: Any,
    q: torch.Tensor,
    k: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor]:
    # Same rotation as upstream `apply_rotary_enc`, in real cos/sin arithmetic:
    # Inductor cannot fuse complex64 ops, which costs about 0.1 s per image.
    def rotate(x: torch.Tensor) -> torch.Tensor:
        pairs = x.float().unflatten(-1, (-1, 2))
        real, imag = pairs[..., 0], pairs[..., 1]
        return (
            torch.stack(
                [
                    real * self.rope_cos - imag * self.rope_sin,
                    real * self.rope_sin + imag * self.rope_cos,
                ],
                dim=-1,
            )
            .flatten(-2)
            .type_as(x)
        )

    return rotate(q), rotate(k)
