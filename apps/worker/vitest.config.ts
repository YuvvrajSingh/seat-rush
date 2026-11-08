import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

// Resolve workspace packages to their TypeScript source (package.json "development" export).
const conditions = ["development", "module", "node"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["../../packages/db/tests/global-setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
