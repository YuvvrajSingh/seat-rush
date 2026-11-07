import { HealthResponseSchema } from "@seatrush/shared";

const DEFAULT_TIMEOUT_MS = 2_500;

export type ApiHealth =
  | { kind: "online"; url: string; latencyMs: number }
  /** The API answered, but not with a healthy liveness response. */
  | { kind: "unhealthy"; url: string; detail: string }
  | { kind: "unreachable"; url: string; detail: string };

/** Probes `GET {apiUrl}/healthz`. Never throws; every failure maps to a displayable state. */
export async function checkApiHealth(
  apiUrl: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<ApiHealth> {
  const url = `${apiUrl}/healthz`;
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return {
      kind: "unreachable",
      url,
      detail: timedOut
        ? `No answer within ${timeoutMs / 1000} seconds.`
        : "The connection was refused or the host could not be found.",
    };
  }
  const latencyMs = Math.round(performance.now() - started);

  if (!response.ok) {
    return { kind: "unhealthy", url, detail: `It answered with HTTP ${response.status}.` };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!HealthResponseSchema.safeParse(body).success) {
    return { kind: "unhealthy", url, detail: "It answered, but not with a SeatRush health response." };
  }
  return { kind: "online", url, latencyMs };
}
