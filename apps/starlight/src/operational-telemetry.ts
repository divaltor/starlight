import { context, metrics, propagation } from "@opentelemetry/api";

export namespace OperationalTelemetry {
  export interface TraceContext {
    readonly traceparent: string | null;
    readonly tracestate: string | null;
  }

  const meter = metrics.getMeter("starlight-conversation");
  const events = meter.createCounter("starlight.conversation.events");
  const durations = meter.createHistogram("starlight.conversation.duration_ms", { unit: "ms" });
  const ages = meter.createHistogram("starlight.conversation.age_ms", { unit: "ms" });

  export function recordEvent(event: string, result: string): void {
    events.add(1, { event, result });
  }

  export function recordDuration(operation: string, result: string, durationMs: number): void {
    durations.record(durationMs, { operation, result });
  }

  export function recordAge(queue: string, ageMs: number): void {
    ages.record(ageMs, { queue });
  }

  export function currentTraceContext(): TraceContext {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return {
      traceparent: carrier.traceparent ?? null,
      tracestate: carrier.tracestate ?? null,
    };
  }
}
