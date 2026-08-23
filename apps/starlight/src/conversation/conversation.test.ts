import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as Model from "@/ai/model";
import * as Conversation from "@/conversation/conversation";
import * as TelegramDelivery from "@/conversation/delivery";
import * as Database from "@/services/database";
import * as Exa from "@/services/exa";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)(
	"duplicate Telegram delivery creates one immutable input and one lane revision",
	async () => {
		const runtime = ManagedRuntime.make(testLayer(databaseUrl!));
		const assistantId = 8_000_000_091;
		const chatId = -8_000_000_091;

		try {
			await runtime.runPromise(
				Effect.gen(function* verifyAdmission() {
					const conversation = yield* Conversation.Service;
					const database = yield* Database.Service;
					yield* database.query(async (client) => {
						const where = { assistantId: BigInt(assistantId), chatId: BigInt(chatId) };
						await client.conversationContext.deleteMany({ where });
						await client.conversationTranscriptTurn.deleteMany({ where });
						await client.conversationRun.deleteMany({ where });
						await client.conversationInput.deleteMany({ where });
						await client.conversationLane.deleteMany({ where });
						await client.chat.deleteMany({ where: { id: BigInt(chatId) } });
					});
					const input: Conversation.AdmissionInput = {
						chatTitle: "Phase 2 test",
						chatUsername: null,
						key: { assistantId, chatId, threadKey: 17 },
						payload: {
							addressed: true,
							date: 1_700_000_000,
							editDate: null,
							forwardOrigin: null,
							messageId: 41,
							repliedText: null,
							replyToMessageId: null,
							senderFirstName: "Alice",
							senderId: 42,
							senderUsername: "alice",
							text: "@starlight hello",
						},
						updateId: 91,
					};

					const first = yield* conversation.admit(input);
					const duplicate = yield* conversation.admit(input);
					const persisted = yield* database.query(async (client) => {
						const key = {
							assistantId: BigInt(assistantId),
							chatId: BigInt(chatId),
							threadKey: 17,
						};
						return {
							count: await client.conversationInput.count({ where: key }),
							lane: await client.conversationLane.findUniqueOrThrow({
								where: { assistantId_chatId_threadKey: key },
							}),
							outbox: await client.conversationWakeOutbox.findUniqueOrThrow({
								where: { assistantId_chatId_threadKey: key },
							}),
						};
					});

					expect(first.duplicate).toBe(false);
					expect(duplicate.duplicate).toBe(true);
					expect(duplicate.inputId).toBe(first.inputId);
					expect(persisted.count).toBe(1);
					expect(persisted.lane.pendingRevision).toBe(1);
					expect(persisted.outbox.pendingRevision).toBe(1);
				}),
			);
		} finally {
			await runtime.runPromise(
				Effect.gen(function* cleanup() {
					const database = yield* Database.Service;
					yield* database.query(async (client) => {
						const where = { assistantId: BigInt(assistantId), chatId: BigInt(chatId) };
						await client.conversationContext.deleteMany({ where });
						await client.conversationTranscriptTurn.deleteMany({ where });
						await client.conversationRun.deleteMany({ where });
						await client.conversationInput.deleteMany({ where });
						await client.conversationLane.deleteMany({ where });
						await client.chat.deleteMany({ where: { id: BigInt(chatId) } });
					});
				}),
			);
			await runtime.dispose();
		}
	},
);

