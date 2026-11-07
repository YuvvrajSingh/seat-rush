import { pino, type Logger, type LevelWithSilent } from "pino";
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from "@seatrush/shared";

export function createLogger(level: LevelWithSilent): Logger {
  return pino({
    level,
    base: { service: "worker" },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
  });
}
