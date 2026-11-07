import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Next.js only reads .env files from apps/web. The workspace keeps one .env at
// the repo root, so load it here; variables already in the environment win.
const rootEnvFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  transpilePackages: ["@seatrush/shared"],
  poweredByHeader: false,
};

export default nextConfig;
