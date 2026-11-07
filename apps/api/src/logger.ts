import { pino, type DestinationStream, type Logger, type LevelWithSilent } from "pino";
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from "@seatrush/shared";

export function createLogger(options: { level: LevelWithSilent; destination?: DestinationStream }): Logger {
  const loggerOptions = {
    level: options.level,
    base: { service: "api" },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
  };
  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}
