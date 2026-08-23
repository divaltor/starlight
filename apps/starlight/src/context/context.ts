import type {
	ConversationContextRole,
	ConversationTranscriptKind,
	Prisma,
} from "@starlight/utils/generated/prisma/client";
import { Context, Effect, Layer, Schema } from "effect";
import * as ChatReply from "@/ai/chat-reply";
import type * as Model from "@/ai/model";
import * as Prompt from "@/context/prompt";
import type * as ConversationKey from "@/conversation/key";
import * as Database from "@/services/database";
import * as Exa from "@/services/exa";

export interface PreparedContextRequest {
	readonly cacheBase: string;
	readonly estimatedTokens: {
		readonly base: number;
		readonly current: number;
		readonly finalized: number;
		readonly total: number;
	};
	readonly instructions: string;
	readonly messages: readonly Model.Message[];
	readonly profileFingerprint: string;
	readonly requestHash: string;
	readonly terminalPrefixHash: string;
	readonly webLookupEnabled: boolean;
}

export interface AppendResult {
	readonly appendedTurns: number;
	readonly contextId: string;
	readonly terminalPrefixHash: string;
}

export interface ProfileTransitionInput {
	readonly key: ConversationKey.Value;
	readonly reason: string;
	readonly webLookupEnabled: boolean;
}

export interface ContextGeneration {
	readonly generation: number;
	readonly id: string;
	readonly profileFingerprint: string;
}

export class ContextError extends Schema.TaggedError<ContextError>()("ContextError", {
	cause: Schema.optional(Schema.Defect()),
	message: Schema.String,
}) {}

export interface Interface {
	readonly appendFinalized: (runId: string) => Effect.Effect<AppendResult, ContextError>;
	readonly prepare: (runId: string) => Effect.Effect<PreparedContextRequest, ContextError>;
	readonly transitionProfile: (
		input: ProfileTransitionInput,
	) => Effect.Effect<ContextGeneration, ContextError>;
}

export class Service extends Context.Service<Service, Interface>()(
	"starlight/ConversationContext",
) {}

