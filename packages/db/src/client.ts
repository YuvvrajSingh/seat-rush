import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export interface PrismaClientOptions {
  max?: number;
  connectionTimeoutMillis?: number;
}

export function createPrismaClient(databaseUrl: string, options: PrismaClientOptions = {}): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({
    connectionString: databaseUrl,
    max: options.max ?? 20,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
  }) });
}

export type { PrismaClient } from "./generated/prisma/client.js";
