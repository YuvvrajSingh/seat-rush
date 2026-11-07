import type { ResponseConfig } from "@asteasolutions/zod-to-openapi";
import { ErrorResponseSchema } from "@seatrush/shared";

/** Shared `default` response: every route can fail with the standard error body. */
export const errorResponses: Record<"default", ResponseConfig> = {
  default: {
    description: "Error",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
};
