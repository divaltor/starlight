import { OpenTelemetry } from "@ai-sdk/otel";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  SpanLink,
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetryMetrics,
  TelemetryPropagation,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { context, metrics, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Context, Link, Span } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_ERROR_TYPE, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { heapSize, memoryUsage } from "bun:jsc";
import { registerTelemetry } from "ai";
import type { MiddlewareFn } from "grammy";
import type { OpenRouter } from "@/ai/openrouter";
import type { LangfuseConfig, OtlpConfig } from "@/env";

let provider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let logProvider: LoggerProvider | undefined;
let shutdownPromise: Promise<void> | undefined;
const INSTRUMENTATION_NAME = "starlight-bot";
const PI_MODEL_REQUEST_SPAN = "pi.ai.request";

// Set by Starlight on a phase span and copied onto the spans Pi starts under it.
const INHERITED_ATTRIBUTES = new Set(["langfuse.session.id", "langfuse.user.id", "starlight.private"]);

// Pi hands back its own span handles as parents, link targets and exemplar contexts.
const otelContexts = new WeakMap<TelemetryContext, Context>();

// The latest model request span under each parent context, kept only for chats that are explicitly not private.
const contentRequests = new WeakMap<Context, Span>();

export interface TelemetryConfig {
  readonly langfuse?: LangfuseConfig;
  readonly otlp?: OtlpConfig;
}

export function initTelemetry(backends: TelemetryConfig): void {
  registerTelemetry(
    new OpenTelemetry({
      enrichSpan: (span) => {
        const sessionId = span.runtimeContext?.["langfuse.session.id"];
        const traceName = span.runtimeContext?.["langfuse.trace.name"];
        const userId = span.runtimeContext?.["langfuse.user.id"];

        return {
          ...(typeof sessionId === "string" && { "langfuse.session.id": sessionId }),
          ...(typeof traceName === "string" && { "langfuse.trace.name": traceName }),
          ...(typeof userId === "string" && { "langfuse.user.id": userId }),
          ...(span.runtimeContext?.["starlight.private"] === true && { "starlight.private": true }),
        };
      },
      usage: true,
    }),
  );

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: INSTRUMENTATION_NAME });

  const spanProcessors: SpanProcessor[] = [];

  if (backends.langfuse) {
    spanProcessors.push(new LangfuseSpanProcessor(backends.langfuse));
  }

  if (backends.otlp) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: signalEndpoint(backends.otlp.endpoint, "traces"),
          headers: { ...backends.otlp.headers, "X-Axiom-Dataset": backends.otlp.axiomDatasets.traces },
        }),
      ),
    );
  }

  provider = new NodeTracerProvider({ resource, spanProcessors });
  provider.register();

  if (backends.otlp) {
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: signalEndpoint(backends.otlp.endpoint, "metrics"),
            headers: {
              ...backends.otlp.headers,
              "X-Axiom-Metrics-Dataset": backends.otlp.axiomDatasets.metrics,
            },
          }),
        }),
      ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    const memoryGauge = meterProvider
      .getMeter(INSTRUMENTATION_NAME)
      .createObservableGauge("process.runtime.bun.memory.usage", {
        description: "Bun process memory by category",
        unit: "By",
      });

    memoryGauge.addCallback((result) => {
      const processMemory = process.memoryUsage();
      const bunMemory = memoryUsage();
      result.observe(processMemory.rss, { type: "rss" });
      result.observe(processMemory.heapUsed, { type: "heap_used" });
      result.observe(processMemory.heapTotal, { type: "heap_total" });
      result.observe(processMemory.external, { type: "external" });
      result.observe(processMemory.arrayBuffers, { type: "array_buffers" });
      result.observe(heapSize(), { type: "jsc_heap" });
      result.observe(bunMemory.currentCommit, { type: "mimalloc_committed" });
    });

    logProvider = new LoggerProvider({
      resource,
      processors: [
        // sdk-logs 0.22x takes the exporter inside an options object.
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({
            url: signalEndpoint(backends.otlp.endpoint, "logs"),
            headers: { ...backends.otlp.headers, "X-Axiom-Dataset": backends.otlp.axiomDatasets.logs },
          }),
        }),
      ],
    });
    logs.setGlobalLoggerProvider(logProvider);
  }
}

