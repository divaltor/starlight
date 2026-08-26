import { OpenTelemetry } from "@ai-sdk/otel";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
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
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { registerTelemetry } from "ai";
import type { LangfuseConfig, OtlpConfig } from "@starlight/utils/env";
import type { Context, MiddlewareFn } from "grammy";

let provider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let logProvider: LoggerProvider | undefined;
let shutdownPromise: Promise<void> | undefined;

export interface TelemetryConfig {
  readonly langfuse?: LangfuseConfig;
  readonly otlp?: OtlpConfig;
}

export function initTelemetry(backends: TelemetryConfig): void {
  registerTelemetry(new OpenTelemetry({ usage: true }));

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: "starlight-bot" });

  const spanProcessors: SpanProcessor[] = [];
  if (backends.langfuse) {
    spanProcessors.push(new LangfuseSpanProcessor(backends.langfuse));
  }
  if (backends.otlp) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: signalEndpoint(backends.otlp.endpoint, "traces"),
          headers: backends.otlp.headers,
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
            headers: backends.otlp.headers,
          }),
        }),
      ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    logProvider = new LoggerProvider({
      resource,
      processors: [
        // sdk-logs 0.22x takes the exporter inside an options object.
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({
            url: signalEndpoint(backends.otlp.endpoint, "logs"),
            headers: backends.otlp.headers,
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
  return `${endpoint.replace(/\/+$/u, "")}/v1/${signal}`;
}

export function createUpdateTracer(): MiddlewareFn<Context> {
  return (_ctx, next) =>
    trace.getTracer("starlight-bot").startActiveSpan("Telegram update", async (span) => {
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
}

export function shutdownTelemetry(): Promise<void> {
  shutdownPromise ??= shutdownProviders();
  return shutdownPromise;
}

async function shutdownProviders(): Promise<void> {
  await Promise.all([provider?.shutdown(), meterProvider?.shutdown(), logProvider?.shutdown()]);
}
