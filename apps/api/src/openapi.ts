import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { errorResponses } from "./openapi-responses.js";
import { registerHealthOpenApi } from "./routes/health.js";
import { registerBookingOpenApi } from "./routes/booking.js";

/** Each route module contributes its paths here; add new modules' registrars to this list. */
const registrars: ((registry: OpenAPIRegistry) => void)[] = [registerHealthOpenApi, registerBookingOpenApi, registerOpenApiDocumentPath];

function registerOpenApiDocumentPath(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: "get",
    path: "/openapi.json",
    tags: ["meta"],
    summary: "This OpenAPI document",
    responses: {
      200: { description: "OpenAPI 3.1 document", content: { "application/json": { schema: { type: "object" } } } },
      ...errorResponses,
    },
  });
}

export function createOpenApiDocument(): ReturnType<OpenApiGeneratorV31["generateDocument"]> {
  const registry = new OpenAPIRegistry();
  for (const register of registrars) register(registry);
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "SeatRush API",
      version: "0.0.0",
      description: "Cinema seat booking under concurrency. Generated from the zod schemas in @seatrush/shared.",
    },
  });
}
