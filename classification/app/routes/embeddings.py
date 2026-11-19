from __future__ import annotations

import types
from typing import TYPE_CHECKING, Annotated, Any

import torch
from fastapi import APIRouter, Body, Request
from sentence_transformers import SentenceTransformer
from torch import nn
from torch.nn import functional
from torch.nn.utils import parametrize

from app.device import resolve_model_device, run_on_gpu
from app.models import EmbeddingPayload, EmbeddingResponse
from app.otel import pipeline_span
from app.utils import preprocess_image

if TYPE_CHECKING:
    from numpy import ndarray
    from PIL.Image import Image

model_device = resolve_model_device()
model_dtype = torch.bfloat16 if model_device == 'cuda' else torch.float32

_EMBEDDING_MERGE_CHUNK = 16_384


def _merge_static_lora(text_model: Any) -> None:
    """Fold jina-clip-v2's single active LoRA adapter into base weights once at load time.

    Upstream `modeling_lora.py` recomputes `X + (lora_A @ lora_B)` on every forward pass,
    which for the 250k-vocab `word_embeddings` allocates ~490 MB (BF16) / ~980 MB (FP32)
    per text request. Since `jina-clip-v2` only ships one LoRA task (`default_loraid == 0`),
    merging in chunks eliminates all runtime LoRA overhead and memory spikes.
    """
    if getattr(text_model, 'default_loraid', None) != 0:
        return

    with torch.no_grad():
        for module in text_model.modules():
            if not parametrize.is_parametrized(module, 'weight'):
                continue
            lora = module.parametrizations.weight[0]
            if not hasattr(lora, 'lora_A') or lora.lora_A.shape[0] != 1:
                continue

            if isinstance(module, nn.Linear):
                merged = lora.lora_forward(module.parametrizations.weight.original, current_task=0)
                merged = merged.detach().clone()
                parametrize.remove_parametrizations(module, 'weight', leave_parametrized=False)
                module.weight.copy_(merged)

                def _linear_fwd(
                    self: nn.Linear,
                    input: torch.Tensor,  # ruff: ignore[builtin-argument-shadowing]
                    task_id: Any = None,  # ruff: ignore[unused-function-argument]
                    residual: bool = False,
                ) -> torch.Tensor | tuple[torch.Tensor, torch.Tensor]:
                    out = functional.linear(input, self.weight, self.bias)
                    return (out, input) if residual else out

                module.forward = types.MethodType(_linear_fwd, module)
            elif isinstance(module, nn.Embedding):
                base = module.parametrizations.weight.original
                lora_a = lora.lora_A[0]
                lora_b = lora.lora_B[0]
                scaling = lora.scaling
                for start in range(0, base.shape[0], _EMBEDDING_MERGE_CHUNK):
                    end = min(start + _EMBEDDING_MERGE_CHUNK, base.shape[0])
                    base[start:end].add_(torch.matmul(lora_a[start:end], lora_b), alpha=scaling)
                parametrize.remove_parametrizations(module, 'weight', leave_parametrized=False)

                def _emb_fwd(
                    self: nn.Embedding,
                    input: torch.Tensor,  # ruff: ignore[builtin-argument-shadowing]
                    task_id: Any = None,  # ruff: ignore[unused-function-argument]
                ) -> torch.Tensor:
                    return functional.embedding(
                        input,
                        self.weight,
                        self.padding_idx,
                        self.max_norm,
                        self.norm_type,
                        self.scale_grad_by_freq,
                        self.sparse,
                    )

                module.forward = types.MethodType(_emb_fwd, module)


