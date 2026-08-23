import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as ConversationContext from "@/context/context";
import * as Prompt from "@/context/prompt";
import * as Database from "@/services/database";
import * as Exa from "@/services/exa";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)(
	"repeated finalization appends one immutable context sequence",
	async () => {
		const runtime = ManagedRuntime.make(
			ConversationContext.layer.pipe(
				Layer.provideMerge(
					Layer.mergeAll(Database.layer(databaseUrl!), Layer.succeed(Exa.Service)(disabledExa)),
				),
			),
		);
		const assistantId = 8_000_000_092n;
		const chatId = -8_000_000_092n;
		let runId = "";

		try {
			await runtime.runPromise(
				Effect.gen(function* verifyContextAppend() {
					const context = yield* ConversationContext.Service;
					const database = yield* Database.Service;
					runId = yield* database.query(async (client) => {
						await client.conversationContext.deleteMany({ where: { assistantId, chatId } });
						await client.conversationTranscriptTurn.deleteMany({
							where: { assistantId, chatId },
						});
						await client.conversationRun.deleteMany({ where: { assistantId, chatId } });
						await client.conversationInput.deleteMany({ where: { assistantId, chatId } });
						await client.conversationLane.deleteMany({ where: { assistantId, chatId } });
						await client.conversationLane.create({
							data: {
								assistantId,
								chatId,
								pendingRevision: 1,
								processedRevision: 1,
								threadKey: 0,
							},
						});
						const input = await client.conversationInput.create({
							data: {
								admittedRevision: 1,
								assistantId,
								chatId,
								payload: {
									addressed: true,
									date: 1_700_000_000,
									editDate: null,
									forwardOrigin: null,
									messageId: 51,
									repliedText: null,
									replyToMessageId: null,
									senderFirstName: "Alice",
									senderId: 42,
									senderUsername: "alice",
									text: "Hello",
								},
								senderTelegramId: 42n,
								sourceMessageId: 51,
								sourceRevision: "51:1700000000",
								sourceUpdateId: 101,
								threadKey: 0,
							},
						});
						const run = await client.conversationRun.create({
							data: {
								actions: {
									create: {
										deliveryStatus: "delivered",
										ordinal: 0,
										payload: { replyTo: 51, text: "Hi", type: "text" },
										targetMessageId: 51,
										type: "text",
									},
								},
								assistantId,
								chatId,
								eligibilityReason: "direct",
								fencingToken: 1n,
								finalizedAt: new Date(),
								inputEndRevision: 1,
								inputStartRevision: 1,
								inputs: { create: { inputId: input.id, ordinal: 0 } },
								modelProfileFingerprint: new Bun.CryptoHasher("sha256")
									.update(Prompt.renderEnvelope({ webLookupEnabled: false }))
									.digest("hex"),
								replyEligible: true,
								status: "finalized",
								threadKey: 0,
							},
						});
						return run.id;
					});

					const first = yield* context.appendFinalized(runId);
					const repeated = yield* context.appendFinalized(runId);
					const counts = yield* database.query(async (client) => ({
						contextTurns: await client.conversationContextTurn.count({
							where: { contextId: first.contextId },
						}),
						transcriptTurns: await client.conversationTranscriptTurn.count({
							where: { runId },
						}),
					}));

					expect(first.appendedTurns).toBe(2);
					expect(repeated.appendedTurns).toBe(0);
					expect(repeated.terminalPrefixHash).toBe(first.terminalPrefixHash);
					expect(counts.contextTurns).toBe(2);
					expect(counts.transcriptTurns).toBe(2);
				}),
			);
		} finally {
			await runtime.runPromise(
				Effect.gen(function* cleanup() {
					const database = yield* Database.Service;
					yield* database.query(async (client) => {
						await client.conversationContext.deleteMany({ where: { assistantId, chatId } });
						await client.conversationTranscriptTurn.deleteMany({ where: { assistantId, chatId } });
						await client.conversationRun.deleteMany({ where: { assistantId, chatId } });
						await client.conversationInput.deleteMany({ where: { assistantId, chatId } });
						await client.conversationLane.deleteMany({ where: { assistantId, chatId } });
					});
				}),
			);
			await runtime.dispose();
		}
	},
);

const disabledExa: Exa.Interface = {
	isEnabled: () => false,
	lookup: () => Effect.succeed(null),
	search: () => Effect.succeed([]),
};
