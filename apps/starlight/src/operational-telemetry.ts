import { context, metrics, propagation } from "@opentelemetry/api";
import type { Counter, Histogram } from "@opentelemetry/api";
import { Effect, Layer } from "effect";

export namespace OperationalTelemetry {
  export interface TraceContext {
    readonly traceparent: string | null;
    readonly tracestate: string | null;
  }

  interface Instruments {
    readonly ages: Histogram;
    readonly durations: Histogram;
    readonly eventLoopDelays: Histogram;
    readonly events: Counter;
    readonly externalDurations: Histogram;
  }

  const instruments: { current: Instruments | null } = { current: null };

  export const eventLoopMonitorLayer = Layer.effectDiscard(
    Effect.callback<never>(() => {
      const intervalMs = 1000;
      const state = { expectedAt: performance.now() + intervalMs };
      const { eventLoopDelays } = getInstruments();
      const timer = setInterval(() => {
        const now = performance.now();
        eventLoopDelays.record(Math.max(0, now - state.expectedAt));
        state.expectedAt = now + intervalMs;
      }, intervalMs);
      return Effect.sync(() => clearInterval(timer));
    }),
  );

  export function recordEvent(event: string, result: string): void {
    getInstruments().events.add(1, { event, result });
  }

  export function recordDuration(operation: string, result: string, durationMs: number): void {
    getInstruments().durations.record(durationMs, { operation, result });
  }

  export function recordAge(queue: string, ageMs: number): void {
    getInstruments().ages.record(ageMs, { queue });
  }

  export function recordExternalDuration(service: string, operation: string, result: string, durationMs: number): void {
    getInstruments().externalDurations.record(durationMs, { operation, result, service });
  }

  export function currentTraceContext(): TraceContext {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return {
      traceparent: carrier.traceparent ?? null,
      tracestate: carrier.tracestate ?? null,
    };
  }

  function getInstruments(): Instruments {
    if (instruments.current !== null) return instruments.current;
    const meter = metrics.getMeter("starlight-conversation");
    instruments.current = {
      ages: meter.createHistogram("starlight.conversation.age_ms", { unit: "ms" }),
      durations: meter.createHistogram("starlight.conversation.duration_ms", { unit: "ms" }),
      eventLoopDelays: meter.createHistogram("starlight.runtime.event_loop_delay_ms", { unit: "ms" }),
      events: meter.createCounter("starlight.conversation.events"),
      externalDurations: meter.createHistogram("starlight.external.duration_ms", { unit: "ms" }),
    };
    return instruments.current;
  }
}