def _patch_jina_sdpa(clip_model: Any) -> None:
    """Replace naive eager attention in jina-clip-v2 vision and text encoders with PyTorch SDPA."""
    for block in clip_model.vision_model.blocks:
        attn = block.attn
        if not getattr(attn, 'subln', False):
            continue

        def _eva_sdpa_forward(
            self: Any,
            x: torch.Tensor,
            rope: Any = None,  # ruff: ignore[unused-function-argument]
            attn_mask: Any = None,  # ruff: ignore[unused-function-argument]
            rel_pos_bias: Any = None,  # ruff: ignore[unused-function-argument]
        ) -> torch.Tensor:
            batch, seq_len, _ = x.shape
            q = (
                functional.linear(x, self.q_proj.weight, self.q_bias)
                .reshape(batch, seq_len, self.num_heads, -1)
                .permute(0, 2, 1, 3)
            )
            k = (
                functional.linear(x, self.k_proj.weight, None)
                .reshape(batch, seq_len, self.num_heads, -1)
                .permute(0, 2, 1, 3)
            )
            v = (
                functional.linear(x, self.v_proj.weight, self.v_bias)
                .reshape(batch, seq_len, self.num_heads, -1)
                .permute(0, 2, 1, 3)
            )
            if self.rope:
                q = torch.cat((q[:, :, :1, :], self.rope(q[:, :, 1:, :])), dim=-2).type_as(v)
                k = torch.cat((k[:, :, :1, :], self.rope(k[:, :, 1:, :])), dim=-2).type_as(v)
            out = (
                functional.scaled_dot_product_attention(q, k, v)
                .transpose(1, 2)
                .reshape(batch, seq_len, -1)
            )
            return self.proj(self.inner_attn_ln(out))

        attn.forward = types.MethodType(_eva_sdpa_forward, attn)

    for layer in clip_model.text_model.transformer.roberta.encoder.layers:
        inner_attn = getattr(layer.mixer, 'inner_attn', None)
        if inner_attn is None or type(inner_attn).__name__ != 'SelfAttention':
            continue

        def _text_sdpa_forward(
            self: Any,
            qkv: torch.Tensor,
            causal: bool | None = None,
            key_padding_mask: torch.Tensor | None = None,
        ) -> torch.Tensor:
            is_causal = self.causal if causal is None else causal
            q, k, v = qkv.unbind(dim=2)
            q = q.transpose(1, 2)
            k = k.transpose(1, 2)
            v = v.transpose(1, 2)
            attn_mask = (
                key_padding_mask.bool()[:, None, None, :]
                if key_padding_mask is not None
                else None
            )
            out = functional.scaled_dot_product_attention(
                q,
                k,
                v,
                attn_mask=attn_mask,
                is_causal=is_causal if attn_mask is None else False,
                scale=self.softmax_scale,
            )
            return out.transpose(1, 2)

        inner_attn.forward = types.MethodType(_text_sdpa_forward, inner_attn)


embedding_model = SentenceTransformer(
    'jinaai/jina-clip-v2',
    trust_remote_code=True,
    truncate_dim=1024,
    device=model_device,
    config_kwargs={
        'use_text_flash_attn': False,
        'use_vision_xformers': False,
    },
    model_kwargs={'torch_dtype': model_dtype},
)

_clip_module: Any = embedding_model[0].model
_merge_static_lora(_clip_module.text_model)
_patch_jina_sdpa(_clip_module)

router = APIRouter()


def _encode_sync(
    text: str,
    encoding_mode: Any,
    img: Image | None,
) -> EmbeddingResponse:
    with torch.inference_mode():
        with pipeline_span('text_embedding', 'jinaai/jina-clip-v2', encoding_mode):
            emb_text_vec: ndarray = embedding_model.encode(
                [text],
                prompt_name=encoding_mode.value,
                normalize_embeddings=True,
            )

        emb_image: ndarray | None = None
        if img is not None:
            with pipeline_span('image_embedding', 'jinaai/jina-clip-v2', encoding_mode):
                emb_image = embedding_model.encode(  # ty: ignore[no-matching-overload]
                    [img],
                    prompt_name=encoding_mode.value,
                    normalize_embeddings=True,
                )

    return EmbeddingResponse(
        image=emb_image[0].tolist() if emb_image is not None else None,
        text=emb_text_vec[0].tolist(),
    )


@router.post('/embeddings')
async def embeddings(
    request: Request,
    payload: Annotated[
        EmbeddingPayload,
        Body(
            description='Create embedding for text or image. JSON {"image": "<url-or-base64>", "tags": ["tag1", "tag2"]}',
            examples=[
                {
                    'image': 'https://example.com/image.png',
                    'tags': ['mountains', 'sunrise'],
                },
            ],
        ),
    ],
) -> EmbeddingResponse:
    img = (
        await preprocess_image(payload.image.strip(), request.app.state.http_session)
        if payload.image
        else None
    )
    return await run_on_gpu(_encode_sync, payload.text, payload.encoding_mode, img)
