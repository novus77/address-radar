import { createHash, randomUUID } from "node:crypto";
import type { createPostgresUnitOfWork } from "@address-radar/database";
import { createFomoSocketFrameTracker } from "./fomo-socket-provenance.js";
import { stagePostgresFomoMessage } from "./postgres-fomo-normalization.js";

const sourceOrigin = "wss://prod-api.fomo.family";

// Inactive composition adapter. It does not attach, navigate, reconnect or resume a browser.
export function createPostgresFomoCdpCapture(input: {
  readonly unitOfWork: Pick<ReturnType<typeof createPostgresUnitOfWork>, "run">;
  readonly collectorId: string;
  readonly pageId: string;
  readonly capacity: number;
  readonly maximumPayloadBytes: number;
  readonly now?: () => number;
}) {
  for (const value of [input.collectorId, input.pageId]) {
    if (!value.trim() || value.length > 128) throw new Error("FOMO capture identity is invalid");
  }
  for (const value of [input.capacity, input.maximumPayloadBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("FOMO capture bounds must be positive safe integers");
  }
  const tracker = createFomoSocketFrameTracker();
  const sessionId = randomUUID();
  const now = input.now ?? Date.now;
  const pending: { readonly sourceMessageId: string; readonly body: string; readonly receivedAt: number }[] = [];
  let sequence = 0;
  let rejectedCapacity = 0;
  let rejectedWhilePaused = 0;
  let rejectedPayload = 0;
  let committed = 0;
  let writeFailures = 0;
  let pausedReason: "capacity" | "persistence" | "disconnected" | null = null;
  let running: Promise<number> | null = null;

  async function drain(): Promise<number> {
    let count = 0;
    while (pending.length) {
      const frame = pending[0]!;
      try {
        const staged = await input.unitOfWork.run(transaction => stagePostgresFomoMessage(transaction, {
          ...frame, sourceUrl: sourceOrigin, approvedOrigins: [sourceOrigin], maximumPayloadBytes: input.maximumPayloadBytes,
          collectorId: input.collectorId, sessionId,
        }));
        // Do not release the pending delivery until the outer transaction has committed.
        pending.shift();
        if (staged) { committed += 1; count += 1; } else rejectedPayload += 1;
      } catch (error) {
        writeFailures += 1;
        pausedReason = "persistence";
        // Explicit retry reuses this delivery identity, including after an uncertain commit.
        throw error;
      }
    }
    return count;
  }

  return Object.freeze({
    receiveCdpMessage(body: string): boolean {
      // Continue observing socket lifecycle while paused; no new browser page is created.
      const payload = tracker.observe(body);
      if (payload === null) return false;
      if (pausedReason !== null) { rejectedWhilePaused += 1; return false; }
      if (pending.length >= input.capacity) { rejectedCapacity += 1; pausedReason = "capacity"; return false; }
      const receivedAt = now();
      if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) throw new Error("FOMO capture reception time is invalid");
      if (!Number.isSafeInteger(sequence + 1)) throw new Error("FOMO delivery sequence is exhausted");
      sequence += 1;
      const identity = createHash("sha256").update(JSON.stringify([sessionId, input.pageId, sequence])).digest("hex");
      pending.push({ sourceMessageId: `fomo-cdp-delivery:${identity}`, body: payload, receivedAt });
      // Accepted into volatile buffering, not a durable capture acknowledgement.
      return true;
    },
    flush(): Promise<number> {
      if (running !== null) return running;
      running = drain().finally(() => { running = null; });
      return running;
    },
    pause(reason: "disconnected"): void { pausedReason = reason; },
    resume(): boolean {
      if (running !== null || pending.length) return false;
      pausedReason = null;
      return true;
    },
    diagnostics() {
      return Object.freeze({ sessionId, pending: pending.length, committed, rejectedCapacity, rejectedWhilePaused,
        rejectedPayload, writeFailures, pausedReason, coverageComplete: false, replayCoverageVerified: false });
    },
  });
}
