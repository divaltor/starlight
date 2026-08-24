# Hindsight Memory Integration Plan

Continuation plan for serving memory-retrieval models from `classification/` and wiring
them into the Starlight bot via Hindsight. Written 2026-08-24 after implementing phase 1.
Resume from section B (runtime smoke test) — nothing below has been executed against real
hardware or a live Hindsight instance.

## Status: done

Phase 1 — memory-model routes in `classification/` (implemented, lint/type/compile clean):

| File                            | Change                                                                                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/config.py`                 | `ENABLE_TEXT_EMBEDDINGS`, `ENABLE_RERANKER` (default false), model + revision settings                                                                                                                                                             |
| `app/models.py`                 | Wire-contract limits + `Annotated` Pydantic types (`MemoryText`, `QueryText`, `DocumentText`, `EmbeddingInputs`, `Documents`); OpenAI/Cohere request-response models; `top_n` bounds via `model_validator`; `StrictInt` blocks bool/float coercion |
| `app/routes/text_embeddings.py` | POST `/v1/openai/embeddings` (OpenAI wire format: float **and** base64 LE float32, usage from real tokenizer, model echo, dimensions checked against loaded model)                                                                                 |
| `app/routes/rerank.py`          | POST `/v1/rerank` (Cohere wire format: `{index, relevance_score}` sorted desc; `CrossEncoder.rank(batch_size=16)`)                                                                                                                                 |
| `app/main.py`                   | Auth: `X-API-Token` **or** `Authorization: Bearer` accepted independently (Bellno precedence bug fixed); conditional router includes                                                                                                               |
| `.env.example`                  | New flags/models/pins + alternatives documented                                                                                                                                                                                                    |
| `Dockerfile`                    | `--workers 1` pinned (multi-worker would duplicate GPU models)                                                                                                                                                                                     |

Review state: Agnes consulted (all decisions followed), Bellno reviewed — 3 findings,
all fixed (auth precedence, blank query → now `QueryText` validator, `top_n` coercion →
`StrictInt`). Background benchmark research completed (session `ses_fcb8f7db0ffejAQNjy2MFuKPzt`).

## Locked decisions

- **PoC pair**: embedder `sergeyzh/BERTA` (`914c8c8aed14042ed890fc2c662d5e9e66b2faa7`),
  reranker `jinaai/jina-reranker-v2-base-multilingual`
  (`9cfeff2df7d40d1b78e75e5e9cebec92a99813c9`).
- **Keep `jina-clip-v2`** for image route untouched; research verdict: its ru retrieval
  (64.73 MTEB-multi) is defensible, but dedicated challengers need local shadow-eval before
  any switch. `truncate_dim=1024` is native — zero truncation loss.
- **Fallback models** (pinned, one-env-var swaps): embedder `BAAI/bge-m3`
  (`5617a9f61b028005a4858fdac845db406aefb181`); reranker
  `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (`1427fd652930e4ba29e8149678df786c240d8825`).
- Contracts: Hindsight OpenAI provider base URL must include `/v1/openai` (client appends
  `/embeddings`); Hindsight Cohere reranker treats `COHERE_BASE_URL` as the exact endpoint.
- Architecture per Agnes: eager singletons, sync `def` endpoints, lock per model, fp16 only
  on cuda device, no vLLM/TEI/split-service unless measured need appears.

## Remaining work

### B. Runtime smoke test on the GPU box (do first)

1. `docker build` + `docker run` with `ENABLE_TEXT_EMBEDDINGS=true ENABLE_RERANKER=true`.
2. Confirm first boot downloads both pinned revisions into the HF cache volume.
3. Curl checks:
   - embeddings: float response, 768 dims, normalized (~unit norm), ordered indices;
     repeat with `encoding_format:"base64"` and decode to compare;
   - rerank: descending scores, original indices preserved, `top_n` honored;
   - auth matrix: valid Bearer ✓, stale `X-API-Token` + valid Bearer ✓ (must pass),
     invalid both ✗ 401.
4. Measure resident UMA/GPU memory with all three models loaded (CLIP + BERTA + Jina v2);
   record number here and in README when known.
5. Watch for jina-reranker custom-code issues under ROCm (flash-attn import fallback);
   if it fails, flip `RERANKER_MODEL` to the mmarco-MiniLMv2 pin and re-test.

### C. Deploy Hindsight beside it

