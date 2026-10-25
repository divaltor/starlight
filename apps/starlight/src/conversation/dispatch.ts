import type { Context } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import type { TaskRuntime } from "@earendil-works/pi-durable";
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

  interface State {
    readonly attempts: number;
    readonly deliveryOpen: boolean;
    readonly inFlight: boolean;
    readonly index: number;
    readonly notBefore: number | null;
    readonly phase: "send";
    readonly results: Result[];
    readonly textDelivered: boolean;
    readonly unknownRetried: boolean;
  }

  export interface Deps {
    // Resolves with the failure instead of rejecting, so the outcome stays typed.
    readonly deliver: (
      input: TelegramDelivery.DeliveryInput,
    ) => Promise<{ readonly receipt: TelegramDelivery.Receipt } | { readonly error: TelegramDelivery.DeliveryError }>;
    readonly random: () => number;
  }

  export type Definition = ReturnType<typeof task>;

  export function task(deps: Deps) {
    return defineTask<Input, State, Result[]>({
      name: "starlight.delivery",
      version: 1,
      initial: () => ({
        attempts: 0,
        deliveryOpen: true,
        inFlight: false,
        index: 0,
        notBefore: null,
        phase: "send",
        results: [],
        textDelivered: false,
        unknownRetried: false,
      }),
      phases: {
        send: async (current, runtime, context) => {
          const state = current.state.checkpoint;
          const action = current.input.actions[state.index];

          if (action === undefined) {
            await runtime.commit(
              () => ({ outcome: { result: state.results, status: "completed" }, status: "terminal" }),
              context,
            );

            return;
          }

          if (action.type === "ignore") {
            await advance(runtime, state, { error: null, status: "delivered", telegramMessageId: null }, context);

            return;
          }

          if (state.index !== current.input.prefix && !state.deliveryOpen) {
            await advance(runtime, state, { error: SKIPPED, status: "failed", telegramMessageId: null }, context);

            return;
          }

          // The process died between the intent commit and the result commit: Telegram may have
          // shown the message, so only one more blind send is acceptable.
          if (state.inFlight) {
            await (state.unknownRetried
              ? fail(runtime, state, "Telegram delivery outcome remained unknown after one retry", context)
              : runtime.commit(() => running({ ...state, inFlight: false, unknownRetried: true }), context));

            return;
          }

          if (state.textDelivered && action.type === "text" && state.notBefore === null) {
            const gap = MIN_TEXT_GAP_MS + Math.floor(deps.random() * (MAX_TEXT_GAP_MS - MIN_TEXT_GAP_MS + 1));
            const notBefore = runtime.now() + gap;
            await runtime.sleepUntil(notBefore, { ...state, notBefore }, context);

            return;
          }

          await runtime.commit(() => running({ ...state, attempts: state.attempts + 1, inFlight: true }), context);

          const sent = await deps.deliver({
            action,
            chatId: current.input.chatId,
            threadKey: current.input.threadKey,
          });

          if ("receipt" in sent) {
            const { telegramMessageId } = sent.receipt;

            await advance(
              runtime,
              { ...state, textDelivered: state.textDelivered || action.type === "text" },
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
          const attempts = state.attempts + 1;

          if (error.outcomeUnknown && !state.unknownRetried && attempts < MAX_ATTEMPTS) {
            await runtime.commit(() => running({ ...state, attempts, inFlight: false, unknownRetried: true }), context);

            return;
          }

          if (!error.retryable || error.outcomeUnknown || attempts >= MAX_ATTEMPTS) {
            await fail(runtime, { ...state, attempts }, error.message, context);

            return;
          }

          await runtime.sleepUntil(
            runtime.now() + RETRY_DELAYS_MS[attempts - 1]!,
            { ...state, attempts, inFlight: false },
            context,
          );
        },
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
      { ...state, deliveryOpen: false },
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
        ...state,
        attempts: 0,
        // Reaching the model suffix reopens delivery after a failed precomputed prefix.
        deliveryOpen: state.deliveryOpen || result.status === "delivered",
        inFlight: false,
        index: state.index + 1,
        notBefore: null,
        results: [...state.results, result],
        unknownRetried: false,
      });
    }, context);
  }
}
