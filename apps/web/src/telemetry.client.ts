import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const provider = new WebTracerProvider();

provider.register();

export async function traceRpcRequest(request: Request, init: RequestInit): Promise<Response> {
  const span = trace.getTracer("starlight-web").startSpan("RPC request", { kind: SpanKind.CLIENT });
  const headers = new Headers(request.headers);
  propagation.inject(trace.setSpan(context.active(), span), headers, {
    set(carrier, key, value) {
      carrier.set(key, value);
    },
  });

  try {
    const response = await fetch(request, { ...init, headers });
    span.setAttribute('http.response.status_code', response.status);
    return response;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.recordException(error instanceof Error ? error : String(error));
    throw error;
  } finally {
    span.end();
  }
}
