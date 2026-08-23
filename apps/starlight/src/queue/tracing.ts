import { context, propagation, trace } from "@opentelemetry/api";
import type { Context, Span as ApiSpan, SpanKind as ApiSpanKind } from "@opentelemetry/api";
import type { SpanKind as BullSpanKind, Telemetry } from "bullmq";

// BullMQ and OpenTelemetry define identical numeric SpanKind members.
function toOtelSpanKind(kind: BullSpanKind): ApiSpanKind {
	const kindCode: number = kind;
	return kindCode as ApiSpanKind;
}

function adaptSpan(span: ApiSpan) {
	return {
		setSpanOnContext: (ctx: Context) => trace.setSpan(ctx, span),
		setAttribute: span.setAttribute.bind(span),
		setAttributes: span.setAttributes.bind(span),
		addEvent: span.addEvent.bind(span),
		recordException: span.recordException.bind(span),
		end: span.end.bind(span),
	};
}

const otelTracer = trace.getTracer("starlight-queue");

export const otelTelemetry: Telemetry = {
	tracer: {
		startSpan: (name, options, ctx) =>
			adaptSpan(otelTracer.startSpan(name, options && { kind: toOtelSpanKind(options.kind) }, ctx)),
	},
	contextManager: {
		active: () => context.active(),
		with: (ctx, fn) => context.with(ctx, fn),
		getMetadata: (ctx) => {
			const carrier: Record<string, string> = {};
			propagation.inject(ctx, carrier);
			return JSON.stringify(carrier);
		},
		fromMetadata: (activeContext, metadata) =>
			propagation.extract(activeContext, JSON.parse(metadata)),
	},
};