export const layer: Layer.Layer<Service, never, Database.Service | Exa.Service> = Layer.effect(
	Service,
	Effect.gen(function* layer() {
		const database = yield* Database.Service;
		const exa = yield* Exa.Service;

		const appendFinalized = Effect.fn("ConversationContext.appendFinalized")(
			function* appendFinalized(runId: string) {
				return yield* database
					.transaction(async (transaction) => {
						const run = await transaction.conversationRun.findUniqueOrThrow({
							where: { id: runId },
							include: {
								actions: { orderBy: { ordinal: "asc" } },
								inputs: { include: { input: true }, orderBy: { ordinal: "asc" } },
								toolCalls: { orderBy: { createdAt: "asc" } },
							},
						});
						if (run.status !== "finalized" && run.status !== "failed") {
							throw new Error("Run is not terminal");
						}
						const key = {
							assistantId: run.assistantId,
							chatId: run.chatId,
							threadKey: run.threadKey,
						};
						await lockLane(transaction, key);
						const existingRunTurns = await transaction.conversationTranscriptTurn.count({
							where: { runId },
						});
						// One Prisma transaction connection must execute its queries serially.
						// oxlint-disable-next-line react-doctor/server-sequential-independent-await
						const context = await ensureActiveContext(transaction, key, exa.isEnabled());
						if (existingRunTurns > 0) {
							const terminal = await transaction.conversationContextTurn.findFirst({
								where: { contextId: context.id },
								orderBy: { ordinal: "desc" },
							});
							return {
								appendedTurns: 0,
								contextId: context.id,
								terminalPrefixHash: terminal?.rollingPrefixHash ?? context.basePrefixHash,
							};
						}

						const existingTurns = await transaction.conversationTranscriptTurn.findMany({
							where: key,
							orderBy: { ordinal: "asc" },
						});
						const knownMessageIds = collectMessageIds(existingTurns.map((turn) => turn.content));
						const projections = createProjections(run, knownMessageIds);
						const firstOrdinal = (existingTurns.at(-1)?.ordinal ?? 0) + 1;
						const contextTurns = await transaction.conversationContextTurn.findMany({
							where: { contextId: context.id },
							orderBy: { ordinal: "asc" },
						});
						let rollingHash = contextTurns.at(-1)?.rollingPrefixHash ?? context.basePrefixHash;
						let estimatedTokens = context.estimatedStableTokens;

						for (const [index, projection] of projections.entries()) {
							const ordinal = firstOrdinal + index;
							const transcript = await transaction.conversationTranscriptTurn.create({
								data: {
									...key,
									content: projection.content,
									idempotencyKey: `${runId}:${projection.key}`,
									kind: projection.kind,
									ordinal,
									runId,
									sourceReferences: projection.sourceReferences,
									visibility: projection.visibility,
								},
							});
							const rendered = Prompt.renderTurn({
								content: Prompt.canonicalEncode(projection.content),
								role: projection.role,
							});
							const segment = Prompt.extendPrefix(rollingHash, rendered);
							rollingHash = segment.rollingPrefixHash;
							estimatedTokens += segment.estimatedTokens;
							await transaction.conversationContextTurn.create({
								data: {
									contextId: context.id,
									estimatedTokens: segment.estimatedTokens,
									ordinal: contextTurns.length + index + 1,
									renderedContent: rendered,
									renderVersion: Prompt.renderVersion,
									role: projection.role,
									rollingPrefixHash: segment.rollingPrefixHash,
									segmentHash: segment.segmentHash,
									transcriptTurnId: transcript.id,
								},
							});
						}
						await transaction.conversationContext.update({
							where: { id: context.id },
							data: { estimatedStableTokens: estimatedTokens },
						});

						return {
							appendedTurns: projections.length,
							contextId: context.id,
							terminalPrefixHash: rollingHash,
						};
					})
					.pipe(Effect.mapError(failed("Failed to append finalized context")));
			},
		);

		const prepare = Effect.fn("ConversationContext.prepare")(function* prepare(runId: string) {
			return yield* database
				.transaction(async (transaction) => {
					const run = await transaction.conversationRun.findUniqueOrThrow({
						where: { id: runId },
						include: {
							inputs: { include: { input: true }, orderBy: { ordinal: "asc" } },
						},
					});
					const key = {
						assistantId: run.assistantId,
						chatId: run.chatId,
						threadKey: run.threadKey,
					};
					await lockLane(transaction, key);
					const context = await ensureActiveContext(transaction, key, exa.isEnabled());
					if (context.modelProfileFingerprint !== run.modelProfileFingerprint) {
						throw new Error("Active context profile does not match the prepared run");
					}
					const turns = await transaction.conversationContextTurn.findMany({
						where: { contextId: context.id },
						orderBy: { ordinal: "asc" },
						include: { transcriptTurn: true },
					});
					const knownMessageIds = collectMessageIds(
						turns.map((turn) => turn.transcriptTurn.content),
					);
					// Dot notation is the project convention; destructuring is intentionally disabled.
					// oxlint-disable-next-line prefer-destructuring
					const currentDate = Schema.decodeUnknownSync(PreparedRequestMetadata)(
						run.preparedRequest,
					).currentDate;
					/* oxlint-disable sonarjs/no-nested-functions -- reply projection stays at its context boundary. */
					const current = [
						{
							role: "user" as const,
							text: `TRUSTED REQUEST METADATA\nCurrent date: ${currentDate}`,
						},
						...run.inputs.map((runInput) => {
							const payload = Schema.decodeUnknownSync(StoredPayload)(runInput.input.payload);
							return {
								role: "user" as const,
								text: Prompt.renderLiveMessage(payload, (replyToMessageId) => {
									if (knownMessageIds.has(replyToMessageId)) {
										return `REPLIES TO MESSAGE #${replyToMessageId}\n`;
									}
									if (payload.repliedText) {
										return `REPLIED MESSAGE #${replyToMessageId}: ${payload.repliedText}\n`;
									}
									return `REPLIED MESSAGE #${replyToMessageId}: [target unavailable]\n`;
								}),
							};
						}),
					];
					/* oxlint-enable sonarjs/no-nested-functions */
					const finalized = turns.map((turn) => ({
						role: turn.role === "assistant" ? ("assistant" as const) : ("user" as const),
						text: turn.renderedContent,
					}));
					const messages = [...finalized, ...current];
					const cacheBase = context.frozenMemory;
					const envelope = Schema.decodeUnknownSync(Prompt.FrozenEnvelope)(context.stableEnvelope);
					const finalizedTokens = turns.reduce((total, turn) => total + turn.estimatedTokens, 0);
					const currentTokens = current.reduce(
						(total, message) => total + Math.ceil(message.text.length / 4),
						0,
					);
					const baseTokens =
						Math.ceil(context.stableEnvelope.length / 4) + Math.ceil(cacheBase.length / 4);
					const terminalPrefixHash = turns.at(-1)?.rollingPrefixHash ?? context.basePrefixHash;
					return {
						cacheBase,
						estimatedTokens: {
							base: baseTokens,
							current: currentTokens,
							finalized: finalizedTokens,
							total: baseTokens + finalizedTokens + currentTokens,
						},
						instructions: envelope.instructions,
						messages,
						profileFingerprint: context.modelProfileFingerprint,
						requestHash: new Bun.CryptoHasher("sha256")
							.update(Prompt.canonicalEncode({ cacheBase, messages, terminalPrefixHash }))
							.digest("hex"),
						terminalPrefixHash,
						webLookupEnabled: envelope.tools.length > 0,
					};
				})
				.pipe(Effect.mapError(failed("Failed to prepare context request")));
		});

		const transitionProfile = Effect.fn("ConversationContext.transitionProfile")(
			function* transitionProfile(input: ProfileTransitionInput) {
				return yield* database
					.transaction(async (transaction) => {
						const key = {
							assistantId: BigInt(input.key.assistantId),
							chatId: BigInt(input.key.chatId),
							threadKey: input.key.threadKey,
						};
						await lockLane(transaction, key);
						const parent = await transaction.conversationContext.findFirstOrThrow({
							where: { ...key, status: "active" },
						});
						const envelope = Prompt.renderEnvelope({
							webLookupEnabled: input.webLookupEnabled,
						});
						const memory = parent.frozenMemory;
						await transaction.conversationContext.update({
							where: { id: parent.id },
							data: {
								activeKey: null,
								sealedAt: new Date(),
								status: "checkpointing",
							},
						});
						const child = await transaction.conversationContext.create({
							data: {
								...key,
								activeKey: `v1/${input.key.assistantId}/${input.key.chatId}/${input.key.threadKey}`,
								generation: parent.generation + 1,
								modelProfileFingerprint: Prompt.profileFingerprint(input.webLookupEnabled),
								parentContextId: parent.id,
								resetReason: input.reason,
								...stableSeed(envelope, memory),
							},
						});
						// One Prisma transaction connection must execute its queries serially.
						// oxlint-disable-next-line react-doctor/server-sequential-independent-await
						const transcript = await transaction.conversationTranscriptTurn.findMany({
							where: key,
							orderBy: { ordinal: "asc" },
						});
						let rollingHash = child.basePrefixHash;
						let estimatedTokens = child.estimatedStableTokens;
						for (const [index, turn] of transcript.entries()) {
							const role = ROLE_BY_KIND[turn.kind];
							const rendered = Prompt.renderTurn({
								content: Prompt.canonicalEncode(turn.content),
								role,
							});
							const segment = Prompt.extendPrefix(rollingHash, rendered);
							rollingHash = segment.rollingPrefixHash;
							estimatedTokens += segment.estimatedTokens;
							await transaction.conversationContextTurn.create({
								data: {
									contextId: child.id,
									estimatedTokens: segment.estimatedTokens,
									ordinal: index + 1,
									renderedContent: rendered,
									renderVersion: Prompt.renderVersion,
									role,
									rollingPrefixHash: segment.rollingPrefixHash,
									segmentHash: segment.segmentHash,
									transcriptTurnId: turn.id,
								},
							});
						}
						await transaction.conversationContext.update({
							where: { id: parent.id },
							data: { status: "superseded" },
						});
						await transaction.conversationContext.update({
							where: { id: child.id },
							data: { estimatedStableTokens: estimatedTokens },
						});
						await transaction.conversationLane.update({
							where: { assistantId_chatId_threadKey: key },
							data: { activeContextId: child.id },
						});

						return {
							generation: child.generation,
							id: child.id,
							profileFingerprint: child.modelProfileFingerprint,
						};
					})
					.pipe(Effect.mapError(failed("Failed to transition context profile")));
			},
		);

		return Service.of({ appendFinalized, prepare, transitionProfile });
	}),
);

