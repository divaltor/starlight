# Phase 0 RESULT — Provider Cache Proof

## Verdict

```text
PASS  Gemini 3.7 Flash on google-vertex/global
GO    Start Phase 1 with a fixed explicit cache base
HOLD  DeepSeek V4 Flash Vision is not a drop-in replacement
```

## Selected profile

```text
model              google/gemini-3.7-flash
provider only      google-vertex/global
fallbacks          disabled
cache              OpenRouter-managed explicit breakpoint
cache lifetime     fixed 5 minutes, non-refreshing
reasoning          minimal
```

The live explicit-cache floor was between 2,540 marked tokens, which missed, and 5,043 marked tokens, which hit. This agrees with Vertex's documented 4,096-token Gemini 3 floor.

| Gemini behavior                    |                           Result |
| ---------------------------------- | -------------------------------: |
| One-minute explicit retention      |                         2/2 hits |
| Fixed-base append-only growth      | 10,301 tokens reused on R1/R2/R3 |
| New session                        |                              hit |
| Tools, strict schema, inline media |                             pass |
| Implicit one-minute pilot          |       miss after a confirmed hit |

Implicit caching is best effort. Count only the marked explicit base in guaranteed savings.

## Large-context cost

Gemini and DeepSeek scale sweeps ran in parallel.

| Gemini fixture | Actual input | New cache | Repeat read |
| -------------: | -----------: | --------: | ----------: |
|            20k |       25,122 | $0.001565 |   $0.001047 |
|            30k |       37,659 | $0.002187 |   $0.001514 |
|            40k |       50,196 | $0.003013 |   $0.001927 |
|            60k |       75,271 | $0.004463 |   $0.002910 |

Current OpenRouter billing made new caches 83–85% cheaper than cold input and repeats 89–90% cheaper. New-cache calls averaged 6.8 seconds versus 3.1 seconds for reads.

Phase 1 sends the same fixed marker every turn. It does not move the marker every turn. A later coarse rebase can advance it after enough uncached tail accumulates and latency evidence justifies the write.

## DeepSeek comparison

```text
model              deepseek/deepseek-v4-flash-vision-exp
provider only      deepseek
context            1,048,576 tokens
cache              automatic/implicit
cache read price   $0.007 / 1M tokens
```

| DeepSeek fixture | Actual input |      Cold | Repeat read |
| ---------------: | -----------: | --------: | ----------: |
|              20k |       17,960 | $0.003954 |   $0.000175 |
|              30k |       26,915 | $0.005904 |   $0.000234 |
|              40k |       35,870 | $0.007854 |   $0.000297 |
|              60k |       53,781 | $0.011755 |   $0.000419 |

DeepSeek repeat savings were 95.6–96.5%. Both one-minute retries hit. The first live reusable block was 128 tokens. A new `x-session-id` missed, so stable session affinity is required.

DeepSeek vision passed, but the selected profile did not:

- named object `tool_choice` was rejected;
- strict structured output was rejected;
- the sole endpoint is not in OpenRouter's ZDR list.

DeepSeek remains a low-cost candidate for workloads without these requirements. Gemini remains selected for the chatbot profile.

## Architecture decision

```text
A + B  fixed generation base        explicit cache
C      finalized appended turns     implicit/best effort
D      current request               volatile
```

- Keep the explicit marker in every request at the same boundary.
- Rebase only at a real checkpoint or after a measured large uncached tail.
- Never checkpoint only because a cache expired.
- Never use cache state for correctness.
- Keep model, route, tools, schema, reasoning, and media policy in `ModelProfile`.

Direct Vertex is deferred. OpenRouter is currently cheaper and already proven. Reconsider direct Vertex only for caller-managed TTL, regional/security controls, or background creation of native `cachedContents` resources.

## Validation and cost

- `bun test src/phase-0`: 16 passed.
- Root `bun run lint`: all six packages passed.
- `git diff --check`: passed.
- Experiment key usage after the final run: approximately $0.1506 of a $10 limit.

AI SDK per-step usage is authoritative. OpenRouter's generation-detail endpoint returned HTTP 404 for measured IDs.
