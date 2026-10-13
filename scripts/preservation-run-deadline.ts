const MAXIMUM_WINDOW_MS = 3_600_000;
const CLEANUP_RESERVE_MS = 60_000;
const TRANSPORT_RESERVE_MS = 40_000;
const STAGES = new Set(["install", "calibrate", "interrupt", "import", "resume", "parity"]);

function assertClock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("PRESERVATION_INVALID_CLOCK");
}

/** A deadline bounds a rehearsal; it never supplies maintenance or database authority. */
export function readPreservationRunDeadline(raw: string | undefined, now: number): number | undefined {
  assertClock(now);
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new Error("PRESERVATION_INVALID_RUN_DEADLINE");
  const deadline = Number(raw);
  if (!Number.isSafeInteger(deadline) || deadline <= now || deadline - now > MAXIMUM_WINDOW_MS) {
    throw new Error("PRESERVATION_INVALID_RUN_DEADLINE");
  }
  return deadline;
}

export function preservationStageDeadline(stage: string, now: number, runDeadlineAtMs?: number): {
  deadlineAtMs: number; timeoutSeconds: number; transportTimeoutMs: number;
} {
  assertClock(now);
  if (!STAGES.has(stage)) throw new Error("PRESERVATION_INVALID_STAGE");
  let maximumWorkMs = stage === "install" || stage === "calibrate" ? 180_000 : 900_000;
  if (runDeadlineAtMs !== undefined) {
    if (!Number.isSafeInteger(runDeadlineAtMs) || runDeadlineAtMs < 0) throw new Error("PRESERVATION_INVALID_RUN_DEADLINE");
    maximumWorkMs = Math.min(maximumWorkMs, runDeadlineAtMs - now - CLEANUP_RESERVE_MS - TRANSPORT_RESERVE_MS);
  }
  if (maximumWorkMs < 1_000) throw new Error("PRESERVATION_RUN_DEADLINE_EXHAUSTED");
  const deadlineAtMs = now + maximumWorkMs;
  if (!Number.isSafeInteger(deadlineAtMs)) throw new Error("PRESERVATION_INVALID_RUN_DEADLINE");
  return { deadlineAtMs, timeoutSeconds: Math.ceil(maximumWorkMs / 1_000) + 10,
    transportTimeoutMs: maximumWorkMs + TRANSPORT_RESERVE_MS };
}
