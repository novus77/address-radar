import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSourceObservation, type TraderEvent } from "@address-radar/domain";
import {
  createCandidateHistoryStore,
  createSourceLedgerStore,
  initializeCandidateHistorySchema,
  initializeSourceLedgerSchema,
  openAddressRadarDatabase,
  openAddressRadarRepository,
} from "@address-radar/database";
import { createSourceObservationIngestor } from "@address-radar/collectors";
import { createHistoricalEvidenceService } from "../../wallet-analysis/src/historical-evidence.js";
import { createScannerRuntime } from "../src/runtime.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

const event = (source: TraderEvent["source"]): TraderEvent => ({
  eventId: "canonical-trade-1",
  accountId: "account-1",
  entityId: "entity-1",
  chain: "base",
  tokenAddress: "0xabc",
  side: "buy",
  amountUsd: 100,
  priceUsd: 0.01,
  marketCapUsd: 10_000,
  tokenAgeMs: null,
  occurredAt: 1_000,
  collectedAt: 1_100,
  source,
});

describe("multi-source replay", () => {
  it("keeps source observations while converging canonical events and candidate evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-replay-"));
    directories.push(directory);
    const path = join(directory, "radar.sqlite");
    const repository = openAddressRadarRepository(path);
    repository.upsertFomoAccount({ accountId: "account-1", handle: "alpha", firstSeenAt: 1_000, lastSeenAt: 1_000 });
    repository.ensureTraderEntity({ entityId: "entity-1", lifecycle: "candidate", manual: false, locked: false, createdAt: 1_000, updatedAt: 1_000 });
    repository.linkAccountToEntity({ entityId: "entity-1", accountId: "account-1", confidence: "confirmed", source: "test", observedAt: 1_000 });
    const database = openAddressRadarDatabase(path);
    initializeSourceLedgerSchema(database);
    initializeCandidateHistorySchema(database);
    const ledger = createSourceLedgerStore(database);
    const ingestor = createSourceObservationIngestor({ sourceLedger: ledger, eventRepository: repository });

    await ingestor.ingest({ events: [event("fomo_stream")], extractionMode: "network" });
    await ingestor.ingest({ events: [event("onchain_wallet")], extractionMode: "rpc" });
    ledger.saveObservation(createSourceObservation({ source: "dune", sourceEventId: "dune-row-1", chain: "base", observedAt: 1_000, collectedAt: 1_200, payloadVersion: 1, payload: event("fomo_token_history"), confidence: 0.85, extractionMode: "api", provenance: { queryId: "query-1" } }));
    repository.insertTraderEvent(event("fomo_token_history"));

    const history = createCandidateHistoryStore(database);
    history.saveHistoricalToken({ tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc", symbol: "ABC", imageUrl: null, firstTradeAt: 500, firstReached1mAt: 2_000, peakMarketCapUsd: 500_000, source: "test", sourceQueryId: null, provenance: {} });
    history.saveMilestoneCrossing({ milestoneId: "base:0xabc:500000", tokenId: "base:0xabc", marketCapUsd: 500_000, crossedAt: 2_000, precision: "exact", source: "test", sourceEventIds: ["canonical-trade-1"], strategyVersion: "test" });
    const evidence = createHistoricalEvidenceService({ store: history, resolveTraderId: () => "entity-1", strategyVersion: "test" });
    const rows = ["fomo", "rpc", "dune"].map((source, index) => ({ eventId: `${source}-${index}`, economicKey: "canonical-trade-1", chain: "base", tokenAddress: "0xabc", traderAddress: "0xwallet", side: "buy" as const, amountUsd: 100, marketCapUsd: 10_000, occurredAt: 1_000, source }));
    evidence.ingest(rows, 3_000);
    evidence.ingest(rows, 3_000);

    expect((database.prepare("SELECT COUNT(*) AS count FROM source_observations").get() as { count: number }).count).toBe(3);
    expect((database.prepare("SELECT COUNT(*) AS count FROM trader_events").get() as { count: number }).count).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_trader_events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT source_status AS sourceStatus FROM canonical_trader_events").get())
      .toEqual({ sourceStatus: "FOMO_AND_ONCHAIN" });
    expect(history.evidenceForTrader("entity-1")).toHaveLength(1);
    database.close();
    repository.close();
  });

  it("isolates RPC failure, records a recoverable gap, and continues real-time aggregation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-failure-"));
    directories.push(directory);
    const path = join(directory, "radar.sqlite");
    const repository = openAddressRadarRepository(path);
    const database = openAddressRadarDatabase(path);
    initializeSourceLedgerSchema(database);
    const ledger = createSourceLedgerStore(database);
    const runtime = createScannerRuntime({
      repository,
      tokenStateStore: ledger,
      sourceHealthLedger: ledger,
      collectors: [
        { name: "rpc-primary", healthTargets: [{ source: "rpc_evm", chain: "base", stream: "rpc_head" }], async collect() { throw new Error("primary unavailable"); } },
        { name: "fomo-live", async collect() { return [{ chain: "base", tokenAddress: "0xabc", evidence: { eventId: "fomo-live-1", entityId: "entity-1", contribution: 1, occurredAt: 2_000, source: "fomo", side: "buy", amountUsd: 100, lifecycleStage: "launched_0_2h", traderTags: [] } }]; } },
      ],
      clock: { now: () => 3_000 },
      config: { signalThreshold: 0.1, minimumAggregateBuyUsd: 0, strategyVersion: "test", allowedChains: ["base"], excludedTokenIds: [], minimumPurchaseUsd: 0 } as never,
    });

    const result = await runtime.runOnce();
    expect(result).toMatchObject({ collectorFailures: 1, accepted: 1 });
    expect(ledger.sourceHealth("rpc_evm", "base")?.state).toBe("unavailable");
    expect(ledger.recoveryJob("recovery:rpc_gap:base:rpc-primary")?.status).toBe("pending");
    database.close();
    repository.close();
  });
});
