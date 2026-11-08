import { isNotConnectionError, Worker, type ConnectionOptions } from "bullmq";
import type { Logger } from "pino";
import { ALL_QUEUE_NAMES } from "@seatrush/shared";
import type { ProcessorRegistry } from "./processors.js";

export interface StartWorkersOptions {
  processors: ProcessorRegistry;
  connection: ConnectionOptions;
  logger: Logger;
  /** BullMQ key prefix; tests use a unique one for isolation. */
  prefix?: string;
}

/** Starts one BullMQ Worker per registered processor. */
export function startWorkers({ processors, connection, logger, prefix }: StartWorkersOptions): Worker[] {
  const workers: Worker[] = [];
  for (const queueName of ALL_QUEUE_NAMES) {
    const processor = processors[queueName];
    if (!processor) continue;
    const log = logger.child({ queue: queueName });
    const worker = new Worker(queueName, processor, { connection, ...(prefix === undefined ? {} : { prefix }) });
    worker.on("failed", (job, err) =>
      log.error({ err, jobId: job?.id, attemptsMade: job?.attemptsMade }, "job failed"),
    );
    let connectionFailed = false;
    function onError(err: Error): void {
      const connectionError = !isNotConnectionError(err);
      if (connectionError && connectionFailed) return;
      if (connectionError) connectionFailed = true;
      log.error({ err }, "worker error");
    }
    worker.on("error", onError);
    // The backend forwards ready again after Redis reconnects.
    worker.getBackend().on("ready", () => { connectionFailed = false; });
    workers.push(worker);
  }
  return workers;
}
