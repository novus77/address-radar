/** A planned yield is not a failed query, COMMIT acknowledgement, or parity proof. */
export class PreservationImportYield extends Error {
  constructor() { super("PRESERVATION_IMPORT_YIELDED_BEFORE_TRANSACTION"); }
}

const CLOSE_RESERVE_MS = 10_000;

/** Check before opening UOW, never by interrupting an in-flight transaction. */
export async function withPreservationImportAdmission<T>(config: {
  stage: string; deadlineAtMs: number; maximumTransactionMs: number;
}, operation: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  if (config.stage === "import") {
    const time = now();
    if (![time, config.deadlineAtMs, config.maximumTransactionMs].every(Number.isSafeInteger)
      || time < 0 || config.maximumTransactionMs <= 0 || config.maximumTransactionMs > 60_000) {
      throw new Error("PRESERVATION_IMPORT_INVALID_BOUNDARY");
    }
    if (config.deadlineAtMs - time <= config.maximumTransactionMs + CLOSE_RESERVE_MS) {
      throw new PreservationImportYield();
    }
  }
  return await operation();
}
