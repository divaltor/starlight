import type {
  ConversationContextRole,
  ConversationTranscriptKind,
  Prisma,
} from "@starlight/utils/generated/prisma/client";
import { Schema } from "effect";
import { ChatReply } from "@/ai/chat-reply";
import { StoredPayloadSchema } from "@/conversation/run-artifacts";

export namespace Transcript {
  // Roles are fixed per transcript kind at projection time so a replayed context renders
  // byte-identically no matter when finalization runs.
  export const roleByKind: Record<ConversationTranscriptKind, ConversationContextRole> = {
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

  export interface Projection {
    readonly content: Prisma.InputJsonObject;
    readonly key: string;
    readonly kind: ConversationTranscriptKind;
    readonly role: ConversationContextRole;
    readonly sourceMessageId: number | null;
    readonly sourceReferences: Prisma.InputJsonObject;
    readonly visibility: string;
  }

  export interface ProjectionRun {
    readonly errorTag: string | null;
    readonly id: string;
    readonly status: string;
    readonly actions: readonly {
      readonly deliveryStatus: string;
      readonly ordinal: number;
      readonly payload: unknown;
      readonly telegramMessageId: number | null;
      readonly type: string;
    }[];
    readonly inputs: readonly {
      readonly input: {
        readonly id: bigint;
        readonly mediaReferences: unknown;
        readonly payload: unknown;
      };
    }[];
    readonly toolCalls: readonly {
      readonly errorMessage: string | null;
      readonly input: unknown;
      readonly providerCallId: string;
      readonly result: unknown;
      readonly status: string;
      readonly toolName: string;
    }[];
  }

  export function projectRun(run: ProjectionRun, knownMessageIds: ReadonlySet<number>): Projection[] {
    const seenMessageIds = new Set(knownMessageIds);
    const userTurns = run.inputs.flatMap((runInput, index) => {
      const payload = Schema.decodeUnknownSync(StoredPayloadSchema)(runInput.input.payload);
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
                sourceMessageId: replyToMessageId,
                sourceReferences: { inputId: runInput.input.id.toString() },
                visibility: "linked-context",
              },
            ]
          : [];
      if (linked.length > 0 && replyToMessageId !== null) seenMessageIds.add(replyToMessageId);
      seenMessageIds.add(messageId);
      const projectedMedia = [...payload.repliedMedia, ...payload.media].map((reference) => ({
        availability: reference.availability,
        description: reference.stableDescription,
        mimeType: reference.mimeType,
        sha256: reference.availability === "stored" ? reference.sha256 : null,
        type: reference.type,
      }));
      const media =
        projectedMedia.length > 0
          ? [
              {
                content: {
                  references: projectedMedia,
                },
                key: `input:${runInput.input.id}:media`,
                kind: "mediaProjection" as const,
                role: "user" as const,
                sourceMessageId: null,
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
          sourceMessageId: messageId,
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
        sourceMessageId: null,
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
        sourceMessageId: null,
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
          kind: action.type === "ignore" ? ("assistantIgnore" as const) : ("assistantMessage" as const),
          role: "assistant" as const,
          sourceMessageId: action.type === "ignore" ? null : action.telegramMessageId,
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
              sourceMessageId: null,
              sourceReferences: { runId: run.id },
              visibility: "internal",
            },
          ]
        : [];

    return [...userTurns, ...toolTurns, ...assistantTurns, ...failureTurns];
  }
}