test.skipIf(!databaseUrl)(
	"unknown delivery retries once without regenerating the model output",
	async () => {
		const model: Model.Interface = {
			generate: <Output>() =>
				Effect.succeed({
					finishReason: "stop",
					output: { replies: [{ replyTo: 61, text: "Hi", type: "text" }] } as Output,
					steps: [],
					toolEvents: [],
					transcript: [{ text: "Hi", type: "assistant-text" }],
					usage: {
						billing: {
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							costUsd: 0,
							inputTokens: 10,
							outputTokens: 2,
							reasoningTokens: 0,
						},
						contextInputTokens: 10,
						steps: [],
						validForCostThresholds: true,
					},
				}),
		};
		const deliveryResults = [
			Effect.fail(
				new TelegramDelivery.DeliveryError({
					cause: new Error("Telegram timeout"),
					message: "Telegram delivery outcome is unknown",
					outcomeUnknown: true,
					retryable: true,
				}),
			),
			Effect.fail(
				new TelegramDelivery.DeliveryError({
					cause: new Error("Telegram unavailable"),
					message: "Telegram rejected delivery",
					outcomeUnknown: false,
					retryable: true,
				}),
			),
			Effect.fail(
				new TelegramDelivery.DeliveryError({
					cause: new Error("Telegram timeout"),
					message: "Telegram delivery outcome is unknown",
					outcomeUnknown: true,
					retryable: true,
				}),
			),
		];
		const delivery: TelegramDelivery.Interface = {
			deliver: () => deliveryResults.shift()!,
		};
		const runtime = ManagedRuntime.make(testLayer(databaseUrl!, model, delivery));
		const assistantId = 8_000_000_094;
		const chatId = -8_000_000_094;

		try {
			await runtime.runPromise(
				Effect.gen(function* admit() {
					const conversation = yield* Conversation.Service;
					const database = yield* Database.Service;
					yield* database.query(async (client) => {
						const where = { assistantId: BigInt(assistantId), chatId: BigInt(chatId) };
						await client.conversationContext.deleteMany({ where });
						await client.conversationTranscriptTurn.deleteMany({ where });
						await client.conversationRun.deleteMany({ where });
						await client.conversationInput.deleteMany({ where });
						await client.conversationLane.deleteMany({ where });
						await client.chat.deleteMany({ where: { id: BigInt(chatId) } });
					});
					yield* conversation.admit({
						chatTitle: "Phase 2 retry test",
						chatUsername: null,
						key: { assistantId, chatId, threadKey: 0 },
						payload: {
							addressed: true,
							date: 1_700_000_000,
							editDate: null,
							forwardOrigin: null,
							messageId: 61,
							repliedText: null,
							replyToMessageId: null,
							senderFirstName: "Alice",
							senderId: 42,
							senderUsername: "alice",
							text: "@starlight hello",
						},
						updateId: 111,
					});
					yield* database.query((client) =>
						client.conversationLane.update({
							where: {
								assistantId_chatId_threadKey: {
									assistantId: BigInt(assistantId),
									chatId: BigInt(chatId),
									threadKey: 0,
								},
							},
							data: { nextWakeAt: new Date(0) },
						}),
					);
				}),
			);

			await expect(
				runtime.runPromise(
					Effect.gen(function* firstAttempt() {
						const conversation = yield* Conversation.Service;
						return yield* conversation.drain({
							key: { assistantId, chatId, threadKey: 0 },
						});
					}),
				),
			).rejects.toBeInstanceOf(Conversation.ConversationError);
			const resumed = await runtime.runPromise(
				Effect.gen(function* resume() {
					const conversation = yield* Conversation.Service;
					return yield* conversation.drain({
						key: { assistantId, chatId, threadKey: 0 },
					});
				}),
			);
			const persisted = await runtime.runPromise(
				Effect.gen(function* inspect() {
					const database = yield* Database.Service;
					return yield* database.query((client) =>
						client.conversationRun.findFirstOrThrow({
							where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
							include: { actions: true },
						}),
					);
				}),
			);

			expect(resumed.kind).toBe("completed");
			expect(persisted.attemptCount).toBe(1);
			expect(persisted.status).toBe("finalized");
			expect(persisted.actions[0]?.attemptCount).toBe(3);
			expect(persisted.actions[0]?.deliveryStatus).toBe("failed");
			expect(persisted.actions[0]?.unknownRetryCount).toBe(1);
		} finally {
			await runtime.runPromise(
				Effect.gen(function* cleanup() {
					const database = yield* Database.Service;
					yield* database.query(async (client) => {
						const where = { assistantId: BigInt(assistantId), chatId: BigInt(chatId) };
						await client.conversationContext.deleteMany({ where });
						await client.conversationTranscriptTurn.deleteMany({ where });
						await client.conversationRun.deleteMany({ where });
						await client.conversationInput.deleteMany({ where });
						await client.conversationLane.deleteMany({ where });
						await client.chat.deleteMany({ where: { id: BigInt(chatId) } });
					});
				}),
			);
			await runtime.dispose();
		}
	},
);

