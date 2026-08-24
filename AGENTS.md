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
11. **Never write a test before the admission gate under # Testing passes.**

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
- Never alias imports (`import { x as y }`) and never use star imports.
- Prefer functional array methods (`map`, `filter`, `flatMap`) over `for` loops.
- NEVER extract a one-liner, even a heavily used one: a body that is a single call or expression — `estimateTokens(value)` = `Math.ceil(value.length / 4)`, `hash(value)` = one `Bun.CryptoHasher` chain, `profileFingerprint(input)` = `hash(renderEnvelope(input))` — gets written inline at every call site. A wrapper name sends every human reader on a hop to find a line they already know; repetition is not complexity.
- Keep helpers below the code they support; do not extract multi-line logic used fewer than three times.
- Comments are rare and explain why, not what.
- Name recurring or spec-defined values (HTTP statuses, limits, callback prefixes) as consts or enums; inline self-explanatory one-off literals.
- Prefer options objects or enums over positional boolean parameters; `send({ retry: true })` reads better at the call site than `send(true)`.

## Effect TS

Services follow the flat module anatomy (no `export namespace` wrapper) — see `.opencode/skills/effect/SKILL.md` for the full pattern:

```ts
export interface Interface {
  readonly method: (input: Input) => Effect.Effect<Output, ServiceError>;
}
export class Service extends Context.Service<Service, Interface>()("starlight/Thing") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    /* bind deps once */
  }),
);
export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer));
```

- Bind services while constructing a layer; never nest `(yield* Service).method(...)`.
- Name workflows `Effect.fn("Module.method")`.
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

# Testing

## NON-NEGOTIABLE TEST ADMISSION GATE

**Do not write, propose, or generate a test before this gate passes.** First state one sentence in this form:

> Our product must `<observable behavior>` because `<business rule, user risk, security boundary, data-loss risk, or regression in our code>`.

The test is allowed only when all of these are true:

1. The behavior is a decision or invariant owned by this repository, not by a dependency, framework, validator, database, language, or runtime.
2. A failure would break a user workflow, violate a product rule, cross a security boundary, lose or corrupt data, or reproduce a real bug in our code.
3. Replacing the underlying library with an equivalent library would leave the test valuable.
4. Mutating the relevant business logic in our code makes the test fail.

If any condition is false, **DO NOT WRITE THE TEST**. Use the library's own test suite, types, documentation, a focused manual check, or lint instead.

Forbidden examples unless they protect a separately stated product rule:

- A schema library rejects malformed input or applies a default.
- Encryption round-trips, uses random nonces, emits hex, or accepts a key type.
- A framework propagates errors, cancellation, context, or dependency injection as documented.
- The runtime handles promises, concurrency, strings, URLs, dates, or serialization as documented.
- A constructor, getter, adapter, or pass-through calls a dependency correctly.
- A mock returns what the test configured it to return.

Coverage, branch count, implementation complexity, and “this code was changed” are never sufficient reasons to add a test.

## Core rules

- Tests verify e2e flows and extraordinary logic for our data flow, not that 2 + 2 = 4.
- Don't test third-party logic or data validation — the library authors already did.
- Test behavior, not implementation: assert observable outcomes; never assert internal calls, call order, intermediate values, or generated SQL text.
- Every test must name the class of bug or the customer rule it protects. If you can't name it, delete it. Regressions are exempt: the fixed bug is their provenance.
- A test must be able to fail. Prove it: break the behavior and watch it go red. If it stays green, it's a change-detector — rewrite or delete it.
- Mock only the external boundary (Telegram API, Yandex, time, randomness); flow tests use real collaborators. Patch real attributes, never string import paths — if everything is mocked you verify the mock, not the integration.
- Every bug fix ships with the regression test that would have caught it first.
- One behavior per test, one equivalence class per test.

## Levels (spend effort where it pays)

- Most value is in integration tests: several real units together, only the external boundary mocked. Write mostly these.
- Unit-test only genuinely tricky logic: parsing, format building, ordering rules.
- Reserve full e2e for critical journeys, not per-branch coverage.
- Test each rule once, at the cheapest level that can express it. Don't repeat the same behavior at unit, integration and e2e.

## Code rules

- Use fixtures instead of private helpers.
- Tests are isolated and deterministic: each creates its own data, runs in any order, and gives the same result every time.
- No shared mutable fixtures, no state passed between tests.
- No `sleep`, no real clock, no real network.
- Assert specific values, not truthiness.
- No logic in tests: no loops or conditionals — parametrize instead.
- Name tests as behavior sentences: `test_<behavior>_when_<condition>`.
- Minimal test data: only what the scenario needs.
- Golden/snapshot assertions only for formats we own (callback data, rich-message rendering); never as a generic change detector.

## Design principles

- Tests are code: they cost maintenance. Delete tests that stop earning their keep.
- Coverage is a signal, not a goal: returns fall off past ~70%. Use it to find untested hot zones, not to chase 100%.
- A test that fights you is the design talking: fix the seam, don't monkeypatch harder.
- Keep the suite fast. Slow tests don't get run; flaky tests train people to ignore red.
