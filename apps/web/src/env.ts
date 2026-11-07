import { parseEnv, webEnvSchema } from "@seatrush/shared";

const parsed = parseEnv(webEnvSchema, {
  // Referenced literally so Next.js inlines the value at build time.
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});

/** Validated public environment for the web app. */
export const env = {
  /** API base URL without a trailing slash, e.g. http://localhost:4000. */
  NEXT_PUBLIC_API_URL: parsed.NEXT_PUBLIC_API_URL.replace(/\/+$/, ""),
} as const;