test.skipIf(!databaseUrl)(
	"an edit in the original message second creates a correction revision",
	async () => {
		const runtime = ManagedRuntime.make(testLayer(databaseUrl!));
		const assistantId = 8_000_000_095;
		const chatId = -8_000_000_095;

		try {
			await runtime.runPromise(
				Effect.gen(function* verifyEditRevision() {
					const conversation = yield* Conversation.Service;
					const database = yield* Database.Service;
					yield* database.query(async (client) => {
						const where = { assistantId: BigInt(assistantId), chatId: BigInt(chatId) };
						await client.conversationContext.deleteMany({ where });
						await client.conversationTranscriptTurn.deleteMany({ where });
						await client.conversationRun.deleteMany({ where });
						await client.conversationInput.deleteMany({ where });
						await client.conversationLane.deleteMany({ where });
						await client.chat.deleteMany({ where: { id: BigInt(chatId) } });
					});
					const original: Conversation.AdmissionInput = {
						chatTitle: "Phase 2 edit test",
						chatUsername: null,
						key: { assistantId, chatId, threadKey: 0 },
						payload: {
							addressed: true,
							date: 1_700_000_000,
							editDate: null,
							forwardOrigin: null,
							messageId: 71,
							repliedText: null,
							replyToMessageId: null,
							senderFirstName: "Alice",
							senderId: 42,
							senderUsername: "alice",
							text: "Original",
						},
						updateId: 121,
					};
					const edit: Conversation.AdmissionInput = {
						...original,
						payload: {
							...original.payload,
							editDate: 1_700_000_000,
							text: "Corrected",
						},
						updateId: 122,
					};

					const admittedOriginal = yield* conversation.admit(original);
					const admittedEdit = yield* conversation.admit(edit);
					const revisions = yield* database.query((client) =>
						client.conversationInput.findMany({
							where: { assistantId: BigInt(assistantId), chatId: BigInt(chatId) },
							orderBy: { admittedRevision: "asc" },
							select: { sourceRevision: true },
						}),
					);

					expect(admittedOriginal.pendingRevision).toBe(1);
					expect(admittedEdit.pendingRevision).toBe(2);
					expect(revisions).toHaveLength(2);
					expect(revisions[0]?.sourceRevision.startsWith("original:")).toBe(true);
					expect(revisions[1]?.sourceRevision.startsWith("edit:")).toBe(true);
				}),
			);
		} finally {
			await runtime.runPromise(
				Effect.gen(function* cleanup() {
					const database = yield* Database.Service;
					yield* database.query(async (client) => {
						const where = { assistantId: BigInt(assistantId), chatId: BigInt(chatId) };
						await client.conversationContext.deleteMany({ where });
						await client.conversationTranscriptTurn.deleteMany({ where });
						await client.conversationRun.deleteMany({ where });
						await client.conversationInput.deleteMany({ where });
						await client.conversationLane.deleteMany({ where });
						await client.chat.deleteMany({ where: { id: BigInt(chatId) } });
					});
				}),
			);
			await runtime.dispose();
		}
	},
);

function testLayer(
	connectionString: string,
	model: Model.Interface = unavailableModel,
	delivery: TelegramDelivery.Interface = unavailableDelivery,
) {
	const infrastructure = Layer.mergeAll(
		Database.layer(connectionString),
		Layer.succeed(Model.Service)(model),
		Layer.succeed(Exa.Service)(disabledExa),
		Layer.succeed(TelegramDelivery.Service)(delivery),
		Conversation.optionsLayer({
			affinitySecret: "test-affinity-secret-with-at-least-32-characters",
			leaseMs: 180_000,
			maxWaitMs: 3000,
			quietMs: 1000,
		}),
	);
	return Conversation.layer.pipe(Layer.provideMerge(infrastructure));
}

const disabledExa: Exa.Interface = {
	isEnabled: () => false,
	lookup: () => Effect.succeed(null),
	search: () => Effect.succeed([]),
};

const unavailableModel: Model.Interface = {
	generate: () => Effect.die(new Error("Model must not run during admission")),
};

const unavailableDelivery: TelegramDelivery.Interface = {
	deliver: () => Effect.die(new Error("Telegram must not run during admission")),
};
