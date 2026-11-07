import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler, HttpError } from "../src/middleware/errors.js";
import { requestId } from "../src/middleware/request-id.js";

// A minimal app exercising the shared error handler with routes that fail on purpose.
function failingApp() {
  const app = express();
  app.use(requestId());
  app.get("/crash", () => {
    throw new Error("secret internal detail");
  });
  app.get("/async-crash", async () => {
    await Promise.resolve();
    throw new Error("async internal detail");
  });
  app.get("/conflict", () => {
    throw new HttpError(400, "bad_request", "Seat count must be between 1 and 4");
  });
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it.each(["/crash", "/async-crash"])("hides internals of unexpected errors (%s)", async (path) => {
    const res = await request(failingApp()).get(path).set("x-request-id", "req-500");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: "internal_error", message: "Internal server error", requestId: "req-500" },
    });
    expect(res.text).not.toContain("internal detail");
    expect(res.text).not.toContain("stack");
  });

  it("renders HttpError with its status, code and message", async () => {
    const res = await request(failingApp()).get("/conflict");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "bad_request", message: "Seat count must be between 1 and 4" });
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });
});
