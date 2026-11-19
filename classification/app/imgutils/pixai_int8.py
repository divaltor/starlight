"""Fused Triton W8A8 INT8 WMMA + SmoothQuant execution for PixAI Tagger v1.0 on ROCm/CUDA."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch
import triton  # ty: ignore[unresolved-import]
import triton.language as tl  # ty: ignore[unresolved-import]
from torch import nn
from torch.nn import functional
from torch.nn.attention import SDPBackend, sdpa_kernel

_EXPECTED_IMG_SIZE = 1008
_EXPECTED_PATCH_SIZE = 14
_EXPECTED_WINDOW_SIZE = 24
_EXPECTED_EMBED_DIM = 1024
_EXPECTED_NUM_HEADS = 16
_EXPECTED_DEPTH = 32
_EXPECTED_MLP_DIM = 4736
_NUM_TOKENS = (_EXPECTED_IMG_SIZE // _EXPECTED_PATCH_SIZE) ** 2  # 5184
_HEAD_DIM = _EXPECTED_EMBED_DIM // _EXPECTED_NUM_HEADS  # 64
_WINDOW_GRID = (_EXPECTED_IMG_SIZE // _EXPECTED_PATCH_SIZE) // _EXPECTED_WINDOW_SIZE  # 3
_NUM_WINDOWS = _WINDOW_GRID * _WINDOW_GRID  # 9
_WINDOW_TOKENS = _EXPECTED_WINDOW_SIZE * _EXPECTED_WINDOW_SIZE  # 576

_SMOOTHQUANT_ALPHA = 0.85
_SMOOTHQUANT_MARGIN = 1.15
_CALIBRATION_PATH = Path(__file__).resolve().parents[2] / 'tunableop' / 'pixai_fc1_amax.fp16.bin'

# Triton's AST parser evaluates non-constexpr type annotations in its kernel scope and fails
# on standard Python typing symbols (`Any`, `None`), so kernel parameters only annotate `tl.constexpr`.
# ruff: disable[missing-type-function-argument, missing-return-type-private-function]


@triton.jit
def _ln_quant_kernel(
    x_ptr,
    w_ptr,
    b_ptr,
    q_ptr,
    s_ptr,
    k_dim,
    eps,
    BLOCK_K: tl.constexpr,  # ruff: ignore[invalid-argument-name]
):
    row = tl.program_id(0)
    offs = tl.arange(0, BLOCK_K)
    mask = offs < k_dim
    x = tl.load(x_ptr + row * k_dim + offs, mask=mask, other=0.0).to(tl.float32)
    mean = tl.sum(x, axis=0) / k_dim
    diff = x - mean
    var = tl.sum(diff * diff, axis=0) / k_dim
    rstd = tl.math.rsqrt(var + eps)
    w = tl.load(w_ptr + offs, mask=mask, other=1.0).to(tl.float32)
    b = tl.load(b_ptr + offs, mask=mask, other=0.0).to(tl.float32)
    y = diff * rstd * w + b
    amax = tl.max(tl.abs(y), axis=0)
    scale = tl.maximum(amax / 127.0, 1e-8)
    q = tl.extra.hip.libdevice.rint(y / scale)
    q = tl.minimum(tl.maximum(q, -127.0), 127.0).to(tl.int8)
    tl.store(q_ptr + row * k_dim + offs, q, mask=mask)
    tl.store(s_ptr + row, scale)


@triton.jit
def _qkv_rope_unpack_kernel(
    qkv_ptr,
    cos_ptr,
    sin_ptr,
    q_ptr,
    k_ptr,
    v_ptr,
    seq_len,
    num_heads,
    D_HALF: tl.constexpr,  # ruff: ignore[invalid-argument-name]
):
    pid = tl.program_id(0)
    head = pid % num_heads
    rem = pid // num_heads
    pos = rem % seq_len
    batch = rem // seq_len
    head_dim = D_HALF * 2
    offs_p = tl.arange(0, D_HALF)

    base_qkv = (batch * seq_len + pos) * 3 * num_heads * head_dim
    q_off = base_qkv + head * head_dim
    k_off = base_qkv + num_heads * head_dim + head * head_dim
    v_off = base_qkv + 2 * num_heads * head_dim + head * head_dim

    cos = tl.load(cos_ptr + pos * D_HALF + offs_p).to(tl.float32)
    sin = tl.load(sin_ptr + pos * D_HALF + offs_p).to(tl.float32)

    q_re = tl.load(qkv_ptr + q_off + offs_p * 2).to(tl.float32)
    q_im = tl.load(qkv_ptr + q_off + offs_p * 2 + 1).to(tl.float32)
    k_re = tl.load(qkv_ptr + k_off + offs_p * 2).to(tl.float32)
    k_im = tl.load(qkv_ptr + k_off + offs_p * 2 + 1).to(tl.float32)
    v_re = tl.load(qkv_ptr + v_off + offs_p * 2)
    v_im = tl.load(qkv_ptr + v_off + offs_p * 2 + 1)

    out_base = ((batch * num_heads + head) * seq_len + pos) * head_dim
    tl.store(q_ptr + out_base + offs_p * 2, (q_re * cos - q_im * sin).to(tl.bfloat16))
    tl.store(q_ptr + out_base + offs_p * 2 + 1, (q_re * sin + q_im * cos).to(tl.bfloat16))
    tl.store(k_ptr + out_base + offs_p * 2, (k_re * cos - k_im * sin).to(tl.bfloat16))
    tl.store(k_ptr + out_base + offs_p * 2 + 1, (k_re * sin + k_im * cos).to(tl.bfloat16))
    tl.store(v_ptr + out_base + offs_p * 2, v_re)
    tl.store(v_ptr + out_base + offs_p * 2 + 1, v_im)


@triton.jit
def _attn_out_transpose_quant_kernel(
    x_ptr,
    q_ptr,
    s_ptr,
    seq_len,
    sb,
    sh,
    sl,
    sd,
    NUM_HEADS: tl.constexpr,  # ruff: ignore[invalid-argument-name]
    HEAD_DIM: tl.constexpr,  # ruff: ignore[invalid-argument-name]
):
    # AOTriton mem_eff SDPA returns non-contiguous (B, L, H, D) strides; index via explicit strides.
    pid = tl.program_id(0)
    pos = pid % seq_len
    batch = pid // seq_len
    offs_h = tl.arange(0, NUM_HEADS)[:, None]
    offs_d = tl.arange(0, HEAD_DIM)[None, :]
    val = tl.load(x_ptr + batch * sb + offs_h * sh + pos * sl + offs_d * sd).to(tl.float32)
    amax = tl.max(tl.abs(val))
    scale = tl.maximum(amax / 127.0, 1e-8)
    q = tl.extra.hip.libdevice.rint(val / scale)
    q = tl.minimum(tl.maximum(q, -127.0), 127.0).to(tl.int8)
    tl.store(q_ptr + pid * (NUM_HEADS * HEAD_DIM) + offs_h * HEAD_DIM + offs_d, q)
    tl.store(s_ptr + pid, scale)


@triton.jit
def _int8_gemm_epilogue_kernel(
    a_ptr,
    b_ptr,
    c_ptr,
    sa_ptr,
    sb_ptr,
    bias_ptr,
    res_ptr,
    out_inv_scale_ptr,
    m_dim,
    n_dim,
    k_dim,
    stride_am,
    stride_ak,
    stride_bn,
    stride_bk,
    stride_cm,
    stride_cn,
    BM: tl.constexpr,  # ruff: ignore[invalid-argument-name]
    BN: tl.constexpr,  # ruff: ignore[invalid-argument-name]
    BK: tl.constexpr,  # ruff: ignore[invalid-argument-name]
    GM: tl.constexpr,  # ruff: ignore[invalid-argument-name]
    GELU: tl.constexpr,  # ruff: ignore[invalid-argument-name]
    ADD_RES: tl.constexpr,  # ruff: ignore[invalid-argument-name]
    OUT_INT8_PER_CH: tl.constexpr,  # ruff: ignore[invalid-argument-name]
    HAS_SA: tl.constexpr,  # ruff: ignore[invalid-argument-name]
):
    pid = tl.program_id(0)
    num_pid_m = tl.cdiv(m_dim, BM)
    num_pid_n = tl.cdiv(n_dim, BN)
    num_pid_in_group = GM * num_pid_n
    group_id = pid // num_pid_in_group
    first_pid_m = group_id * GM
    group_size_m = min(num_pid_m - first_pid_m, GM)
    pid_m = first_pid_m + ((pid % num_pid_in_group) % group_size_m)
    pid_n = (pid % num_pid_in_group) // group_size_m

    offs_m = pid_m * BM + tl.arange(0, BM)
    offs_n = pid_n * BN + tl.arange(0, BN)
    offs_k = tl.arange(0, BK)

    a_ptrs = a_ptr + offs_m[:, None] * stride_am + offs_k[None, :] * stride_ak
    b_ptrs = b_ptr + offs_n[None, :] * stride_bn + offs_k[:, None] * stride_bk

    acc = tl.zeros((BM, BN), dtype=tl.int32)
    for _ in range(tl.cdiv(k_dim, BK)):
        a = tl.load(a_ptrs, mask=(offs_m[:, None] < m_dim), other=0)
        b = tl.load(b_ptrs, mask=(offs_n[None, :] < n_dim), other=0)
        acc = tl.dot(a, b, acc, out_dtype=tl.int32)
        a_ptrs += BK * stride_ak
        b_ptrs += BK * stride_bk

    sb = tl.load(sb_ptr + offs_n, mask=offs_n < n_dim, other=1.0)
    bias = tl.load(bias_ptr + offs_n, mask=offs_n < n_dim, other=0.0)
    if HAS_SA:
        sa = tl.load(sa_ptr + offs_m, mask=offs_m < m_dim, other=1.0)
        val = acc.to(tl.float32) * (sa[:, None] * sb[None, :]) + bias[None, :]
    else:
        val = acc.to(tl.float32) * sb[None, :] + bias[None, :]
    if GELU:
        val = val * 0.5 * (1.0 + tl.math.erf(val * 0.7071067811865476))
    c_ptrs = c_ptr + offs_m[:, None] * stride_cm + offs_n[None, :] * stride_cn
    mask_c = (offs_m[:, None] < m_dim) & (offs_n[None, :] < n_dim)
    if ADD_RES:
        res = tl.load(
            res_ptr + offs_m[:, None] * stride_cm + offs_n[None, :] * stride_cn,
            mask=mask_c,
            other=0.0,
        ).to(tl.float32)
        val += res
    if OUT_INT8_PER_CH:
        inv_sc = tl.load(out_inv_scale_ptr + offs_n, mask=offs_n < n_dim, other=1.0)
        q = tl.extra.hip.libdevice.rint(val * inv_sc[None, :])
        q = tl.minimum(tl.maximum(q, -127.0), 127.0).to(tl.int8)
        tl.store(c_ptrs, q, mask=mask_c)
    else:
        tl.store(c_ptrs, val.to(tl.bfloat16), mask=mask_c)


# ruff: enable[missing-type-function-argument, missing-return-type-private-function]


def _quantize_weight(
    weight: torch.Tensor,
    bias: torch.Tensor | None,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    scale = (weight.abs().amax(dim=1) / 127.0).clamp(min=1e-8).contiguous()
    quant = torch.round(weight / scale[:, None]).clamp(-127, 127).to(torch.int8).contiguous()
    bias_fp32 = (
        bias.detach().float().contiguous()
        if bias is not None
        else torch.zeros(weight.shape[0], dtype=torch.float32)
    )
    return quant, scale, bias_fp32


class _FusedW8A8Block(nn.Module):
    def __init__(self, block: Any, fc1_act_amax: torch.Tensor) -> None:
        super().__init__()
        self.window_size: int = block.window_size
        self.mlp_hidden: int = block.mlp.fc1.out_features
        self.register_buffer('ln1_w', block.norm1.weight.detach().bfloat16().contiguous())
        self.register_buffer('ln1_b', block.norm1.bias.detach().bfloat16().contiguous())
        self.register_buffer('ln2_w', block.norm2.weight.detach().bfloat16().contiguous())
        self.register_buffer('ln2_b', block.norm2.bias.detach().bfloat16().contiguous())
        for name, linear in (
            ('qkv', block.attn.qkv),
            ('proj', block.attn.proj),
            ('fc1', block.mlp.fc1),
        ):
            quant, scale, bias = _quantize_weight(linear.weight.detach().float(), linear.bias)
            self.register_buffer(f'{name}_w', quant)
            self.register_buffer(f'{name}_s', scale)
            self.register_buffer(f'{name}_b', bias)

        # SmoothQuant migrates post-GELU activation outliers into fc2 weights so fc1's
        # epilogue writes int8 directly with zero intermediate BF16 write/quantize pass.
        w2 = block.mlp.fc2.weight.detach().float()
        w2_col_amax = w2.abs().amax(dim=0).clamp(min=1e-5)
        a_ch = (fc1_act_amax.float() * _SMOOTHQUANT_MARGIN).clamp(min=1e-5)
        migration = (a_ch.pow(_SMOOTHQUANT_ALPHA) / w2_col_amax.pow(1.0 - _SMOOTHQUANT_ALPHA)).clamp(
            min=1e-5,
        )
        act_scale = migration * ((a_ch / migration).max() / 127.0)
        wq2, ws2, b2 = _quantize_weight(w2 * act_scale[None, :], block.mlp.fc2.bias)
        self.register_buffer('fc2_w', wq2)
        self.register_buffer('fc2_s', ws2)
        self.register_buffer('fc2_b', b2)
        self.register_buffer('fc1_out_inv_scale', (1.0 / act_scale).contiguous())

        self.register_buffer('rope_cos', block.attn.freqs_cis.real.float().contiguous())
        self.register_buffer('rope_sin', block.attn.freqs_cis.imag.float().contiguous())

    def forward(self, x: torch.Tensor, scratch: tuple[torch.Tensor, ...]) -> torch.Tensor:
        q1024, s1024, qkv_buf, q_buf, k_buf, v_buf, mlp_i8, dummy = scratch
        batch = _NUM_WINDOWS if self.window_size > 0 else 1
        seq_len = _WINDOW_TOKENS if self.window_size > 0 else _NUM_TOKENS
        mlp_dim = self.mlp_hidden

        _ln_quant_kernel[_NUM_TOKENS,](
            x,
            self.ln1_w,
            self.ln1_b,
            q1024,
            s1024,
            _EXPECTED_EMBED_DIM,
            1e-5,
            BLOCK_K=_EXPECTED_EMBED_DIM,
            num_warps=4,
        )
        _int8_gemm_epilogue_kernel[triton.cdiv(_NUM_TOKENS, 128) * triton.cdiv(3072, 128),](
            q1024,
            self.qkv_w,
            qkv_buf,
            s1024,
            self.qkv_s,
            self.qkv_b,
            dummy,
            dummy,
            _NUM_TOKENS,
            3072,
            _EXPECTED_EMBED_DIM,
            _EXPECTED_EMBED_DIM,
            1,
            _EXPECTED_EMBED_DIM,
            1,
            3072,
            1,
            BM=128,
            BN=128,
            BK=64,
            GM=4,
            GELU=False,
            ADD_RES=False,
            OUT_INT8_PER_CH=False,
            HAS_SA=True,
            num_warps=4,
            num_stages=2,
            waves_per_eu=2,
            matrix_instr_nonkdim=16,
            kpack=2,
        )

        q_view = q_buf.view(batch, _EXPECTED_NUM_HEADS, seq_len, _HEAD_DIM)
        k_view = k_buf.view(batch, _EXPECTED_NUM_HEADS, seq_len, _HEAD_DIM)
        v_view = v_buf.view(batch, _EXPECTED_NUM_HEADS, seq_len, _HEAD_DIM)
        _qkv_rope_unpack_kernel[batch * seq_len * _EXPECTED_NUM_HEADS,](
            qkv_buf,
            self.rope_cos,
            self.rope_sin,
            q_view,
            k_view,
            v_view,
            seq_len,
            _EXPECTED_NUM_HEADS,
            D_HALF=_HEAD_DIM // 2,
            num_warps=1,
        )

        # On gfx1150, mem_eff beats flash by ~21 ms across the 28 window blocks,
        # while flash beats mem_eff on the 4 full-sequence global blocks.
        backend = (
            SDPBackend.EFFICIENT_ATTENTION if self.window_size > 0 else SDPBackend.FLASH_ATTENTION
        )
        with sdpa_kernel(backend):
            attn_out = functional.scaled_dot_product_attention(q_view, k_view, v_view)

        _attn_out_transpose_quant_kernel[_NUM_TOKENS,](
            attn_out,
            q1024,
            s1024,
            seq_len,
            attn_out.stride(0),
            attn_out.stride(1),
            attn_out.stride(2),
            attn_out.stride(3),
            NUM_HEADS=_EXPECTED_NUM_HEADS,
            HEAD_DIM=_HEAD_DIM,
            num_warps=4,
        )
        _int8_gemm_epilogue_kernel[
            triton.cdiv(_NUM_TOKENS, 64) * triton.cdiv(_EXPECTED_EMBED_DIM, 128),
        ](
            q1024,
            self.proj_w,
            x,
            s1024,
            self.proj_s,
            self.proj_b,
            x,
            dummy,
            _NUM_TOKENS,
            _EXPECTED_EMBED_DIM,
            _EXPECTED_EMBED_DIM,
            _EXPECTED_EMBED_DIM,
            1,
            _EXPECTED_EMBED_DIM,
            1,
            _EXPECTED_EMBED_DIM,
            1,
            BM=64,
            BN=128,
            BK=128,
            GM=8,
            GELU=False,
            ADD_RES=True,
            OUT_INT8_PER_CH=False,
            HAS_SA=True,
            num_warps=4,
            num_stages=2,
            waves_per_eu=2,
            matrix_instr_nonkdim=16,
            kpack=2,
        )

        _ln_quant_kernel[_NUM_TOKENS,](
            x,
            self.ln2_w,
            self.ln2_b,
            q1024,
            s1024,
            _EXPECTED_EMBED_DIM,
            1e-5,
            BLOCK_K=_EXPECTED_EMBED_DIM,
            num_warps=4,
        )
        _int8_gemm_epilogue_kernel[triton.cdiv(_NUM_TOKENS, 64) * triton.cdiv(mlp_dim, 64),](
            q1024,
            self.fc1_w,
            mlp_i8,
            s1024,
            self.fc1_s,
            self.fc1_b,
            dummy,
            self.fc1_out_inv_scale,
            _NUM_TOKENS,
            mlp_dim,
            _EXPECTED_EMBED_DIM,
            _EXPECTED_EMBED_DIM,
            1,
            _EXPECTED_EMBED_DIM,
            1,
            mlp_dim,
            1,
            BM=64,
            BN=64,
            BK=64,
            GM=8,
            GELU=True,
            ADD_RES=False,
            OUT_INT8_PER_CH=True,
            HAS_SA=True,
            num_warps=4,
            num_stages=2,
            waves_per_eu=0,
            matrix_instr_nonkdim=16,
            kpack=2,
        )
        _int8_gemm_epilogue_kernel[
            triton.cdiv(_NUM_TOKENS, 64) * triton.cdiv(_EXPECTED_EMBED_DIM, 128),
        ](
            mlp_i8,
            self.fc2_w,
            x,
            dummy,
            self.fc2_s,
            self.fc2_b,
            x,
            dummy,
            _NUM_TOKENS,
            _EXPECTED_EMBED_DIM,
            mlp_dim,
            mlp_dim,
            1,
            mlp_dim,
            1,
            _EXPECTED_EMBED_DIM,
            1,
            BM=64,
            BN=128,
            BK=64,
            GM=8,
            GELU=False,
            ADD_RES=True,
            OUT_INT8_PER_CH=False,
            HAS_SA=False,
            num_warps=4,
            num_stages=2,
            waves_per_eu=0,
            matrix_instr_nonkdim=16,
            kpack=2,
        )
        return x


class FusedW8A8PixAI(nn.Module):
    """W8A8 INT8 + SmoothQuant PixAI forward pass with persistent window layout and HIP graph."""

    _q1024: torch.Tensor
    _s1024: torch.Tensor
    _qkv: torch.Tensor
    _q: torch.Tensor
    _k: torch.Tensor
    _v: torch.Tensor
    _mlp_i8: torch.Tensor
    _dummy: torch.Tensor

    def __init__(self, base_model: Any, num_output_tags: int) -> None:
        super().__init__()
        cfg = base_model.config
        if (
            cfg.img_size != _EXPECTED_IMG_SIZE
            or cfg.patch_size != _EXPECTED_PATCH_SIZE
            or cfg.window_size != _EXPECTED_WINDOW_SIZE
            or cfg.embed_dim != _EXPECTED_EMBED_DIM
            or cfg.num_heads != _EXPECTED_NUM_HEADS
            or len(base_model.blocks) != _EXPECTED_DEPTH
            or base_model.blocks[0].mlp.fc1.out_features != _EXPECTED_MLP_DIM
        ):
            raise ValueError(
                'Unexpected PixAI config for W8A8 SmoothQuant kernels: '
                f'img={cfg.img_size} patch={cfg.patch_size} win={cfg.window_size} '
                f'dim={cfg.embed_dim} heads={cfg.num_heads} depth={len(base_model.blocks)}',
            )

        raw_cal = bytearray(_CALIBRATION_PATH.read_bytes())
        fc1_amax = torch.frombuffer(raw_cal, dtype=torch.float16).reshape(
            _EXPECTED_DEPTH,
            _EXPECTED_MLP_DIM,
        )

        self.patch_embed = base_model.patch_embed
        # Pre-tile absolute positional embeddings once instead of every forward pass.
        abs_pos = (
            base_model.pos_embed[:, 1:]
            .detach()
            .reshape(1, _EXPECTED_WINDOW_SIZE, _EXPECTED_WINDOW_SIZE, _EXPECTED_EMBED_DIM)
            .permute(0, 3, 1, 2)
            .tile([1, 1, _WINDOW_GRID, _WINDOW_GRID])
            .permute(0, 2, 3, 1)
            .contiguous()
        )
        self.register_buffer('tiled_pos', abs_pos)
        self.ln_pre = base_model.ln_pre
        self.blocks = nn.ModuleList(
            [_FusedW8A8Block(blk, fc1_amax[idx]) for idx, blk in enumerate(base_model.blocks)],
        )
        self.head_pool = base_model.head_pool

        # Slice the classifier head to the contiguous prefix of categories we actually serve.
        sliced_head = nn.Linear(
            _EXPECTED_EMBED_DIM,
            num_output_tags,
            bias=True,
            dtype=torch.bfloat16,
        )
        with torch.no_grad():
            sliced_head.weight.copy_(base_model.head.weight[:num_output_tags])
            sliced_head.bias.copy_(base_model.head.bias[:num_output_tags])
        self.head = sliced_head

        self.register_buffer(
            '_q1024',
            torch.empty(_NUM_TOKENS, _EXPECTED_EMBED_DIM, dtype=torch.int8),
            persistent=False,
        )
        self.register_buffer(
            '_s1024',
            torch.empty(_NUM_TOKENS, dtype=torch.float32),
            persistent=False,
        )
        self.register_buffer(
            '_qkv',
            torch.empty(_NUM_TOKENS, _EXPECTED_EMBED_DIM * 3, dtype=torch.bfloat16),
            persistent=False,
        )
        self.register_buffer(
            '_q',
            torch.empty(_NUM_TOKENS * _EXPECTED_EMBED_DIM, dtype=torch.bfloat16),
            persistent=False,
        )
        self.register_buffer(
            '_k',
            torch.empty(_NUM_TOKENS * _EXPECTED_EMBED_DIM, dtype=torch.bfloat16),
            persistent=False,
        )
        self.register_buffer(
            '_v',
            torch.empty(_NUM_TOKENS * _EXPECTED_EMBED_DIM, dtype=torch.bfloat16),
            persistent=False,
        )
        self.register_buffer(
            '_mlp_i8',
            torch.empty(_NUM_TOKENS, _EXPECTED_MLP_DIM, dtype=torch.int8),
            persistent=False,
        )
        self.register_buffer('_dummy', torch.empty(1, dtype=torch.float32), persistent=False)

        self._graph: torch.cuda.CUDAGraph | None = None
        self._static_in: torch.Tensor | None = None
        self._static_out: torch.Tensor | None = None

    def _run_eager(self, pixel_values: torch.Tensor) -> torch.Tensor:
        x = self.ln_pre(self.patch_embed(pixel_values) + self.tiled_pos)
        scratch = (
            self._q1024,
            self._s1024,
            self._qkv,
            self._q,
            self._k,
            self._v,
            self._mlp_i8,
            self._dummy,
        )
        in_windows = False
        for blk in self.blocks:
            assert isinstance(blk, _FusedW8A8Block)
            if blk.window_size > 0:
                if not in_windows:
                    x = (
                        x.view(
                            1,
                            _WINDOW_GRID,
                            _EXPECTED_WINDOW_SIZE,
                            _WINDOW_GRID,
                            _EXPECTED_WINDOW_SIZE,
                            _EXPECTED_EMBED_DIM,
                        )
                        .permute(0, 1, 3, 2, 4, 5)
                        .reshape(_NUM_TOKENS, _EXPECTED_EMBED_DIM)
                        .contiguous()
                    )
                    in_windows = True
                x = blk(x, scratch)
            else:
                if in_windows:
                    x = (
                        x.view(
                            1,
                            _WINDOW_GRID,
                            _WINDOW_GRID,
                            _EXPECTED_WINDOW_SIZE,
                            _EXPECTED_WINDOW_SIZE,
                            _EXPECTED_EMBED_DIM,
                        )
                        .permute(0, 1, 3, 2, 4, 5)
                        .reshape(_NUM_TOKENS, _EXPECTED_EMBED_DIM)
                        .contiguous()
                    )
                    in_windows = False
                x = blk(x, scratch)
        if in_windows:
            x = (
                x.view(
                    1,
                    _WINDOW_GRID,
                    _WINDOW_GRID,
                    _EXPECTED_WINDOW_SIZE,
                    _EXPECTED_WINDOW_SIZE,
                    _EXPECTED_EMBED_DIM,
                )
                .permute(0, 1, 3, 2, 4, 5)
                .reshape(_NUM_TOKENS, _EXPECTED_EMBED_DIM)
                .contiguous()
            )
        return self.head(self.head_pool(x.unsqueeze(0)))

    def capture_graph(self) -> None:
        sample = torch.zeros(
            1,
            3,
            _EXPECTED_IMG_SIZE,
            _EXPECTED_IMG_SIZE,
            device=self._dummy.device,
            dtype=torch.bfloat16,
        )
        stream = torch.cuda.Stream()
        stream.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(stream), torch.inference_mode():
            for _ in range(3):
                self._run_eager(sample)
        torch.cuda.current_stream().wait_stream(stream)

        static_in = sample.clone()
        graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(graph), torch.inference_mode():
            static_out = self._run_eager(static_in)
        self._graph = graph
        self._static_in = static_in
        self._static_out = static_out

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        if self._graph is not None and self._static_in is not None and self._static_out is not None:
            self._static_in.copy_(pixel_values)
            self._graph.replay()
            return self._static_out.clone()
        return self._run_eager(pixel_values)
