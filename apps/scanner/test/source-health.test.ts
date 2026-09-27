import { afterEach, describe, expect, it } from "vitest";

import {
  createSourceLedgerStore,
  initializeSourceLedgerSchema,
  openAddressRadarDatabase,
} from "@address-radar/database";
import { createSourceHealthRecorder } from "../src/source-health.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];

function setup(now = 1_000_000) {
  const database = openAddressRadarDatabase(":memory:");
  databases.push(database);
  initializeSourceLedgerSchema(database);
  const ledger = createSourceLedgerStore(database);
  const recorder = createSourceHealthRecorder({ ledger, clock: { now: () => now } });
  return { ledger, recorder };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("source health recorder", () => {
  it("records healthy progress and advances its durable cursor", () => {
    const { ledger, recorder } = setup();
    recorder.recordSuccess({
      source: "rpc_evm",
      chain: "base",
      stream: "rpc_head",
      startedAt: 999_900,
      cursor: "120",
      position: 120,
      lastEventAt: 999_950,
    });

    expect(ledger.sourceCursor("rpc_evm", "base")).toMatchObject({ cursor: "120", position: 120 });
    expect(ledger.sourceHealth("rpc_evm", "base")).toMatchObject({
      state: "healthy",
      lastSuccessAt: 1_000_000,
      lastEventAt: 999_950,
      consecutiveFailures: 0,
      latencyMs: 100,
      cursor: "120",
    });
  });

  it("keeps a quiet stream healthy when its cursor advances", () => {
    const { ledger, recorder } = setup();
    recorder.recordSuccess({ source: "fomo_feed", chain: "solana", stream: "fomo_live", startedAt: 999_990, cursor: "41", position: 41 });
    recorder.recordSuccess({ source: "fomo_feed", chain: "solana", stream: "fomo_live", startedAt: 999_990, cursor: "42", position: 42 });
    expect(ledger.sourceHealth("fomo_feed", "solana")?.state).toBe("healthy");
  });

  it("marks a stream stale when neither events nor cursors advance", () => {
    const { ledger, recorder } = setup(1_000_000);
    ledger.advanceCursor({ source: "fomo_feed", chain: "bsc", cursor: "7", position: 7, updatedAt: 600_000 });
    recorder.recordSuccess({ source: "fomo_feed", chain: "bsc", stream: "fomo_live", startedAt: 999_990, cursor: "7", position: 7 });
    expect(ledger.sourceHealth("fomo_feed", "bsc")?.state).toBe("stale");
  });

  it("records rate limits and clears them after a successful attempt", () => {
    const { ledger, recorder } = setup();
    recorder.recordFailure({ source: "dexscreener", chain: "eth", stream: "market_snapshot", startedAt: 999_900, errorCode: "rate_limited", rateLimitResetAt: 1_030_000 });
    expect(ledger.sourceHealth("dexscreener", "eth")).toMatchObject({ state: "rate_limited", rateLimitResetAt: 1_030_000, consecutiveFailures: 1 });

    recorder.recordSuccess({ source: "dexscreener", chain: "eth", stream: "market_snapshot", startedAt: 999_950, cursor: "8", position: 8 });
    expect(ledger.sourceHealth("dexscreener", "eth")).toMatchObject({ state: "healthy", rateLimitResetAt: null, consecutiveFailures: 0 });
  });

  it("isolates a failed chain from a healthy provider-chain pair", () => {
    const { ledger, recorder } = setup();
    recorder.recordSuccess({ source: "rpc_evm", chain: "base", stream: "rpc_head", startedAt: 999_900, cursor: "20", position: 20 });
    recorder.recordFailure({ source: "rpc_evm", chain: "bsc", stream: "rpc_head", startedAt: 999_900, errorCode: "transport" });

    expect(ledger.sourceHealth("rpc_evm", "base")?.state).toBe("healthy");
    expect(ledger.sourceHealth("rpc_evm", "bsc")?.state).toBe("unavailable");
  });
});
