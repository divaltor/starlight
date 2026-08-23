import type { Attributes, Tracer } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import { Context, Layer } from "effect";
import { selected } from "@/ai/model-profile";
import type { GenerationUsage, StepUsage } from "@/ai/usage";

export interface StepInput {
	readonly actualModel: string;
	readonly finishReason: string;
	readonly latencyMs: number;
	readonly providerRequestId: string;
	readonly stepIndex: number;
	readonly toolCallCount: number;
	readonly upstreamProvider: string | null;
	readonly usage: StepUsage;
}

export interface GenerationInput {
	readonly errorTag?: string;
	readonly finishReason: string;
	readonly usage: GenerationUsage;
}

export interface Interface {
	readonly recordGeneration: (input: GenerationInput) => void;
	readonly recordStep: (input: StepInput) => void;
}

export class Service extends Context.Service<Service, Interface>()("starlight/ModelTelemetry") {}

export const defaultLayer: Layer.Layer<Service> = fromTracer(trace.getTracer("starlight-model"));

export function fromTracer(tracer: Tracer): Layer.Layer<Service> {
	return Layer.succeed(Service)(
		Service.of({
			recordGeneration: (input) => {
				const span = tracer.startSpan("Model generation");
				span.setAttributes(generationAttributes(input));
				span.end();
			},
			recordStep: (input) => {
				const span = tracer.startSpan("Model step");
				span.setAttributes(stepAttributes(input));
				span.end();
			},
		}),
	);
}

function stepAttributes(input: StepInput): Attributes {
	const attributes: Attributes = {
		"gen_ai.operation.name": "chat",
		"gen_ai.request.model": selected.model,
		"gen_ai.response.id": input.providerRequestId,
		"gen_ai.response.model": input.actualModel,
		"starlight.model.actual": input.actualModel,
		"starlight.model.cache.result": input.usage.cacheResult,
		"starlight.model.configured": selected.model,
		"starlight.model.finish_reason": input.finishReason,
		"starlight.model.latency_ms": input.latencyMs,
		"starlight.model.provider_request_id": input.providerRequestId,
		"starlight.model.step_index": input.stepIndex,
		"starlight.model.tool_call_count": input.toolCallCount,
		...optionalNumber("starlight.model.cost.estimated_usd", input.usage.estimatedCostUsd),
		...optionalNumber("starlight.model.cost.reported_usd", input.usage.reportedCostUsd),
		...optionalNumber("starlight.model.cost.selected_usd", input.usage.selectedCostUsd),
		...optionalNumber("starlight.model.tokens.cache_read", input.usage.cacheReadTokens),
		...optionalNumber("starlight.model.tokens.cache_write", input.usage.cacheWriteTokens),
		...optionalNumber("starlight.model.tokens.input", input.usage.inputTokens),
		...optionalNumber("starlight.model.tokens.output", input.usage.outputTokens),
		...optionalNumber("starlight.model.tokens.reasoning", input.usage.reasoningTokens),
		...optionalNumber("starlight.model.tokens.uncached_input", input.usage.uncachedInputTokens),
	};
	if (input.upstreamProvider !== null) {
		attributes["starlight.model.upstream_provider"] = input.upstreamProvider;
	}

	return attributes;
}

function generationAttributes(input: GenerationInput): Attributes {
	const attributes: Attributes = {
		"gen_ai.operation.name": "chat",
		"gen_ai.request.model": selected.model,
		"starlight.model.configured": selected.model,
		"starlight.model.finish_reason": input.finishReason,
		"starlight.model.step_count": input.usage.steps.length,
		"starlight.model.usage.valid_for_cost_thresholds": input.usage.validForCostThresholds,
		...optionalNumber(
			"starlight.model.billing.cache_read_tokens",
			input.usage.billing.cacheReadTokens,
		),
		...optionalNumber(
			"starlight.model.billing.cache_write_tokens",
			input.usage.billing.cacheWriteTokens,
		),
		...optionalNumber("starlight.model.billing.cost_usd", input.usage.billing.costUsd),
		...optionalNumber("starlight.model.billing.input_tokens", input.usage.billing.inputTokens),
		...optionalNumber("starlight.model.billing.output_tokens", input.usage.billing.outputTokens),
		...optionalNumber(
			"starlight.model.billing.reasoning_tokens",
			input.usage.billing.reasoningTokens,
		),
		...optionalNumber("starlight.model.context_input_tokens", input.usage.contextInputTokens),
	};
	if (input.errorTag !== undefined) {
		attributes["error.type"] = input.errorTag;
	}

	return attributes;
}

function optionalNumber(name: string, value: number | null): Attributes {
	return value === null ? {} : { [name]: value };
}
