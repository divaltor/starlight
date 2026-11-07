import type { Context } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import type { PhaseHandler, TaskRuntime } from "@earendil-works/pi-durable";
import { z } from "zod";
import { ChatReply } from "@/ai/chat-reply";
import type { TelegramDelivery } from "@/conversation/delivery";
import { LaneDoc } from "@/conversation/lane-doc";

/**
 * Durable delivery of one run's reply actions to Telegram. Every attempt commits its intent
 * before the send, so a crash mid-send resumes as an unknown outcome instead of a blind
 * resend; that outcome gets exactly one cautious retry. Known transient failures retry after
 * 1, 2.5, and 5 seconds. A failed action closes delivery for the rest of its segment: the
 * precomputed reaction prefix and the model suffix are independent segments.
 */
export namespace Dispatch {
  export const SKIPPED = "Skipped because an earlier response action failed";
  const MAX_ATTEMPTS = 4;
  const RETRY_DELAYS_MS = [1000, 2500, 5000];
  const MIN_TEXT_GAP_MS = 1500;
  const MAX_TEXT_GAP_MS = 2500;

  enum Phase {
    Ready = "ready",
    TextGap = "text-gap",
    InFlight = "in-flight",
    Retry = "retry",
    UnknownRetry = "unknown-retry",
  }

  export interface Input {
    readonly actions: TelegramDelivery.Action[];
    readonly chatId: number;
    // Number of leading precomputed reactions; the model suffix starts a fresh segment.
    readonly prefix: number;
    readonly threadKey: number;
  }

  export interface Result {
    readonly error: string | null;
    readonly status: "delivered" | "failed";
    readonly telegramMessageId: number | null;
  }

  interface Progress {
    readonly deliveryOpen: boolean;
    readonly results: Result[];
    readonly textDelivered: boolean;
  }

  /* oxlint-disable sonarjs/max-union-size -- Each phase is a distinct durable delivery state. */
  type State = { readonly progress: Progress } & (
    | { readonly phase: Phase.Ready }
    | { readonly phase: Phase.TextGap }
    | { readonly attempts: number; readonly phase: Phase.InFlight; readonly recovery: "available" | "used" }
    | { readonly attempts: number; readonly phase: Phase.Retry; readonly recovery: "available" | "used" }
    | { readonly attempts: number; readonly phase: Phase.UnknownRetry }
  );
  /* oxlint-enable sonarjs/max-union-size */

  export interface Deps {
    // Resolves with the failure instead of rejecting, so the outcome stays typed.
    readonly deliver: (
      input: TelegramDelivery.DeliveryInput,
    ) => Promise<{ readonly receipt: TelegramDelivery.Receipt } | { readonly error: TelegramDelivery.DeliveryError }>;
    readonly random: () => number;
  }

  export type Definition = ReturnType<typeof task>;

