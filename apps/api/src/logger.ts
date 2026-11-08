import { pino, type DestinationStream, type Logger, type LevelWithSilent } from "pino";
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from "@seatrush/shared";
import type { Redis } from "ioredis";

export function createLogger(options: { level: LevelWithSilent; destination?: DestinationStream }): Logger {
  const loggerOptions = {
    level: options.level,
    base: { service: "api" },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
  };
  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}

/** One warning per outage, rearmed only after a successful connection. */
export function logRedisConnectionErrors(connection: Redis, logger: Pick<Logger, "warn">, message: string): void {
  let failed = false;
  connection.on("ready", () => { failed = false; });
  connection.on("error", (err) => {
    if (failed) return;
    failed = true;
    logger.warn({ err }, message);
  });
}