// OTLP/HTTP exporters want the signal path appended; mirrors what SDKs do for
// the OTEL_EXPORTER_OTLP_ENDPOINT variable.
function signalEndpoint(endpoint: string, signal: "traces" | "metrics" | "logs"): string {
  return `${endpoint.replace(/(?<!\/)\/+$/u, "")}/v1/${signal}`;
}

export function createUpdateTracer(): MiddlewareFn {
  return async (ctx, next) => {
    await trace.getTracer(INSTRUMENTATION_NAME).startActiveSpan("Telegram update", async (span) => {
      span.setAttributes({
        "telegram.update_id": ctx.update.update_id,
        "telegram.update_type": Object.keys(ctx.update).find((key) => key !== "update_id") ?? "unknown",
      });

      // langfuse.session.id / langfuse.user.id / langfuse.trace.name are set by the
      // access middleware once the chat (and its privacy flag) is loaded.
      try {
        await next();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException(error instanceof Error ? error : String(error));
        throw error;
      } finally {
        span.end();
      }
    });
  };
}

/**
 * Pi's telemetry adapter over the global OTel providers. Pi passes parents explicitly, so roots start from
 * `ROOT_CONTEXT`: harness phases run from timers and wake-ups, where the ambient context belongs to whatever
 * scheduled them. Each callback runs with its span active, so Effect and AI SDK spans and logs nest under it.
 */
export function createPiTelemetry(): TelemetryContext {
  const tracer = trace.getTracer(INSTRUMENTATION_NAME);
  const meter = metrics.getMeter(INSTRUMENTATION_NAME);
  // Pi starts model requests itself, so they inherit the Langfuse trace attributes Starlight sets on an ancestor.
  const traceAttributes = new WeakMap<Context, SpanAttributes>();

  const piMetrics: TelemetryMetrics = {
    counter: (name, options) => meter.createCounter(name, options),
    upDownCounter: (name, options) => meter.createUpDownCounter(name, options),
    histogram: (name, options) => {
      const histogram = meter.createHistogram(name, {
        description: options?.description,
        unit: options?.unit,
        advice: options?.boundaries === undefined ? undefined : { explicitBucketBoundaries: [...options.boundaries] },
      });

      return {
        record: (value, attributes, piContext) => {
          histogram.record(value, attributes, piContext && otelContexts.get(piContext));
        },
      };
    },
  };

  const piPropagation: TelemetryPropagation = {
    inject: (piContext) => {
      const otelContext = otelContexts.get(piContext);

      // Roots have no carrier.
      if (otelContext === undefined) return otelContext;

      const carrier: Record<string, string> = {};

      propagation.inject(otelContext, carrier);

      return carrier;
    },
    extract: (carrier) => {
      const otelContext = propagation.extract(ROOT_CONTEXT, carrier ?? {});

      if (trace.getSpan(otelContext) === undefined) return root;

      const parent: TelemetryContext = {
        metrics: piMetrics,
        propagation: piPropagation,
        startSpan: async (options, callback) => await startSpan(otelContext, options, callback),
      };

      otelContexts.set(parent, otelContext);

      return parent;
    },
  };

  const root: TelemetryContext = {
    metrics: piMetrics,
    propagation: piPropagation,
    startSpan: async (options, callback) => await startSpan(ROOT_CONTEXT, options, callback),
  };

  return root;

  async function startSpan<T>(
    parent: Context,
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const isModelRequest = options.name === PI_MODEL_REQUEST_SPAN;
    const inherited = { ...traceAttributes.get(parent) };
    const startAttributes = { ...inherited, ...options.attributes };

    const otelSpan = tracer.startSpan(
      options.name,
      {
        attributes: isModelRequest ? toLangfuseGeneration(startAttributes) : startAttributes,
        links: options.links?.flatMap(toOtelLink),
      },
      parent,
    );

    if (isModelRequest && startAttributes["starlight.private"] === false) contentRequests.set(parent, otelSpan);

    const active = trace.setSpan(parent, otelSpan);
    traceAttributes.set(active, inherited);
    let explicitStatus = false;

    const span: TelemetrySpan = {
      metrics: piMetrics,
      propagation: piPropagation,
      startSpan: async (childOptions, childCallback) => await startSpan(active, childOptions, childCallback),
      addLink: (link) => {
        otelSpan.addLinks(toOtelLink(link));
      },
      addEvent: (name, attributes) => {
        otelSpan.addEvent(name, attributes);
      },
      setAttributes: (attributes) => {
        Object.assign(
          inherited,
          Object.fromEntries(Object.entries(attributes).filter((entry) => INHERITED_ATTRIBUTES.has(entry[0]))),
        );
        otelSpan.setAttributes(isModelRequest ? toLangfuseGeneration(attributes) : attributes);
      },
      setStatus: (status) => {
        explicitStatus = true;
        setOtelStatus(otelSpan, status);
      },
    };

    otelContexts.set(span, active);

    try {
      return await context.with(active, async () => await callback(span));
    } catch (error) {
      if (!explicitStatus) {
        setOtelStatus(otelSpan, {
          status: "error",
          ...(error instanceof Error && { error: { name: error.name, message: error.message } }),
        });
      }

      throw error;
    } finally {
      otelSpan.end();
    }
  }
}