  export function task(deps: Deps) {
    const send: PhaseHandler<Input, Exclude<State, { phase: Phase.InFlight }>, State, Result[], object> = async (
      current,
      runtime,
      context,
    ) => {
      const state = current.state.checkpoint;
      const action = current.input.actions[state.progress.results.length]!;

      const intent: Extract<State, { phase: Phase.InFlight }> = {
        attempts: ("attempts" in state ? state.attempts : 0) + 1,
        phase: Phase.InFlight,
        progress: state.progress,
        recovery:
          state.phase === Phase.UnknownRetry || (state.phase === Phase.Retry && state.recovery === "used")
            ? "used"
            : "available",
      };

      await runtime.commit(() => running(intent), context);

      const sent = await deps.deliver({
        action,
        chatId: current.input.chatId,
        threadKey: current.input.threadKey,
      });

      if ("receipt" in sent) {
        const { telegramMessageId } = sent.receipt;

        await advance(
          runtime,
          {
            ...state,
            progress: { ...state.progress, textDelivered: state.progress.textDelivered || action.type === "text" },
          },
          { error: null, status: "delivered", telegramMessageId },
          context,
          (lane) => {
            if (action.type !== "text" || telegramMessageId === null) return;
            LaneDoc.rememberReply(lane, action, telegramMessageId);
          },
        );

        return;
      }

      const { error } = sent;

      if (error.outcomeUnknown && intent.recovery === "available" && intent.attempts < MAX_ATTEMPTS) {
        await runtime.commit(
          () => running({ attempts: intent.attempts, phase: Phase.UnknownRetry, progress: state.progress }),
          context,
        );

        return;
      }

      if (!error.retryable || error.outcomeUnknown || intent.attempts >= MAX_ATTEMPTS) {
        await fail(runtime, state, error.message, context);

        return;
      }

      await runtime.sleepUntil(
        runtime.now() + RETRY_DELAYS_MS[intent.attempts - 1]!,
        { ...intent, phase: Phase.Retry },
        context,
      );
    };

    return defineTask<Input, State, Result[]>({
      name: "starlight.delivery",
      version: 2,
      initial: () => ({
        phase: Phase.Ready,
        progress: { deliveryOpen: true, results: [], textDelivered: false },
      }),
      migrate: (input, checkpoint, fromVersion) => {
        if (fromVersion !== 1) throw new Error("Unsupported delivery checkpoint version");

        const decodedInput = z
          .object({
            actions: z.array(ChatReply.actionSchema),
            chatId: z.number(),
            prefix: z.number(),
            threadKey: z.number(),
          })
          .parse(input);

        const legacy = z
          .object({
            attempts: z.number(),
            deliveryOpen: z.boolean(),
            inFlight: z.boolean(),
            notBefore: z.number().nullable(),
            results: z.array(
              z.object({
                error: z.string().nullable(),
                status: z.enum(["delivered", "failed"]),
                telegramMessageId: z.number().nullable(),
              }),
            ),
            textDelivered: z.boolean(),
            unknownRetried: z.boolean(),
          })
          .parse(checkpoint);

        const progress = {
          deliveryOpen: legacy.deliveryOpen,
          results: legacy.results,
          textDelivered: legacy.textDelivered,
        };

        const recovery = legacy.unknownRetried ? "used" : "available";

        if (legacy.inFlight) {
          return {
            input: decodedInput,
            checkpoint: { attempts: legacy.attempts, phase: Phase.InFlight, progress, recovery },
          };
        }

        if (legacy.unknownRetried) {
          return {
            input: decodedInput,
            checkpoint: { attempts: legacy.attempts, phase: Phase.UnknownRetry, progress },
          };
        }

        if (legacy.attempts > 0) {
          return {
            input: decodedInput,
            checkpoint: { attempts: legacy.attempts, phase: Phase.Retry, progress, recovery },
          };
        }

        // Pi retains sleeping.until during migration; notBefore only marked an already chosen text gap.
        return {
          input: decodedInput,
          checkpoint: { phase: legacy.notBefore === null ? Phase.Ready : Phase.TextGap, progress },
        };
      },
      phases: {
        [Phase.Ready]: async (current, runtime, context) => {
          const state = current.state.checkpoint;
          const action = current.input.actions[state.progress.results.length];

          if (action === undefined) {
            await runtime.commit(
              () => ({ outcome: { result: state.progress.results, status: "completed" }, status: "terminal" }),
              context,
            );

            return;
          }

          if (action.type === "ignore") {
            await advance(runtime, state, { error: null, status: "delivered", telegramMessageId: null }, context);

            return;
          }

          if (state.progress.results.length !== current.input.prefix && !state.progress.deliveryOpen) {
            await advance(runtime, state, { error: SKIPPED, status: "failed", telegramMessageId: null }, context);

            return;
          }

          if (state.progress.textDelivered && action.type === "text") {
            const gap = MIN_TEXT_GAP_MS + Math.floor(deps.random() * (MAX_TEXT_GAP_MS - MIN_TEXT_GAP_MS + 1));
            await runtime.sleepUntil(runtime.now() + gap, { phase: Phase.TextGap, progress: state.progress }, context);

            return;
          }

          await send(current, runtime, context);
        },
        [Phase.TextGap]: send,
        [Phase.InFlight]: async (current, runtime, context) => {
          const state = current.state.checkpoint;
          // Telegram may have shown the message before the crash; allow only one blind retry.
          await (state.recovery === "used"
            ? fail(runtime, state, "Telegram delivery outcome remained unknown after one retry", context)
            : runtime.commit(
                () => running({ attempts: state.attempts, phase: Phase.UnknownRetry, progress: state.progress }),
                context,
              ));
        },
        [Phase.Retry]: send,
        [Phase.UnknownRetry]: send,
      },
      abort: async (_task, runtime, context) => {
        await runtime.commit(() => ({ outcome: { status: "aborted" }, status: "terminal" }), context);
      },
    });
  }

  type Runtime = TaskRuntime<Input, State, Result[], object>;

  function running(state: State) {
    return { checkpoint: state, status: "running" } as const;
  }

  async function fail(runtime: Runtime, state: State, message: string, context: Context) {
    await advance(
      runtime,
      { ...state, progress: { ...state.progress, deliveryOpen: false } },
      { error: message, status: "failed", telegramMessageId: null },
      context,
    );
  }

  async function advance(
    runtime: Runtime,
    state: State,
    result: Result,
    context: Context,
    updateLane?: (lane: LaneDoc.Draft) => void,
  ) {
    await runtime.commit(async (tx) => {
      if (updateLane !== undefined) updateLane(await tx.doc(LaneDoc.token, runtime.conversationId));

      return running({
        phase: Phase.Ready,
        progress: {
          ...state.progress,
          // Reaching the model suffix reopens delivery after a failed precomputed prefix.
          deliveryOpen: state.progress.deliveryOpen || result.status === "delivered",
          results: [...state.progress.results, result],
        },
      });
    }, context);
  }
}
