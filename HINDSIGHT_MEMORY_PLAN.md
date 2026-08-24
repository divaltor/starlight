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

Phase 2 — complete Hindsight memory replacement (implemented 2026-08-24):

| Area        | Change                                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment  | Hindsight server/client pinned to `0.9.1`; Compose service uses the existing pgvector Postgres, OpenRouter `google/gemini-3.7-flash`, and classification embedding/rerank routes                               |
| App client  | `Hindsight` Effect service wraps async batch retain, profile reads, deterministic document deletion, and profile refresh                                                                                       |
| Retention   | The single long-polling bot process scans at most 100 observations per namespace; reads synchronously drain relevant namespaces before snapshotting profiles                                                   |
| Isolation   | User banks are audience-scoped (`private`, per-chat, per-topic, `public`); chat/topic banks keep their namespace keys                                                                                          |
| Durability  | `MemoryNamespace.retentionWatermark` advances only after deterministic retain/delete/profile-refresh operations complete; retries resume the same retain operation                                             |
| Privacy     | Memory Defense explicitly redacts Hindsight's recognized secret/structured-PII patterns; `/forget` deletes every pre-request source document attributed to the requester instead of relying on semantic recall |
| Corrections | Hindsight document IDs use Telegram chat/message identity, so edits replace the original retained document                                                                                                     |
| Reads       | Rendered user profiles are frozen in `preparedRequest`; chat/topic profiles are frozen in `ConversationContext.frozenMemory`; retries never reread mutable profiles                                            |
| Removal     | `MemoryRevision`, `MemoryBuildAttempt`, `MemoryQueue`, builder configuration, and revision rendering were removed; Hindsight is mandatory                                                                      |

Real-data preflight used a recent production Langfuse Starlight trace: a 50-message Russian
topic window with corrections, repeated entities, financial facts, dates, and hard-negative
banter. The active Starlight model trace confirms `google/gemini-3.7-flash`. No trace payloads
are copied into the repository.

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
- Memory Defense is explicitly enabled with `sensitive_data → redact`; upstream defaults it off.
- Architecture per Agnes: eager singletons, sync `def` endpoints, lock per model, fp16 only
  on cuda device, no vLLM/TEI/split-service unless measured need appears.

## Remaining work

### B. Runtime smoke test on the GPU box (do first)

Blocked 2026-08-24: both `divaltor@homelab.local` and `ssh@homelab.local` reject the
available key in batch mode. Resume when SSH access is available.

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

Required Compose configuration is prepared in `docker-compose.hindsight.yaml` but has not
been started. Exact release: `0.9.1`.

- Postgres 15+ with pgvector (pre-flight: confirm extension installable on our DB host).
- Pin an exact 0.9.x release (changelog shows weekly churn; do not track latest).
- Server env:
  - `HINDSIGHT_API_LLM_PROVIDER` → our existing OpenAI-compatible endpoint (reuse key
    plane with `selected` model profile; consider Groq `openai/gpt-oss-120b`, tested by
    upstream, for cheap extraction).
  - `HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai` + base URL
    `http://classification:<port>/v1/openai` (+ our API token as the key).
  - Reranker: provider `cohere` + `COHERE_BASE_URL=http://classification:<port>/v1/rerank`.
  - Memory Defense is fixed to redact recognized secrets and structured PII.
- Retain cadence stays app-driven: the single bot process scans in batches (≤100 observations
  per namespace wake-up) → one async retain per bank batch. Never retain-per-message.

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

### E. Licensing decision (not required)

Licensing is explicitly out of scope for this deployment. Keep the selected models.

### F. Starlight app integration (`apps/starlight`)

Hindsight is the only memory backend. PostgreSQL keeps `MemoryNamespace` and
`MemoryObservation` as the transactional provenance/outbox ledger.

- User profile text is synchronized and frozen before `preparedRequest` is persisted.
- Chat/topic profile text is synchronized outside Prisma transactions and frozen at context
  creation, reset, and checkpoint boundaries.
- `/forget` writes ordered markers under lane locks, drains every affected namespace through
  those markers, deletes requester-authored pre-marker documents, refreshes profiles, and only
  then confirms to the user.
- The destructive replacement migration was generated and applied to the local development DB.

### G. Later / ops

- Mental-model refresh cost tuning once traffic exists; correctness currently uses explicit refresh.
- Monitoring: Hindsight operations lag, extraction token spend per batch, recall latency.

## Reference

- Research sessions: benchmarks `ses_fcb8f7db0ffejAQNjy2MFuKPzt`; vendor deep-dives
  earlier in this thread (Hindsight internals, Mem0 rejection rationale).
- Key sources: RusBEIR arXiv 2504.12879, ruMTEB NAACL 2025, jina-clip-v2 paper
  (arXiv 2412.08802, Table 3/5), HF cards for BERTA / USER-bge-m3 / jina-reranker-v2,
  Hindsight docs (models/configuration/retain/recall/mental-models).
