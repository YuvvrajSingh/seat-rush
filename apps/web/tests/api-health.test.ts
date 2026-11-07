import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkApiHealth } from "../src/lib/api-health.js";

let server: Server | undefined;

async function stop(): Promise<void> {
  if (!server) return;
  const closing = once(server, "close");
  server.closeAllConnections();
  server.close();
  server = undefined;
  await closing;
}

afterEach(stop);

/** Starts a real HTTP server on an ephemeral port and returns its base URL. */
async function serve(handler: RequestListener): Promise<string> {
  server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function json(status: number, body: unknown): RequestListener {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

describe("checkApiHealth", () => {
  it("reports online when /healthz returns the health response", async () => {
    const base = await serve((req, res) =>
      req.url === "/healthz" ? json(200, { status: "ok" })(req, res) : json(404, {})(req, res),
    );

    const health = await checkApiHealth(base);

    expect(health).toMatchObject({ kind: "online", url: `${base}/healthz` });
    expect(health.kind === "online" && health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports unhealthy with the status code on a non-2xx answer", async () => {
    const base = await serve(json(503, { error: { code: "unavailable" } }));

    expect(await checkApiHealth(base)).toEqual({
      kind: "unhealthy",
      url: `${base}/healthz`,
      detail: "It answered with HTTP 503.",
    });
  });

  it("reports unhealthy when a 200 body is not a health response", async () => {
    const base = await serve(json(200, { hello: "world" }));

    expect(await checkApiHealth(base)).toMatchObject({ kind: "unhealthy" });
  });

  it("reports unreachable when nothing listens on the port", async () => {
    const base = await serve(() => {});
    await stop();

    expect(await checkApiHealth(base)).toMatchObject({
      kind: "unreachable",
      detail: "The connection was refused or the host could not be found.",
    });
  });

  it("reports unreachable after the timeout when the API never answers", async () => {
    const base = await serve(() => {});

    expect(await checkApiHealth(base, { timeoutMs: 200 })).toMatchObject({
      kind: "unreachable",
      detail: "No answer within 0.2 seconds.",
    });
  });
});
