# Hindsight Memory Integration Plan

Continuation plan for serving memory-retrieval models from `classification/` and wiring
them into the Starlight bot via Hindsight. Written 2026-08-24 after implementing phase 1.
The model endpoints were smoke-tested on the homelab ROCm host on 2026-08-25; live
Hindsight integration remains pending.

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
| Deployment  | Hindsight server/client pinned to `0.9.2`; Compose service uses the existing pgvector Postgres, OpenRouter `google/gemini-3.7-flash`, and classification embedding/rerank routes                               |
| App client  | `Hindsight` Effect service wraps async batch retain, query-time recall, deterministic document deletion, and removal of legacy profile models                                                                  |
| Retention   | The single long-polling bot process scans at most 100 observations per namespace; reads synchronously drain relevant namespaces before recall                                                                  |
| Isolation   | User banks are audience-scoped (`private`, per-chat, per-topic, `public`); chat/topic banks keep their namespace keys                                                                                          |
| Durability  | `MemoryNamespace.retentionWatermark` advances only after deterministic retain/delete operations complete; retries resume the same retain operation                                                             |
| Privacy     | Memory Defense explicitly redacts Hindsight's recognized secret/structured-PII patterns; `/forget` deletes every pre-request source document attributed to the requester instead of relying on semantic recall |
| Corrections | Hindsight document IDs use Telegram chat/message identity, so edits replace the original retained document                                                                                                     |
| Reads       | Query-relevant user/chat/topic recall results are frozen in `preparedRequest`; `ConversationContext.frozenMemory` contains only checkpoint continuity; retries never repeat recall                             |
| Removal     | `MemoryRevision`, `MemoryBuildAttempt`, `MemoryQueue`, builder configuration, and revision rendering were removed; Hindsight is mandatory                                                                      |

Real-data preflight used a recent production Langfuse Starlight trace: a 50-message Russian
topic window with corrections, repeated entities, financial facts, dates, and hard-negative
banter. The active Starlight model trace confirms `google/gemini-3.7-flash`. No trace payloads
are copied into the repository.

## Locked decisions

- **Selected pair**: embedder `BAAI/bge-m3`
  (`5617a9f61b028005a4858fdac845db406aefb181`), reranker
  `BAAI/bge-reranker-v2-m3` (`953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`).
- **Keep `jina-clip-v2`** for image route untouched; research verdict: its ru retrieval
  (64.73 MTEB-multi) is defensible, but dedicated challengers need local shadow-eval before
  any switch. `truncate_dim=1024` is native — zero truncation loss.
- **BERTA is evaluation-only with a role-aware provider**: its retrieval contract requires
  different `search_query:` and `search_document:` prompts, while Hindsight 0.9.1 sends both
  through the same OpenAI embeddings request. Its model default is the unrelated
  `categorize_entailment:` prompt, so serving it unchanged produces the wrong embeddings.
- **Fallback reranker** (pinned, one-env-var swap):
  `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (`1427fd652930e4ba29e8149678df786c240d8825`).
- Contracts: Hindsight OpenAI provider base URL must include `/v1/openai` (client appends
  `/embeddings`); Hindsight Cohere reranker treats `COHERE_BASE_URL` as the exact endpoint.
- Memory Defense is explicitly enabled with `sensitive_data → redact`; upstream defaults it off.
- Architecture per Agnes: eager singletons, sync `def` endpoints, lock per model, fp16 only
  on cuda device, no vLLM/TEI/split-service unless measured need appears.

## Remaining work

### B. Runtime smoke test on the GPU box — complete for model endpoints

The production Dockerfile built and ran on the Radeon 890M ROCm host. With bge-m3 and
BGE reranker v2 M3 loaded, startup took 20 seconds and resident memory was 3.83 GiB.

- embeddings: 1024 dimensions, normalized vectors, ordered indices, float/base64 parity;
- batch limit: 64 inputs accepted in 246 ms; 65 rejected with 422;
- rerank: Russian semantic ordering, descending scores, original indices, and `top_n` passed
  in 103 ms;
- auth: valid Bearer passed, stale `X-API-Token` plus valid Bearer passed, invalid both
  returned 401;
- 100 short reranker documents completed in 654 ms.

The existing CLIP service stayed live concurrently. A single-process all-model restart and
live Hindsight retain/recall remain deployment smoke checks.

### C. Deploy Hindsight beside it

Compose configuration lives in `docker-compose.yaml`. Exact release: `0.9.2`.

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
  per namespace wake-up) → one async retain per bank batch. Low-volume traffic can produce
  singleton batches; this affects extraction cost but never triggers mental-model reflection.

### D. Memory retrieval bake-off — complete

Evaluation used 30 synthetic conversational-memory queries and a fixed 300-query RuBQ
subset. Production remained untouched.

- BGE-M3 led embeddings at .791 nDCG@10 and .720 MRR@10.
- BGE reranker v2 M3 led rerankers at .872 RuBQ nDCG and .803 Hit@1.
- BERTA's role-specific prompt contract is incompatible with Hindsight's identical
  query/document payloads.
- MiniLM requires `max_length=512`, unlike the selected model's current 1024-token contract.

### E. Licensing decision (not required)

Licensing is explicitly out of scope for this deployment. Keep the selected models.

### F. Starlight app integration (`apps/starlight`)

Hindsight is the only memory backend. PostgreSQL keeps `MemoryNamespace` and
`MemoryObservation` as the transactional provenance/outbox ledger.

- Pending relevant observations are retained, then the current immutable input batch queries
  the permitted user/chat/topic banks through Hindsight recall.
- Bounded recall results are frozen in `preparedRequest`; retries reuse identical bytes.
- Conversation checkpoints remain in `ConversationContext.frozenMemory` and are independent
  of Hindsight mental models.
- `/forget` writes ordered markers under lane locks, drains every affected namespace through
  those markers, deletes requester-authored pre-marker documents, resets affected contexts, and
  only then confirms to the user.
- The destructive replacement migration was generated and applied to the local development DB.

### G. Later / ops

- Monitoring: Hindsight operations lag, extraction token spend per batch, recall latency and
  recalled-result volume.

## Reference

- Research sessions: benchmarks `ses_fcb8f7db0ffejAQNjy2MFuKPzt`; vendor deep-dives
  earlier in this thread (Hindsight internals, Mem0 rejection rationale).
- Key sources: RusBEIR arXiv 2504.12879, ruMTEB NAACL 2025, jina-clip-v2 paper
  (arXiv 2412.08802, Table 3/5), HF cards for BERTA, USER-bge-m3, BGE-M3, and BGE
  reranker v2 M3, Hindsight docs (models/configuration/retain/recall/mental-models).
