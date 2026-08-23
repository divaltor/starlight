---
name: effect
description: Starlight Effect v4 house conventions - flat service modules, layers, runtime assembly, typed errors, and ast-grep enforcement. Load when writing or reviewing any Effect TypeScript code in this repo.
---

# Effect in starlight

House conventions for the Effect surfaces (`apps/server/src/services`, `apps/server/src/ai`, `packages/api/src/services`). For portable v4 API guidance (layers, HTTP client, concurrency, configuration), use the global `effect-ts` skill; this file only defines project-specific rules.

## Service module anatomy

One service per file, flat top-level exports, no namespace wrapper:

```ts
import { Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

export interface Interface {
  readonly method: (input: Input) => Effect.Effect<Output, ServiceError>;
}

export class Service extends Context.Service<Service, Interface>()("starlight/Name") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient; // bind deps once, close over them
    const helper = Effect.fn("Name.helper")(function* helper() {
      /* ... */
    });
    return Service.of({
      method: Effect.fn("Name.method")(function* method(input) {
        /* ... */
      }),
    });
  }),
);

export const defaultLayer: Layer.Layer<Service> = layer.pipe(Layer.provide(FetchHttpClient.layer));
```

- Consumers import the whole module (`import * as Exa from "@/services/exa"`) and access `Exa.Service`, `Exa.defaultLayer`. Do not re-introduce `export namespace X { }` wrappers.
- Missing optional config degrades at layer construction (see `Exa` returning empty results when `EXA_API_KEY` is unset).

## Errors

- Expected failures are `Schema.TaggedError` classes with a `static fromCause(input: { message; cause })`.
- Translate transport and infrastructure failures into the service error at the innermost boundary with `Effect.mapError`; never leak raw `HttpClient` errors upward.

## Naming and tracing

- Every workflow gets `Effect.fn("Module.methodName")(function* methodName(...))`.
- Bind services while constructing a layer and close over them in methods; never nest `(yield* SomeService).method(...)` (ast-grep enforces this).

## Runtime assembly

- One `ManagedRuntime` per process: `apps/server/src/services/runtime.ts` merges every service's `defaultLayer`; `packages/api/src/services/runtime.ts` builds from `EmbeddingsService.defaultLayer`.
- Provide layers there, not inside handlers or queue processors.
- Server runtime forwards Effect logs to pino through a `Logger.formatStructured` mapping; log with stable messages plus fields.

## Enforcement

- `bun run lint` runs ast-grep over both rule sets alongside oxlint and typechecks.
- Structural rules in `script/ast-grep/rules`: no import aliases, no `JSON.parse(x) as T`, bind services before calling their methods, `Effect.die` only with `new Error(...)`.
- Rewrite rules in `script/ast-grep/effect-simplifications`: `Effect.orElseSucceed` over catch + succeed, effect-form `andThen` over flatMap + suspend, `Effect.as(undefined)` over andThen + succeed(undefined).
- Edit rules together with their tests under `rule-tests/`; verify with `bun run test:ast-grep-rules`.
- The scan also runs automatically in the lefthook pre-commit hook on staged TypeScript files.

## Testing

- Tests run on `bun:test`. Execute isolated effects with `Effect.runPromise`; use the shared app runtime's `runPromise` when integration wiring is the point.