function toOtelLink(link: SpanLink): Link[] {
  const otelContext = otelContexts.get(link.context);
  const spanContext = otelContext && trace.getSpanContext(otelContext);

  return spanContext === undefined ? [] : [{ context: spanContext, attributes: link.attributes }];
}

/**
 * pi-ai never puts prompts or responses on its request span, so the provider hands them over here. They land on the
 * model request open under `parent` only when its chat is explicitly not private, as the AI SDK calls' `recordInputs`.
 */
export function recordModelContent(
  parent: TelemetryContext | undefined,
  field: "input" | "output",
  value: OpenRouter.Payload | AssistantMessage["content"],
): void {
  const otelContext = parent && otelContexts.get(parent);

  (otelContext && contentRequests.get(otelContext))?.setAttribute(
    `langfuse.observation.${field}`,
    JSON.stringify(value),
  );
}

// LangfuseSpanProcessor drops spans without gen_ai.* attributes, and pi-ai reports usage and cost under its own names.
function toLangfuseGeneration(attributes: SpanAttributes): SpanAttributes {
  return {
    ...attributes,
    ...(attributes.model !== undefined && {
      "gen_ai.request.model": attributes.model,
      "langfuse.observation.type": "generation",
    }),
    ...(attributes["usage.input"] !== undefined && {
      "langfuse.observation.usage_details": JSON.stringify({
        input: attributes["usage.input"],
        input_cache_read: attributes["usage.cache_read"],
        input_cache_write: attributes["usage.cache_write"],
        output: attributes["usage.output"],
      }),
    }),
    ...(attributes["cost.total"] !== undefined && { "gen_ai.usage.cost": attributes["cost.total"] }),
  };
}

function setOtelStatus(span: Span, status: SpanStatus): void {
  if (status.status === "ok") {
    span.setStatus({ code: SpanStatusCode.OK });

    return;
  }

  span.setStatus({ code: SpanStatusCode.ERROR, message: status.error?.message });

  if (status.error) span.setAttribute(ATTR_ERROR_TYPE, status.error.name);
}

export async function shutdownTelemetry(): Promise<void> {
  shutdownPromise ??= shutdownProviders();

  await shutdownPromise;
}

async function shutdownProviders(): Promise<void> {
  await Promise.all([provider?.shutdown(), meterProvider?.shutdown(), logProvider?.shutdown()]);
}
