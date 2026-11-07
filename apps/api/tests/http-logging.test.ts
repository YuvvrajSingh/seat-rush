import { Writable } from "node:stream";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";

// Captures the real request logs written by createApp's pino-http middleware.
function appWithCapturedLogs() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const app = createApp({
    logger: createLogger({ level: "info", destination }),
    webOrigin: "http://localhost:3000",
    readinessChecks: { postgres: async () => undefined, redis: async () => undefined },
  });
  return { app, lines };
}

const SECRETS = ["secret-tok-1", "4111111111111111", "secret-tok-2", "secret-tok-3"];

describe("request logging", () => {
  it("never logs query strings, whatever the route outcome", async () => {
    const { app, lines } = appWithCapturedLogs();
    await request(app).get("/healthz?token=secret-tok-1&cardNumber=4111111111111111").expect(200);
    await request(app).get("/nope?token=secret-tok-2").expect(404);
    await request(app)
      .post("/anything?token=secret-tok-3")
      .set("content-type", "application/json")
      .send("{bad")
      .expect(400);

    const requestLogs = lines.map((line) => JSON.parse(line) as { req?: { url: string; query?: unknown } });
    expect(requestLogs.map((log) => log.req?.url)).toEqual(["/healthz", "/nope", "/anything"]);
    for (const log of requestLogs) expect(log.req).not.toHaveProperty("query");
    const text = lines.join("\n");
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});