type Key = Pick<Prisma.ConversationLaneGetPayload<object>, "assistantId" | "chatId" | "threadKey">;

const failed =
	(message: string) =>
	(cause: unknown): ContextError =>
		new ContextError({ cause, message });

const ROLE_BY_KIND: Record<ConversationTranscriptKind, ConversationContextRole> = {
	assistantIgnore: "assistant",
	assistantMessage: "assistant",
	editCorrection: "user",
	linkedReplyContext: "user",
	mediaProjection: "user",
	systemEvent: "system",
	toolCall: "assistant",
	toolError: "tool",
	toolResult: "tool",
	userMessage: "user",
};

function collectMessageIds(contents: readonly Prisma.JsonValue[]): Set<number> {
	return new Set(
		contents.flatMap((content) => {
			if (!content || typeof content !== "object" || Array.isArray(content)) return [];
			return [
				...(typeof content.messageId === "number" ? [content.messageId] : []),
				...(typeof content.telegramMessageId === "number" ? [content.telegramMessageId] : []),
			];
		}),
	);
}

// The seed fields derive the context base from the frozen envelope and memory;
// both creation paths must produce byte-identical values or the two chains diverge.
function stableSeed(envelope: string, memory: string) {
	return {
		basePrefixHash: new Bun.CryptoHasher("sha256")
			.update(`${envelope.length}:${envelope}${memory.length}:${memory}`)
			.digest("hex"),
		estimatedStableTokens: Math.ceil(envelope.length / 4) + Math.ceil(memory.length / 4),
		frozenMemory: memory,
		frozenMemoryHash: new Bun.CryptoHasher("sha256").update(memory).digest("hex"),
		stableEnvelope: envelope,
		stableEnvelopeHash: new Bun.CryptoHasher("sha256").update(envelope).digest("hex"),
	};
}

