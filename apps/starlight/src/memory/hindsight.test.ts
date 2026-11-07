import { expect, spyOn, test } from "bun:test";
import { Effect, Fiber, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { Hindsight } from "@/memory/hindsight";

test("test_recalls_memory_when_another_bank_waiter_is_cancelled", async () => {
  const creation = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<undefined>();
  const createdBanks: string[] = [];
  const deletedProfiles: string[] = [];

  await withHindsight(
    (request): Response | Promise<Response> => {
      const path = new URL(request.url).pathname;

      if (request.method === "PUT") {
        createdBanks.push(path);
        started.resolve(undefined);

        return creation.promise;
      }

      if (path.endsWith("/mental-models/profile")) {
        deletedProfiles.push(path);

        return Response.json({});
      }

      if (path.endsWith("/mental-models")) return Response.json({ items: [{ id: "profile" }] });

      if (path.endsWith("/recall")) return Response.json({ results: [{ id: "fact-1", text: "Alice chose Postgres" }] });

      return Response.json({});
    },
    async (hindsight) => {
      const input = { bankId: "conversation:1:2:0", maxTokens: 100, query: "Which database?" };
      const first = new AbortController();
      const cancelled = Effect.runPromiseExit(hindsight.recall(input), { signal: first.signal });
      await started.promise;
      const waiting = Effect.runPromise(hindsight.recall(input));
      first.abort();
      await cancelled;
      creation.resolve(Response.json({}));

      expect(await waiting).toEqual([{ id: "fact-1", text: "Alice chose Postgres" }]);
      expect(await Effect.runPromise(hindsight.recall(input))).toEqual([
        { id: "fact-1", text: "Alice chose Postgres" },
      ]);
      expect(createdBanks).toEqual(["/v1/default/banks/conversation%3A1%3A2%3A0"]);
      expect(deletedProfiles).toEqual(["/v1/default/banks/conversation%3A1%3A2%3A0/mental-models/profile"]);
    },
  );
});

test("test_retries_bank_setup_when_configuration_previously_failed", async () => {
  let configurations = 0;

  await withHindsight(
    (request) => {
      const path = new URL(request.url).pathname;

      if (path.endsWith("/config")) {
        configurations += 1;

        return configurations === 1 ? Response.json({ detail: "Unavailable" }, { status: 503 }) : Response.json({});
      }

      if (path.endsWith("/mental-models")) return Response.json({ items: [] });

      if (path.endsWith("/recall")) return Response.json({ results: [{ id: "fact-2", text: "Retained fact" }] });

      return Response.json({});
    },
    async (hindsight) => {
      const input = { bankId: "conversation:3:4:0", maxTokens: 100, query: "What is retained?" };
      expect(await Effect.runPromise(hindsight.recall(input).pipe(Effect.flip))).toMatchObject({
        message: "Failed to initialize Hindsight bank",
      });
      expect(await Effect.runPromise(hindsight.recall(input))).toEqual([{ id: "fact-2", text: "Retained fact" }]);
      expect(configurations).toBe(2);
    },
  );
});

test.each([
  { statuses: ["completed"], retries: 0, error: null },
  { statuses: ["pending", "processing", "completed"], retries: 0, error: null },
  { statuses: ["failed", "completed"], retries: 1, error: null },
  { statuses: ["failed", "processing", "completed"], retries: 1, error: null },
  { statuses: ["failed", "failed"], retries: 1, error: "failed" },
  { statuses: ["cancelled"], retries: 0, error: "cancelled" },
  { statuses: ["not_found"], retries: 0, error: "not_found" },
  { statuses: ["unexpected"], retries: 0, error: "unexpected" },
])("test_retention_retries_only_one_failed_operation_when_$statuses", async ({ statuses, retries, error }) => {
  let polls = 0;
  let retryRequests = 0;

  await withHindsight(
    (request) => {
      const path = new URL(request.url).pathname;

      if (path.endsWith("/mental-models")) return Response.json({ items: [] });

      if (path.endsWith("/memories")) return Response.json({ operation_ids: ["operation-1"] });

      if (path.endsWith("/retry")) {
        retryRequests += 1;

        return Response.json({});
      }

      if (path.endsWith("/operations/operation-1")) {
        const status = statuses[polls];
        polls += 1;

        return Response.json({ operation_id: "operation-1", status, error_message: "Operation stopped" });
      }

      return Response.json({});
    },
    async (hindsight) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const operation = yield* hindsight
            .retain({
              bankId: "conversation:5:6:0",
              items: [{ content: "Alice chose Postgres" }],
              operationId: "batch-1",
            })
            .pipe(Effect.result, Effect.forkChild);

          yield* TestClock.adjust("10 minutes");

          return yield* Fiber.join(operation);
        }).pipe(Effect.provide(TestClock.layer())),
      );

      if (error === null) expect(result).toMatchObject({ _tag: "Success" });

      if (error !== null) {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { message: `Hindsight operation operation-1 ${error}: Operation stopped` },
        });
      }

      expect(retryRequests).toBe(retries);
      expect(polls).toBe(statuses.length);
    },
  );
});

test.each([
  { status: "processing", deadline: 600_000, message: "Hindsight retain timed out waiting for operations" },
  { status: null, deadline: 60_000, message: "Hindsight operation operation-1 lookup failed" },
])("test_retention_times_out_when_operation_is_$status", async ({ status, deadline, message }) => {
  await withHindsight(
    (request): Response | Promise<Response> => {
      const path = new URL(request.url).pathname;

      if (path.endsWith("/mental-models")) return Response.json({ items: [] });

      if (path.endsWith("/memories")) return Response.json({ operation_ids: ["operation-1"] });

      if (path.endsWith("/operations/operation-1")) {
        return status === null
          ? Promise.withResolvers<Response>().promise
          : Response.json({ operation_id: "operation-1", status });
      }

      return Response.json({});
    },
    async (hindsight) => {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const operation = yield* hindsight
            .retain({
              bankId: "conversation:7:8:0",
              items: [{ content: "Alice chose Postgres" }],
              operationId: "batch-2",
            })
            .pipe(Effect.flip, Effect.forkChild);

          yield* TestClock.adjust(deadline);

          return yield* Fiber.join(operation);
        }).pipe(Effect.provide(TestClock.layer())),
      );

      expect(error).toMatchObject({ message, retryable: true });
    },
  );
});

async function withHindsight(
  handle: (request: Request) => Response | Promise<Response>,
  run: (hindsight: Hindsight.Interface) => Promise<void>,
) {
  const transport = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = new Request(...args);
      request.signal.throwIfAborted();
      const response = await handle(request);
      request.signal.throwIfAborted();

      return response;
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(transport);

  const runtime = ManagedRuntime.make(Hindsight.layer({ apiKey: "test", baseUrl: "https://hindsight.test" }));

  try {
    await run(await runtime.runPromise(Hindsight.Service));
  } finally {
    await runtime.dispose();
    fetchMock.mockRestore();
  }
}
