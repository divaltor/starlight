## Critical Rules

1. Use `@/` alias for all internal imports; relative imports are forbidden in apps.
2. Prefer Bun APIs (`Bun.file`, `Bun.write`, etc.) over Node.js `fs` equivalents.
3. Treat Telegram IDs as JS safe integers (`number`) in app code; convert to `BigInt` only where required by Prisma/db types.
4. Run `build` script only for changes in `apps/web` package.
5. Don't run `test` command unless you change code related to these tests.
6. Use pre-defined types from libraries\Prisma generated files where is possible. Use Pick, Omit and other Typescript type-helpers to extract required values instead of creating own types with same information.
7. Align on pre-existing types from libraries and generated code; avoid creating redundant helper types or defensive type-safety checks for scenarios that cannot happen in trusted internal code.
8. In Grammy handlers, `ctx.<obj>` is guaranteed by middleware; use `ctx.<obj>!` instead of defensive existence checks.
9. When working on Effect TS code, load the local `effect` skill (`.opencode/skills/effect`); the global `effect-ts` skill remains the portable API reference.
10. Use structured logging: keep messages stable and put object IDs and dynamic context in log fields (for example, `logger.info({ photoId }, "Photo embeddings generated")`), never interpolate them into the message.
11. Don't use `git stash` mid-session; other agents or the user can edit files at the same time.

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
- For a bug, check all callers and fix the root cause in the lowest shared owner. Do not patch each visible symptom separately.
- For non-trivial logic, add the smallest focused test or runnable check that proves the changed behavior.

## TypeScript Style

- Use guard clauses and early returns; avoid `else`.
- Avoid `try`/`catch` where possible; in Effect code, put expected failures in the error channel.
- Access properties with dot notation (`obj.a`) instead of destructuring.
- Inline single-use variables; drop intermediate bindings.
- Type-guard `filter` callbacks to preserve inference.
- Rely on type inference; annotate only at exports and boundaries.
- Avoid the `any` type.
- Prefer `const`; use ternaries or early returns instead of reassignment.
- Never alias imports (`import { x as y }`) and never use star imports.
- Prefer functional array methods (`map`, `filter`, `flatMap`) over `for` loops.
- Keep helpers below the code they support; do not extract logic used fewer than three times.
- Comments are rare and explain why, not what.

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
- DON'T use `tsc` or `typecheck` or `check-types`.
- Run `lint` command to check for linting errors. DON'T run `format` — it's triggered automatically by other pipelines.
- ALWAYS use scripts from package.json to create and apply migrations via Prisma. Never write migration files manually.
- Never hand-edit `packages/utils/src/generated/prisma`; regenerate with `bun run db:generate`.
- Follow conventional commits: `type(scope): summary` with types `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Scopes are optional; use the affected app or package, for example `web`, `server`, `starlight`, `utils`.

## Testing

- Tests verify e2e flows and extraordinary logic in our data flow, not that 2 + 2 = 4.
- Don't test third-party logic already tested by library authors, and don't verify data validation — Zod and Prisma own that.
- Test behavior, not implementation: assert observable outcomes; never assert internal calls, call order, or intermediate values.
- Do not duplicate production logic inside tests.
- Every test must name the class of bug or the user rule it protects. If you can't name it, delete it. Regression tests are exempt: the fixed bug is their provenance.
- A test must be able to fail. Break the behavior by hand and watch it go red. If it stays green, it's a change-detector — rewrite or delete it.
- Mock only the external boundary: Telegram API, AI SDK, time, randomness. For flow tests use real collaborators — a real Prisma client against the test database.
- Every bug fix ships with the regression test that would have caught it first.
- One behavior per test, one equivalence class per test.

### Levels

- Most value is in integration tests: several real units together, only the external boundary mocked. Write mostly these.
- Unit-test only genuinely tricky logic (cursor pagination, parsing, scoring).
- Test each rule once, at the cheapest level that can express it; don't repeat the same behavior across levels.

### Test code

- Use fixtures instead of private helpers.
- Tests are isolated and deterministic: each creates its own data, runs in any order, and gives the same result every time. No shared mutable state, no `sleep`, no real clock, no real network.
- Assert specific values, not truthiness.
- No loops or conditionals in tests — parametrize instead (`test.each`).
- Name tests as behavior sentences: `test("keeps every media row for a post on the same page")`.
