import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { decodePersistedRadarSignal, replayRadarSignalV1 } from "../src/index.js";

const publicSignal = {
  schemaVersion: "1" as const,
  signalId: "solana:TokenA",
  idempotencyKey: "solana:TokenA:broadcast:1",
  token: { chain: "solana", contractAddress: "TokenA", symbol: "TOK", name: "Token A", imageUrl: null },
  category: "new_token_discovery" as const,
  broadcastSequence: 1,
  score: 0.9,
  confidence: 0.85,
  marketCapUsd: 100_000,
  priceUsd: 0.01,
  triggeredAt: new Date(3_000).toISOString(),
  expiresAt: new Date(303_000).toISOString(),
  display: { title: "New token discovery", summary: "2 qualified traders", reasonCodes: ["concurrent_qualified_entries"] },
};

const legacyV1 = {
  ...publicSignal,
  action: "new",
  lifecycleStage: "launched_0_2h",
  windowMs: 300_000,
  evidenceSummary: { participantCount: 2, totalBuyUsd: 2_000, maxSingleBuyUsd: 1_000, sourceState: "FOMO_ONLY", entityIds: ["entity-a", "entity-b"], evidenceIds: ["event-a", "event-b"] },
};

const legacyV2 = {
  version: 2,
  signalId: "radar-signal-v2:1:solana:TokenA:broadcast:1",
  sequence: 1,
  tokenId: "solana:TokenA",
  opportunityType: "SMART_MONEY_CONVERGENCE",
  signalAction: "new",
  signalLevel: "qualified",
  stage: "confirmed",
  confirmedSafetyFacts: [],
  pendingSafetyFacts: [],
  overallScore: 0.9,
  confidenceScore: 0.85,
  riskScore: 0,
  timingScore: 0.9,
  capacityStatus: "not_evaluated",
  materialTriggerClass: "address_intelligence",
  keyReasons: [{ code: "fresh_trader_evidence", evidenceIds: ["event-a"] }],
  riskWarnings: [],
  strategyVersion: "address-intelligence-v1",
  decisionId: "solana:TokenA:broadcast:1",
  publishedAt: 3_000,
};

const sqlitePayload = (payload: unknown, name: string): unknown => {
  const path = join(mkdtempSync(join(tmpdir(), `${name}-`)), "address.sqlite");
  const repository = openAddressRadarRepository(path);
  repository.close();
  const database = new DatabaseSync(path);
  database.prepare("INSERT INTO token_aggregation_state(token_id, chain, token_address, current_score, peak_score, broadcast_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("solana:TokenA", "solana", "TokenA", 0.9, 0.9, 1, 3_000);
  database.prepare("INSERT INTO broadcast_records(broadcast_id, token_id, broadcast_number, strategy_version, score, triggered_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run(name, "solana:TokenA", 1, "address-v1", 0.9, 3_000, JSON.stringify(payload));
  database.close();
  const reopened = openAddressRadarRepository(path);
  const stored = reopened.broadcasts("solana:TokenA")[0]!.payload;
  reopened.close();
  return stored;
};

describe("persisted signal compatibility", () => {
  it("strips internal fields from a bare legacy V1 stored in SQLite", () => {
    const payload = sqlitePayload(legacyV1, "legacy-v1");
    expect(decodePersistedRadarSignal(payload)).toEqual({ status: "replayed", source: "legacy_v1", signal: publicSignal });
    expect(replayRadarSignalV1(payload)).toEqual(publicSignal);
  });

  it("returns a typed unreplayable V2 result when mandatory category and expiry cannot be inferred", () => {
    expect(decodePersistedRadarSignal(sqlitePayload(legacyV2, "legacy-v2-unreplayable"))).toEqual({
      status: "legacy_unreplayable",
      source: "legacy_v2",
      reason: "missing_migration_context",
      signalId: legacyV2.signalId,
      idempotencyKey: legacyV2.decisionId,
    });
  });

  it("normalizes a legacy V2 when trusted migration context supplies mandatory fields", () => {
    const result = decodePersistedRadarSignal(sqlitePayload(legacyV2, "legacy-v2-replayable"), { category: "new_token_discovery", expiresAt: publicSignal.expiresAt, token: { symbol: null, name: null, imageUrl: null } });
    expect(result).toMatchObject({ status: "replayed", source: "legacy_v2", signal: {
      schemaVersion: "1", signalId: "solana:TokenA", idempotencyKey: legacyV2.decisionId,
      token: { chain: "solana", contractAddress: "TokenA", symbol: null, name: null, imageUrl: null },
      category: "new_token_discovery", broadcastSequence: 1, score: 0.9, confidence: 0.85,
      triggeredAt: publicSignal.triggeredAt, expiresAt: publicSignal.expiresAt,
      display: { reasonCodes: ["fresh_trader_evidence"] },
    } });
    expect(Object.keys(result.status === "replayed" ? result.signal : {})).toEqual(Object.keys(publicSignal));
  });

  it("rejects malformed and unsupported legacy records", () => {
    expect(() => decodePersistedRadarSignal({ ...legacyV2, tokenId: "invalid" }, { category: "new_token_discovery", expiresAt: publicSignal.expiresAt })).toThrow(/malformed/i);
    expect(() => decodePersistedRadarSignal({ version: 3 })).toThrow(/unsupported/i);
  });
});
