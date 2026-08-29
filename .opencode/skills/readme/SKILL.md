---
name: readme
description: Conventions for writing and updating READMEs and project documentation in this repo, based on the Ruff, Ty, and OpenCode README style. Load when creating or editing a README, docs page, or component-level documentation.
---

# README and docs style

Reference models: [Ruff](https://github.com/astral-sh/ruff), [Ty](https://github.com/astral-sh/ty), [OpenCode](https://github.com/anomalyco/opencode). Common thread: the reader is a developer deciding whether to run the thing — answer "what is it, how do I run it" in under a minute of reading.

## Structure

1. `# Title` + one-sentence tagline. What it does, for whom. No "Welcome to...", no history.
2. A flow or architecture diagram only when the project has multiple components; keep labels to real paths and verbs.
3. One section per component/layer, in data-flow order. One paragraph each covering exactly: what it is, what it is for, how to set it up and run it (env file to copy, required vars, dev command). Point to `.env.example` instead of duplicating every variable — name only the ones a human must think about.
4. Deployment / commands as fenced `bash` blocks with comments per step. Commands must be copy-pasteable and taken from the repo's actual scripts and Compose files, not invented.
5. License at the end.

## Rules

- Factual density over marketing: no superlatives, no badges that aren't earned, no "🚀 Getting Started".
- Every claim must be verifiable in the repo: check `package.json`/`pyproject.toml` scripts, `docker-compose.yaml`, and `.env.example` files before writing setup steps. Never describe a script or flag that doesn't exist.
- Name concrete technologies (`GrammY`, `BullMQ`, `TanStack Start`, `CLIP`) — they carry more signal than adjectives.
- Bold component paths (`**`apps/foo`**`) at paragraph start so scanning finds the layer boundaries.
- Keep total length proportional to the project: a monorepo README fits in one screen plus command blocks.
- Cross-references between layers stay in prose (`ML_API_TOKEN` must match `CLASSIFICATION_API_TOKEN`), not in a variable table.
- Update the README when a layer is added, renamed, or its setup contract changes — treat it as code owned by the change.
