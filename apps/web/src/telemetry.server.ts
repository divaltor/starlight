import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

declare global {
  var starlightWebTracerProvider: NodeTracerProvider | undefined;
  var starlightWebTelemetryShutdown: Promise<void> | undefined;
}

if (globalThis.starlightWebTracerProvider === undefined) {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const spanProcessors = otlpEndpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${otlpEndpoint}/v1/traces`,
            headers: Object.fromEntries(
              (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",").flatMap((pair) => {
                const separator = pair.indexOf("=");
                if (separator < 1) return [];

                const key = pair.slice(0, separator).trim();
                const value = pair.slice(separator + 1).trim();
                return key.length > 0 && value.length > 0 ? [[key, value] as const] : [];
              }),
            ),
          }),
        ),
      ]
    : [];
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "starlight-web" }),
    spanProcessors,
  });

  provider.register();
  globalThis.starlightWebTracerProvider = provider;
}

export function shutdownTelemetry(): Promise<void> {
  globalThis.starlightWebTelemetryShutdown ??= globalThis.starlightWebTracerProvider?.shutdown() ?? Promise.resolve();
  return globalThis.starlightWebTelemetryShutdown;
}

export function traceRpcRequest(request: Request, handler: () => Promise<Response>): Promise<Response> {
  const parentContext = propagation.extract(context.active(), request.headers, {
    get(carrier, key) {
      return carrier.get(key) ?? undefined;
    },
    keys(carrier) {
      return [...carrier.keys()];
    },
  });

  return context.with(parentContext, () =>
    trace.getTracer("starlight-web").startActiveSpan("RPC request", { kind: SpanKind.SERVER }, async (span) => {
      try {
        const response = await handler();
        span.setAttribute('http.response.status_code', response.status);
        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return response;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException(error instanceof Error ? error : String(error));
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}
