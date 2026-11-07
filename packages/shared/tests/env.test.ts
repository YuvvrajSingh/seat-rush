import { describe, expect, it } from "vitest";
import { apiEnvSchema, EnvValidationError, parseEnv, webEnvSchema, workerEnvSchema } from "../src/env.js";

const DATABASE_URL = "postgresql://seatrush:s3cret-pass@localhost:5433/seatrush";
const REDIS_URL = "redis://localhost:6379";

function parseError(run: () => unknown): EnvValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error("expected EnvValidationError");
}

describe("parseEnv(apiEnvSchema)", () => {
  it("applies defaults when only the required URLs are set", () => {
    expect(parseEnv(apiEnvSchema, { DATABASE_URL, REDIS_URL })).toEqual({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      REDIS_URL,
      DATABASE_URL,
      API_PORT: 4000,
      WEB_ORIGIN: "http://localhost:3000",
    });
  });

  it("treats empty strings as unset so defaults still apply", () => {
    const env = parseEnv(apiEnvSchema, { DATABASE_URL, REDIS_URL, API_PORT: "", WEB_ORIGIN: "", LOG_LEVEL: "" });
    expect(env.API_PORT).toBe(4000);
    expect(env.WEB_ORIGIN).toBe("http://localhost:3000");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("coerces API_PORT from a string", () => {
    expect(parseEnv(apiEnvSchema, { DATABASE_URL, REDIS_URL, API_PORT: "4100" }).API_PORT).toBe(4100);
  });

  it.each(["abc", "0", "65536", "40.5"])("rejects API_PORT=%s", (API_PORT) => {
    const error = parseError(() => parseEnv(apiEnvSchema, { DATABASE_URL, REDIS_URL, API_PORT }));
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatch(/^API_PORT: /);
  });

  it("reports every missing required variable at once", () => {
    const error = parseError(() => parseEnv(apiEnvSchema, { DATABASE_URL: "" }));
    expect(error.issues).toEqual(["REDIS_URL: required", "DATABASE_URL: required"]);
  });

  it("rejects URLs with the wrong scheme without echoing the value", () => {
    const error = parseError(() =>
      parseEnv(apiEnvSchema, { DATABASE_URL: "mysql://root:s3cret-pass@db/seatrush", REDIS_URL: "http://localhost:6379" }),
    );
    expect(error.issues).toEqual([
      "REDIS_URL: must be a redis:// or rediss:// URL",
      "DATABASE_URL: must be a postgres:// or postgresql:// URL",
    ]);
    expect(error.message).not.toContain("s3cret-pass");
  });

  it("rejects an unknown LOG_LEVEL", () => {
    const error = parseError(() => parseEnv(apiEnvSchema, { DATABASE_URL, REDIS_URL, LOG_LEVEL: "verbose" }));
    expect(error.issues[0]).toMatch(/^LOG_LEVEL: /);
  });

  it.each([
    ["http://localhost:3000/", "http://localhost:3000"],
    ["HTTP://LocalHost:3000", "http://localhost:3000"],
    ["https://seatrush.example:443/", "https://seatrush.example"],
  ])("canonicalizes WEB_ORIGIN=%s to %s", (WEB_ORIGIN, expected) => {
    expect(parseEnv(apiEnvSchema, { DATABASE_URL, REDIS_URL, WEB_ORIGIN }).WEB_ORIGIN).toBe(expected);
  });

  it.each([
    "http://localhost:3000/app",
    "http://localhost:3000/?x=1",
    "http://localhost:3000/#top",
    "http://user:pass@localhost:3000",
  ])("rejects WEB_ORIGIN=%s that is not a bare origin", (WEB_ORIGIN) => {
    const error = parseError(() => parseEnv(apiEnvSchema, { DATABASE_URL, REDIS_URL, WEB_ORIGIN }));
    expect(error.issues).toEqual([
      "WEB_ORIGIN: must be an origin (scheme://host[:port]) without credentials, path, query or fragment",
    ]);
  });

  it("rejects a non-http(s) WEB_ORIGIN", () => {
    const error = parseError(() => parseEnv(apiEnvSchema, { DATABASE_URL, REDIS_URL, WEB_ORIGIN: "ftp://localhost" }));
    expect(error.issues).toEqual(["WEB_ORIGIN: must be an http:// or https:// URL"]);
  });
});

describe("parseEnv(workerEnvSchema)", () => {
  it("needs only REDIS_URL", () => {
    expect(parseEnv(workerEnvSchema, { REDIS_URL: "rediss://cache.example:6380" })).toEqual({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      REDIS_URL: "rediss://cache.example:6380",
    });
  });
});

describe("parseEnv(webEnvSchema)", () => {
  it("accepts an http(s) API URL and rejects missing or other schemes", () => {
    expect(parseEnv(webEnvSchema, { NEXT_PUBLIC_API_URL: "http://localhost:4000" })).toEqual({
      NEXT_PUBLIC_API_URL: "http://localhost:4000",
    });
    expect(parseError(() => parseEnv(webEnvSchema, {})).issues).toEqual(["NEXT_PUBLIC_API_URL: required"]);
    expect(parseError(() => parseEnv(webEnvSchema, { NEXT_PUBLIC_API_URL: "ftp://x" })).issues).toEqual([
      "NEXT_PUBLIC_API_URL: must be an http:// or https:// URL",
    ]);
  });
});