- Postgres 15+ with pgvector (pre-flight: confirm extension installable on our DB host).
- Pin an exact 0.9.x release (changelog shows weekly churn; do not track latest).
- Server env:
  - `HINDSIGHT_API_LLM_PROVIDER` → our existing OpenAI-compatible endpoint (reuse key
    plane with `selected` model profile; consider Groq `openai/gpt-oss-120b`, tested by
    upstream, for cheap extraction).
  - `HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai` + base URL
    `http://classification:<port>/v1/openai` (+ our API token as the key).
  - Reranker: provider `cohere` + `COHERE_BASE_URL=http://classification:<port>/v1/rerank`.
  - Decide Memory Defense mode per bank (redact vs block) during PoC.
- Retain cadence stays app-driven: existing BullMQ batching (≤100 observations per
  namespace wake-up) → one async retain per batch. Never retain-per-message.

### D. Embedder bake-off evals (settles "keep jina-clip-v2 or not")

Build a small eval script (MTEB-style, offline, CPU/GPU either fine):

- Data: 200–500 real lane transcripts → query/fact pairs, stratified: RU→RU, EN→EN,
  RU→EN, EN→RU, code-switched, entity/date-heavy, same-chat hard negatives.
- Metrics: Recall@10/20 pre-rerank; MRR@10 / nDCG@10 post-rerank; p50/p95 latency;
  peak shared-memory footprint.
- Candidates: jina-clip-v2 text tower (1024d) vs BERTA (768d) vs bge-m3 (1024d) vs
  multilingual-e5-large (needs `query:`/`passage:` prefixes).
- Switch bar (from research): dedicated model wins only with **≥3 absolute points**
  overall without degrading either cross-language stratum; switching costs a full
  re-embedding of stored facts, so decide once, early.
- Reranker side-compare: jina-v2 vs mmarco-MiniLMv2 on the Russian strata.

### E. Licensing decision (blocking for production, not PoC)

`jina-reranker-v2` is CC-BY-NC-4.0 (non-commercial). If Starlight ships commercially:
swap to mmarco-MiniLMv2 (Apache-2.0) via env, or negotiate license. BERTA/bge-m3/e5 are
Apache/MIT-friendly — verify each card before prod.

### F. Starlight app integration (`apps/starlight`)

Behind the existing seam, in this order:

1. `Hindsight` Effect namespace module (`@/memory/hindsight`): `retain`, `profile`
   (mental-model read), `invalidateAbout`; wraps `@vectorize-io/hindsight-client`;
   typed error `HindsightError` (Schema.TaggedError).
2. Bank mapping 1:1 with namespaces: `user:{id}` / `chat:{id}` / `topic:{chatId}:{threadKey}`;
   one mental model named `profile` per bank replaces `latestRevision`.
3. `Memory.hindsightLayer` implementing `Memory.Interface`: `build` → async retain with
   `document_id: obs:{sourceThrough}`; `renderContextMemory`/`renderUserMemory` → profile
   reads + existing `isPermitted` projection; `forget` → ledger observation (unchanged) +
   fact invalidation + lane reset. Sensitive/confidence gate moves read-time — keep it.
4. `runtime.ts`: add `Hindsight.defaultLayer` to infrastructure; swap `Memory.layer` →
   `Memory.hindsightLayer`. Builder LLM dependency drops out.
5. Prisma migration: retire `MemoryRevision` + `MemoryBuildAttempt` (keep data), add
   `retentionWatermark BigInt?` to `MemoryNamespace` via package.json scripts only.
6. Update `/forget` reply text only after invalidation actually evicts stored facts.
7. Load the local `effect` skill before writing any of this code (repo rule).

### G. Later / ops

- Mental-model refresh policy tuning (after-consolidation vs cron) once traffic exists.
- Monitoring: Hindsight operations lag, extraction token spend per batch, recall latency.
- Rollback path: `Memory.layer` (revision-based) kept compilable until bake-off verdict;
  revert = one layer swap + migration down-plan.

## Reference

- Research sessions: benchmarks `ses_fcb8f7db0ffejAQNjy2MFuKPzt`; vendor deep-dives
  earlier in this thread (Hindsight internals, Mem0 rejection rationale).
- Key sources: RusBEIR arXiv 2504.12879, ruMTEB NAACL 2025, jina-clip-v2 paper
  (arXiv 2412.08802, Table 3/5), HF cards for BERTA / USER-bge-m3 / jina-reranker-v2,
  Hindsight docs (models/configuration/retain/recall/mental-models).
