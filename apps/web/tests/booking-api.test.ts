import { once } from "node:events";
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, createBookingApi } from "../src/lib/booking-api.js";
import { makeHold, makeSnapshot, SCREENING_ID, seatId } from "./fixtures.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const closing = once(server, "close");
  server.closeAllConnections();
  server.close();
  server = undefined;
  await closing;
});

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

/** Real HTTP server on an ephemeral port; records each request it receives. */
async function serve(handler: (seen: Seen) => { status: number; body: unknown }): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const listener: RequestListener = async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const request = { method: req.method, url: req.url, headers: req.headers, body };
    seen.push(request);
    const answer = handler(request);
    res.writeHead(answer.status, { "content-type": "application/json", "x-request-id": "req-from-header" });
    res.end(JSON.stringify(answer.body));
  };
  server = createServer(listener).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const error = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: "nope", requestId: "req-1", ...extra },
});

describe("createBookingApi", () => {
  it("posts a hold with the bearer token and a request id, and parses the Hold", async () => {
    const hold = makeHold(["B7", "B8"]);
    const { base, seen } = await serve(() => ({ status: 201, body: hold }));

    const result = await createBookingApi(base).createHold(SCREENING_ID, [seatId("B7"), seatId("B8")], "tok", "key-1");

    expect(result).toEqual(hold);
    expect(seen[0]).toMatchObject({ method: "POST", url: `/screenings/${SCREENING_ID}/holds` });
    expect(seen[0]?.headers.authorization).toBe("Bearer tok");
    expect(seen[0]?.headers["idempotency-key"]).toBe("key-1");
    expect(seen[0]?.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ seatIds: [seatId("B7"), seatId("B8")] });
  });

  it("turns a 409 seat_unavailable into an ApiError carrying the conflicting seat ids", async () => {
    const { base } = await serve(() => ({ status: 409, body: error("seat_unavailable", { seatIds: [seatId("B8")] }) }));

    const failure = await createBookingApi(base)
      .createHold(SCREENING_ID, [seatId("B8")], "tok", "key-1")
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "seat_unavailable", status: 409, seatIds: [seatId("B8")], requestId: "req-1" });
  });

  it("sends the snapshot request without a token when anonymous and reports request timing", async () => {
    const snapshot = makeSnapshot();
    const { base, seen } = await serve(() => ({ status: 200, body: snapshot }));

    const before = Date.now();
    const result = await createBookingApi(base).getSnapshot(SCREENING_ID);

    expect(result.body).toEqual(snapshot);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers["idempotency-key"]).toBeUndefined();
    expect(result.sentAtMs).toBeGreaterThanOrEqual(before);
    expect(result.receivedAtMs).toBeGreaterThanOrEqual(result.sentAtMs);
  });

  it("rejects a 200 whose body breaks the contract instead of rendering it", async () => {
    const { base } = await serve(() => ({ status: 200, body: { seats: "lots" } }));

    await expect(createBookingApi(base).getSnapshot(SCREENING_ID)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("maps a non-contract error body to invalid_response with the status and header request id", async () => {
    const { base } = await serve(() => ({ status: 502, body: "<html>bad gateway</html>" }));

    await expect(createBookingApi(base).getHold(makeHold(["A1"]).id, "tok")).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
      requestId: "req-from-header",
    });
  });

  it("reports network when nothing answers in time", async () => {
    await serve(() => ({ status: 200, body: {} }));
    const { port } = server?.address() as AddressInfo;
    server?.removeAllListeners("request");
    server?.on("request", () => {}); // accept, never answer

    await expect(createBookingApi(`http://127.0.0.1:${port}`, { timeoutMs: 100 }).getDemoScreening()).rejects.toMatchObject({
      code: "network",
    });
  });

  it("releases with DELETE on the hold path", async () => {
    const hold = makeHold(["A1"], { status: "released" });
    const { base, seen } = await serve(() => ({ status: 200, body: hold }));

    await expect(createBookingApi(base).releaseHold(hold.id, "tok", "key-2")).resolves.toEqual(hold);
    expect(seen[0]).toMatchObject({ method: "DELETE", url: `/holds/${hold.id}` });
    expect(seen[0]?.headers["idempotency-key"]).toBe("key-2");
  });
});
