import { parseEnv, webEnvSchema } from "@seatrush/shared";

const parsed = parseEnv(webEnvSchema, {
  // Referenced literally so Next.js inlines the values at build time.
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
});

/** Validated public environment for the web app. */
export const env = {
  /** API base URL without a trailing slash, e.g. http://localhost:4000. */
  NEXT_PUBLIC_API_URL: parsed.NEXT_PUBLIC_API_URL.replace(/\/+$/, ""),
  /** This app's public origin, e.g. http://localhost:3000; resolves absolute Open Graph URLs. */
  NEXT_PUBLIC_SITE_URL: parsed.NEXT_PUBLIC_SITE_URL,
} as const;