interface Projection {
	readonly content: Prisma.InputJsonObject;
	readonly key: string;
	readonly kind: ConversationTranscriptKind;
	readonly role: ConversationContextRole;
	readonly sourceReferences: Prisma.InputJsonObject;
	readonly visibility: string;
}

interface ProjectionRun {
	readonly errorTag: string | null;
	readonly id: string;
	readonly status: string;
	readonly actions: readonly {
		readonly deliveryStatus: string;
		readonly ordinal: number;
		readonly payload: Prisma.JsonValue;
		readonly telegramMessageId: number | null;
		readonly type: string;
	}[];
	readonly inputs: readonly {
		readonly input: {
			readonly id: bigint;
			readonly mediaReferences: Prisma.JsonValue | null;
			readonly payload: Prisma.JsonValue;
		};
	}[];
	readonly toolCalls: readonly {
		readonly errorMessage: string | null;
		readonly input: Prisma.JsonValue;
		readonly providerCallId: string;
		readonly result: Prisma.JsonValue | null;
		readonly status: string;
		readonly toolName: string;
	}[];
}

async function ensureActiveContext(
	transaction: Prisma.TransactionClient,
	key: Key,
	webLookupEnabled: boolean,
) {
	const existing = await transaction.conversationContext.findFirst({
		where: { ...key, status: "active" },
	});
	if (existing) return existing;

	const envelope = Prompt.renderEnvelope({ webLookupEnabled });
	const memory = Prompt.renderMemory("");
	const created = await transaction.conversationContext.create({
		data: {
			...key,
			activeKey: `v1/${Number(key.assistantId)}/${Number(key.chatId)}/${key.threadKey}`,
			generation: 1,
			modelProfileFingerprint: Prompt.profileFingerprint(webLookupEnabled),
			...stableSeed(envelope, memory),
		},
	});
	await transaction.conversationLane.update({
		where: { assistantId_chatId_threadKey: key },
		data: { activeContextId: created.id },
	});
	return created;
}

