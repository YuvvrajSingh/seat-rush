import { defineConfig } from "vitest/config";

// Resolve workspace packages to their TypeScript source (package.json "development" export).
const conditions = ["development", "module", "node"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
