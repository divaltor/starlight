import type { Tool } from "ai";
import { tool } from "ai";
import { Context, Effect, Layer, Schema } from "effect";
import type { Api } from "grammy";
import { GrammyError } from "grammy";
import { z } from "zod";
import { Database } from "@/services/database";

export namespace TelegramModeration {
  export const profileId = "telegram-moderation-v1";
  const QUIP_COOLDOWN_KEY = "moderation.quip";

  export interface ExecutionContext {
    readonly chatId: number;
    readonly liveMessageSenders: ReadonlyMap<number, number | null>;
  }

  interface MuteInput {
    readonly durationMinutes: number;
    readonly requestMessageId: number;
    readonly targetUserId: number;
  }

  export class ModerationError extends Schema.TaggedError<ModerationError>()("ModerationError", {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }) {}

  export interface Interface {
    readonly tools: (context: ExecutionContext) => { readonly mute_telegram_user: Tool<MuteInput> };
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/TelegramModeration") {}

  export function layer(
    api: Pick<Api, "getChatMember" | "restrictChatMember">,
  ): Layer.Layer<Service, never, Database.Service> {
    return Layer.effect(
      Service,
      Effect.gen(function* make() {
        const database = yield* Database.Service;

        return Service.of({
          tools: (context) => ({
            mute_telegram_user: tool({
              description:
                "Mute a Telegram user in the current group for 1–60 minutes. Call only for an explicit mute request in a LIVE MESSAGE, using that message's ID as requestMessageId and a Telegram user ID shown in conversation context as targetUserId. The requester must be a Telegram administrator. After success, always confirm the mute; include one short sarcastic or quirky quip only when quipAllowed is true, otherwise use a plain confirmation.",
              inputSchema: z.object({
                durationMinutes: z.number().int().min(1).max(60),
                requestMessageId: z.number().int(),
                targetUserId: z.number().int(),
              }),
              execute: (input, options) =>
                Effect.runPromise(
                  // oxlint-disable-next-line sonarjs/no-nested-functions -- AI SDK owns the tool execution callback boundary.
                  Effect.gen(function* mute() {
                    const requesterId = context.liveMessageSenders.get(input.requestMessageId);
                    if (requesterId === undefined || requesterId === null) {
                      return yield* new ModerationError({
                        message: "Mute request must come from an identified live user",
                      });
                    }
                    const requester = yield* Effect.tryPromise({
                      try: () => api.getChatMember(context.chatId, requesterId),
                      catch: telegramError("Failed to verify the mute requester"),
                    });
                    if (requester.status !== "administrator" && requester.status !== "creator") {
                      return yield* new ModerationError({
                        message: "Only a Telegram administrator can request a mute",
                      });
                    }
                    const target = yield* Effect.tryPromise({
                      try: () => api.getChatMember(context.chatId, input.targetUserId),
                      catch: telegramError("Failed to find the mute target"),
                    });
                    yield* Effect.tryPromise({
                      try: () =>
                        api.restrictChatMember(
                          context.chatId,
                          input.targetUserId,
                          { can_send_messages: false },
                          { until_date: Math.floor(Date.now() / 1000) + input.durationMinutes * 60 },
                        ),
                      catch: telegramError("Telegram rejected the mute"),
                    });
                    const quipAllowed = yield* database
                      .transaction(async (transaction) => {
                        const user = await transaction.user.upsert({
                          where: { telegramId: BigInt(target.user.id) },
                          create: {
                            firstName: target.user.first_name,
                            isBot: target.user.is_bot,
                            lastName: target.user.last_name ?? null,
                            telegramId: BigInt(target.user.id),
                            username: target.user.username ?? null,
                          },
                          update: {
                            firstName: target.user.first_name,
                            isBot: target.user.is_bot,
                            lastName: target.user.last_name ?? null,
                            username: target.user.username ?? null,
                          },
                        });
                        const claimed = await transaction.$queryRaw<{ readonly user_id: string }[]>`
                          INSERT INTO user_tool_cooldowns AS cooldown (user_id, cooldown_key, expires_at)
                          VALUES (${user.id}::uuid, ${QUIP_COOLDOWN_KEY}, statement_timestamp() + INTERVAL '72 hours')
                          ON CONFLICT (user_id, cooldown_key) DO UPDATE
                          SET expires_at = EXCLUDED.expires_at
                          WHERE cooldown.expires_at <= statement_timestamp()
                          RETURNING user_id
                        `;
                        return claimed.length === 1;
                      })
                      .pipe(
                        Effect.catch((error) =>
                          Effect.logError("Failed to claim moderation quip cooldown").pipe(
                            Effect.annotateLogs({ errorTag: error._tag, targetUserId: input.targetUserId }),
                            Effect.as(false),
                          ),
                        ),
                      );
                    return { durationMinutes: input.durationMinutes, muted: true, quipAllowed };
                  }),
                  { signal: options.abortSignal },
                ),
            }),
          }),
        });
      }),
    );
  }

  function telegramError(message: string) {
    return (cause: unknown) =>
      new ModerationError({
        cause,
        message: cause instanceof GrammyError ? `${message}: ${cause.description}` : message,
      });
  }
}
