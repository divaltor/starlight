"""Native PyTorch definition matching the published Camie safetensors checkpoint.

The release provides weights rather than a directly loadable PyTorch architecture,
while the original integration used its exported ONNX graph on the CPU. Recreating
the architecture with checkpoint-compatible module names lets ``load_state_dict``
verify every weight strictly and run the same computation through native ROCm kernels,
without maintaining another converted model artifact.
"""

from __future__ import annotations

from math import isqrt
from typing import TYPE_CHECKING

import timm
import torch
from torch import Tensor, nn

if TYPE_CHECKING:
    from timm.models.vision_transformer import VisionTransformer


class ViTWrapper(nn.Module):
    def __init__(self, vit: VisionTransformer) -> None:
        super().__init__()
        self.vit = vit

    def forward(self, inputs: Tensor) -> tuple[Tensor, Tensor]:
        batch_size = inputs.shape[0]
        tokens = self.vit.patch_embed(inputs)
        cls_token = self.vit.cls_token.expand(batch_size, -1, -1)
        tokens = torch.cat((cls_token, tokens), dim=1)
        tokens += self.vit.pos_embed[:, : tokens.shape[1]]
        tokens = self.vit.pos_drop(tokens)

        for block in self.vit.blocks:
            tokens = block(tokens)

        tokens = self.vit.norm(tokens)
        # Camie needs both spatial patch features and the global CLS representation;
        # timm's normal classification forward only exposes the final pooled output.
        cls_token = tokens[:, 0]
        patch_tokens = tokens[:, 1:]
        patch_map_size = isqrt(patch_tokens.shape[1])
        patch_features = patch_tokens.transpose(1, 2).reshape(
            batch_size,
            patch_tokens.shape[2],
            patch_map_size,
            patch_map_size,
        )
        return patch_features, cls_token


class ImageTagger(nn.Module):
    def __init__(
        self,
        total_tags: int = 70_527,
        model_name: str = 'vit_base_patch16_384',
        num_heads: int = 16,
        dropout: float = 0.0,
        tag_context_size: int = 256,
        img_size: int = 512,
    ) -> None:
        super().__init__()
        vit = timm.create_model(
            model_name,
            pretrained=False,
            img_size=img_size,
            num_classes=0,
        )
        self.backbone = ViTWrapper(vit)
        self.tag_context_size = tag_context_size
        self.total_tags = total_tags
        embedding_dim = vit.embed_dim
        self.tag_embedding = nn.Embedding(total_tags, embedding_dim)
        self.tag_bias = nn.Parameter(torch.zeros(total_tags))
        self.image_token_proj = nn.Identity()
        self.cross_attention = nn.MultiheadAttention(
            embed_dim=embedding_dim,
            num_heads=num_heads,
            dropout=dropout,
            batch_first=True,
        )
        self.cross_norm = nn.LayerNorm(embedding_dim)

    def forward(self, inputs: Tensor) -> Tensor:
        patch_map, cls_token = self.backbone(inputs)
        image_tokens = self.image_token_proj(patch_map).flatten(2).transpose(1, 2)
        global_features = 0.5 * (image_tokens.mean(dim=1) + cls_token)
        initial_logits = global_features @ self.tag_embedding.weight.t() + self.tag_bias

        # Score every tag cheaply, then run cross-attention only for the strongest
        # candidates instead of attending all 70k tag embeddings to every image patch.
        candidate_indices = torch.topk(
            torch.sigmoid(initial_logits),
            k=min(self.tag_context_size, self.total_tags),
            dim=1,
            largest=True,
            sorted=True,
        ).indices
        tag_embeddings = self.tag_embedding(candidate_indices)
        attended_features, _ = self.cross_attention(
            query=tag_embeddings,
            key=image_tokens,
            value=image_tokens,
            # Attention maps are not part of the output; skipping them saves memory and
            # allows PyTorch to select its optimized scaled-dot-product attention path.
            need_weights=False,
        )
        attended_features = self.cross_norm(attended_features)
        candidate_logits = (attended_features * tag_embeddings).sum(dim=-1)

        refined_logits = initial_logits.clone()
        # Non-candidates retain their global scores while selected tags get image-local
        # evidence from cross-attention, matching the checkpoint's two-stage design.
        refined_logits.scatter_(1, candidate_indices, candidate_logits)
        return refined_logits
