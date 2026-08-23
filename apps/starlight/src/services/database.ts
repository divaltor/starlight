import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@starlight/utils/generated/prisma/client";
import type { Prisma } from "@starlight/utils/generated/prisma/client";
import { Context, Effect, Layer, Schema } from "effect";

export class QueryError extends Schema.TaggedError<QueryError>()("QueryError", {
	cause: Schema.Defect(),
	message: Schema.String,
}) {}

export class TransactionError extends Schema.TaggedError<TransactionError>()("TransactionError", {
	cause: Schema.Defect(),
	message: Schema.String,
}) {}

export class StartupError extends Schema.TaggedError<StartupError>()("DatabaseStartupError", {
	cause: Schema.Defect(),
	message: Schema.String,
}) {}

export interface Interface {
	readonly query: <A>(
		operation: (client: PrismaClient) => Promise<A>,
	) => Effect.Effect<A, QueryError>;
	readonly transaction: <A>(
		operation: (client: Prisma.TransactionClient) => Promise<A>,
	) => Effect.Effect<A, TransactionError>;
}

export class Service extends Context.Service<Service, Interface>()("starlight/Database") {}

export function layer(connectionString: string): Layer.Layer<Service, StartupError> {
	return Layer.effect(
		Service,
		Effect.gen(function* make() {
			const client = new PrismaClient({
				adapter: new PrismaPg({ connectionString }),
			});
			yield* Effect.acquireRelease(
				Effect.tryPromise({
					try: () => client.$connect(),
					catch: (cause) => new StartupError({ cause, message: "Failed to connect to PostgreSQL" }),
				}),
				() => Effect.promise(() => client.$disconnect()),
			);

			const query: Interface["query"] = (operation) =>
				Effect.tryPromise({
					try: () => operation(client),
					catch: (cause) => new QueryError({ cause, message: "Database query failed" }),
				});
			const transaction: Interface["transaction"] = (operation) =>
				Effect.tryPromise({
					try: () => client.$transaction(operation),
					catch: (cause) => new TransactionError({ cause, message: "Database transaction failed" }),
				}).pipe(Effect.uninterruptible);

			return Service.of({ query, transaction });
		}),
	);
}