function createProjections(run: ProjectionRun, knownMessageIds: ReadonlySet<number>): Projection[] {
	const seenMessageIds = new Set(knownMessageIds);
	const userTurns = run.inputs.flatMap((runInput, index) => {
		const payload = Schema.decodeUnknownSync(StoredPayload)(runInput.input.payload);
		// Dot notation is the project convention; destructuring is intentionally disabled.
		// oxlint-disable-next-line prefer-destructuring, sonarjs/destructuring-assignment-syntax
		const messageId = payload.messageId;
		// oxlint-disable-next-line prefer-destructuring
		const replyToMessageId = payload.replyToMessageId;
		const linked =
			replyToMessageId !== null && !seenMessageIds.has(replyToMessageId) && payload.repliedText
				? [
						{
							content: {
								messageId: replyToMessageId,
								text: payload.repliedText,
							} as Prisma.InputJsonObject,
							key: `input:${runInput.input.id}:linked`,
							kind: "linkedReplyContext" as const,
							role: "user" as const,
							sourceReferences: { inputId: runInput.input.id.toString() },
							visibility: "linked-context",
						},
					]
				: [];
		if (linked.length > 0 && replyToMessageId !== null) seenMessageIds.add(replyToMessageId);
		seenMessageIds.add(messageId);
		const media = runInput.input.mediaReferences
			? [
					{
						content: {
							references: runInput.input.mediaReferences as Prisma.InputJsonValue,
						},
						key: `input:${runInput.input.id}:media`,
						kind: "mediaProjection" as const,
						role: "user" as const,
						sourceReferences: { inputId: runInput.input.id.toString() },
						visibility: "conversation",
					},
				]
			: [];
		return [
			...linked,
			{
				content: {
					date: payload.date,
					forwardOrigin: payload.forwardOrigin,
					messageId,
					replyToMessageId,
					replyTargetUnavailable: replyToMessageId !== null && payload.repliedText === null,
					senderFirstName: payload.senderFirstName,
					senderId: payload.senderId,
					text: payload.text,
				},
				key: `input:${runInput.input.id}`,
				kind: payload.editDate === null ? ("userMessage" as const) : ("editCorrection" as const),
				role: "user" as const,
				sourceReferences: {
					inputId: runInput.input.id.toString(),
					messageId,
				},
				visibility: "conversation",
			},
			...media,
		].map((projection, projectionIndex) => ({
			...projection,
			key: `${index}:${projectionIndex}:${projection.key}`,
		}));
	});
	const toolTurns = run.toolCalls.flatMap((tool, index) => [
		{
			content: { input: tool.input, name: tool.toolName } as Prisma.InputJsonObject,
			key: `tool:${index}:call:${tool.providerCallId}`,
			kind: "toolCall" as const,
			role: "assistant" as const,
			sourceReferences: { providerCallId: tool.providerCallId },
			visibility: "conversation",
		},
		{
			content: (tool.status === "completed"
				? { name: tool.toolName, result: tool.result }
				: { error: tool.errorMessage, name: tool.toolName }) as Prisma.InputJsonObject,
			key: `tool:${index}:result:${tool.providerCallId}`,
			kind: tool.status === "completed" ? ("toolResult" as const) : ("toolError" as const),
			role: "tool" as const,
			sourceReferences: { providerCallId: tool.providerCallId },
			visibility: "conversation",
		},
	]);
	const assistantTurns = run.actions.flatMap((action) => {
		if (action.deliveryStatus !== "delivered") return [];
		const content = ChatReply.actionSchema.parse(action.payload);
		return [
			{
				content: {
					action: content as Prisma.InputJsonObject,
					telegramMessageId: action.telegramMessageId,
				},
				key: `action:${action.ordinal}`,
				kind:
					action.type === "ignore" ? ("assistantIgnore" as const) : ("assistantMessage" as const),
				role: "assistant" as const,
				sourceReferences: { actionOrdinal: action.ordinal },
				visibility: action.type === "ignore" ? "internal" : "delivered",
			},
		];
	});
	const failureTurns: Projection[] =
		run.status === "failed"
			? [
					{
						content: { category: run.errorTag ?? "model-failure" },
						key: "terminal-failure",
						kind: "systemEvent",
						role: "system",
						sourceReferences: { runId: run.id },
						visibility: "internal",
					},
				]
			: [];

	return [...userTurns, ...toolTurns, ...assistantTurns, ...failureTurns];
}

async function lockLane(transaction: Prisma.TransactionClient, key: Key) {
	await transaction.$queryRaw`
		SELECT 1 FROM conversation_lanes
		WHERE assistant_id = ${key.assistantId}
			AND chat_id = ${key.chatId}
			AND thread_key = ${key.threadKey}
		FOR UPDATE
	`;
}

const StoredPayload = Schema.Struct({
	date: Schema.Int,
	editDate: Schema.NullOr(Schema.Int),
	forwardOrigin: Schema.NullOr(Schema.String),
	messageId: Schema.Int,
	repliedText: Schema.NullOr(Schema.String),
	replyToMessageId: Schema.NullOr(Schema.Int),
	senderFirstName: Schema.String,
	senderId: Schema.NullOr(Schema.Int),
	text: Schema.String,
});

const PreparedRequestMetadata = Schema.Struct({ currentDate: Schema.String });
