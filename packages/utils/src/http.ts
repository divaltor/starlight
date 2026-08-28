import ky from "ky";

// NOTE: ky's `timeout` option only bounds time-to-headers; reading the response
// body (arrayBuffer/Bun.write/response.json) stays unbounded. Call sites that
// stream response bodies pass `signal: AbortSignal.timeout(ms)` — the signal
// stays attached to the body stream and aborts stalled reads.
export const http = ky.create({
  throwHttpErrors: false,
  retry: 0,
});
