## Critical Rules

1. Use `@/` alias for all internal imports; relative imports are forbidden in apps.
2. Prefer Bun APIs (`Bun.file`, `Bun.write`, etc.) over Node.js `fs` equivalents.
3. Treat Telegram IDs as JS safe integers (`number`) in app code; convert to `BigInt` only where required by Prisma/db types.
4. Run `build` script only for changes in `apps/web` package.
5. Don't run `test` command unless you change code related to these tests.
6. Align on pre-existing types from libraries and generated code (Prisma included); use `Pick`, `Omit` and other TypeScript type-helpers instead of recreating the same information, and avoid defensive type-safety checks for scenarios that cannot happen in trusted internal code.
7. In Grammy handlers, `ctx.<obj>` is guaranteed by middleware; use `ctx.<obj>!` instead of defensive existence checks.
8. When working on Effect TS code, load the local `effect` skill (`.opencode/skills/effect`); the global `effect-ts` skill remains the portable API reference.
9. Use structured logging: keep messages stable and put object IDs and dynamic context in log fields (for example, `logger.info({ photoId }, "Photo embeddings generated")`), never interpolate them into the message.
10. Don't use `git stash` mid-session; other agents or the user can edit files at the same time.
11. Before writing or proposing tests, read `TESTING.md` and pass its admission gate.
12. This project is a pre-production PoC with no legacy or production data. Do not add backward compatibility, migrations, or legacy recovery unless explicitly requested.

## Communication

- Human-facing output (replies, commit messages, PR text): fewest words that carry the point.
- No superlatives, praise, or agreement padding. State disagreements and risks plainly.

## Design Principles

Optimize the design for the normal flow. If the happy path is 95% of behavior, it should be ~95% of what a reader sees.

- Make top-level code read like a use case: orchestrators call well-named domain methods; push parsing, process plumbing, protocol details, and state surgery into the lowest module that owns them.
- Patterns, layers, interfaces, and files are costs. Add one only when it owns a real invariant, hides real complexity, has multiple real implementations, removes stable duplication, or creates a proven boundary. No reflexive Controller -> Service -> Repository pass-throughs.
- Prefer deletion and the smallest correct diff. Do not add a dependency, abstraction, configuration, or flexibility without a proven present need; explain the cost first.
- Parse untrusted input once at the boundary into trusted domain values; make illegal states unrepresentable; pass trusted values inward instead of re-checking raw data.
- Never reduce validation at trust boundaries, protection against data loss, security, accessibility, or explicitly requested behavior to make a change smaller.
- No speculative safeguards or theoretical race handling. Fix the smallest real, observed failure at the boundary that owns it. Prefer fewer names, fewer branches, and net-negative diffs.
- Before adding complexity for a speculative edge case, explain the concrete failure mode, its likelihood, and the cost; get the user's buy-in first.
- Before adding code, confirm that a change is needed. Then understand and trace the real flow. Reuse an established local pattern, the standard library, platform features, or an installed dependency before writing custom code; search for a maintained third-party library before building one.
- If the correct implementation is one line over the platform or an existing API, write that line — inline, unexported, unwrapped.
- For a bug, check all callers and fix the root cause in the lowest shared owner. Do not patch each visible symptom separately.
- For non-trivial business logic owned by this repository, add the smallest focused test or runnable check that proves the changed behavior.

## TypeScript Style

- Use guard clauses and early returns; avoid `else`.
- Avoid `try`/`catch` where possible; in Effect code, put expected failures in the error channel.
- Access properties with dot notation (`obj.a`) instead of destructuring.
- Inline single-use variables and intermediate bindings.
- Type-guard `filter` callbacks to preserve inference.
- Rely on type inference; annotate only at exports and boundaries.
- Avoid the `any` type.
- Prefer `const`; use ternaries or early returns instead of reassignment.
- Never alias imports (`import { x as y }`) and never use star imports. Group module exports in one `export namespace <CanonicalName>` block (name declared once at the source); consumers use named imports of that namespace.
- Prefer functional array methods (`map`, `filter`, `flatMap`) over `for` loops.
- NEVER extract a one-liner, even a heavily used one: a body that is a single call or expression — `estimateTokens(value)` = `Math.ceil(value.length / 4)`, `hash(value)` = one `Bun.CryptoHasher` chain, `profileFingerprint(input)` = `hash(renderEnvelope(input))` — gets written inline at every call site. A wrapper name sends every human reader on a hop to find a line they already know; repetition is not complexity.
- Keep helpers below the code they support; do not extract multi-line logic used fewer than three times.
- Comments are rare and explain why, not what.
- Name recurring or spec-defined values (HTTP statuses, limits, callback prefixes) as consts or enums; inline self-explanatory one-off literals.
- Prefer options objects or enums over positional boolean parameters; `send({ retry: true })` reads better at the call site than `send(true)`.

## Effect TS

Services follow the namespace-wrapped module anatomy in `.opencode/skills/effect/SKILL.md`.

- Consumers import the namespace by name (`import { Thing } from "@/..."`) and read `Thing.Service`, `Thing.defaultLayer`. Star imports are forbidden (`import/no-namespace`).
- Bind services while constructing a layer; never nest `(yield* Service).method(...)`.
- Name workflows `Effect.fn("Module.method")`.
- Effect tracing is exported by the runtime; use named `Effect.fn` or `Effect.withSpan`, not manual OTel spans inside Effect code.
- Model expected failures as `Schema.TaggedError` with a `static fromCause(...)` helper.
- One assembled `ManagedRuntime` per process in `services/runtime.ts`.
- Keep pure parsing, validation, and option building synchronous; do not return `Effect` from helpers that do no effectful work.
- Decode untrusted JSON with `Schema` helpers such as `Schema.decodeUnknownOption`, not manual `JSON.parse` wrapped in `Effect.try`.
- Enforcement: `bun run lint`.

## Maintenance & Tasks

- MUST use `bun` for package management.
- Run `lint` command to check for linting errors, then run `typecheck` for type errors. DON'T use bare `tsc` from the repo root and DON'T run `format` — it's triggered automatically by other pipelines.
- ALWAYS use scripts from package.json to create and apply migrations via Prisma. Never write migration files manually.
- Never hand-edit `packages/utils/src/generated/prisma`; regenerate with `bun run db:generate`.
- Follow conventional commits: `type(scope): summary` with types `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Scopes are optional; use the affected app or package, for example `web`, `server`, `starlight`, `utils`.
