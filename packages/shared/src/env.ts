import { z } from "zod";

// Environment contracts per process (AGENTS.md: secrets stay in .env, never in source).
// Each process parses its own schema once at startup and fails fast with every problem listed.

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Unset and empty-string variables are both "missing", so `API_PORT=` falls back to the default. */
function optionalVar<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// or postgresql:// URL" });
const redisUrl = z.url({ protocol: /^rediss?$/, error: "must be a redis:// or rediss:// URL" });

/** A bare http(s) origin, canonicalized (`http://localhost:3000/` becomes `http://localhost:3000`) for CORS matching. */
const httpOrigin = z
  .url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" })
  .refine(
    (value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
    },
    { error: "must be an origin (scheme://host[:port]) without credentials, path, query or fragment" },
  )
  .transform((value) => new URL(value).origin);

const baseServerEnv = {
  NODE_ENV: optionalVar(z.enum(["development", "test", "production"]).default("development")),
  LOG_LEVEL: optionalVar(z.enum(LOG_LEVELS).default("info")),
  REDIS_URL: optionalVar(redisUrl),
};

export const apiEnvSchema = z.object({
  ...baseServerEnv,
  DATABASE_URL: optionalVar(postgresUrl),
  API_PORT: optionalVar(z.coerce.number().int().min(1).max(65_535).default(4000)),
  /** Browser origin allowed by CORS. */
  WEB_ORIGIN: optionalVar(httpOrigin.default("http://localhost:3000")),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z.object(baseServerEnv);
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Browser-visible config for the web app. Next.js inlines only literal `process.env.NEXT_PUBLIC_*` reads, so pass them explicitly. */
export const webEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: optionalVar(z.url({ protocol: /^https?$/, error: "must be an http:// or https:// URL" })),
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export class EnvValidationError extends Error {
  override readonly name = "EnvValidationError";
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  }
}

/**
 * Parses `source` (default `process.env`) against `schema`.
 * Throws {@link EnvValidationError} naming each bad variable; values are never echoed because they may be secrets.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const name = issue.path.join(".") || "(root)";
    const value = source[name];
    return value === undefined || value === "" ? `${name}: required` : `${name}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
