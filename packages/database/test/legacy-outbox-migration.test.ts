import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";

const signal = { schemaVersion: "1", signalId: "solana:TokenA", idempotencyKey: "solana:TokenA:broadcast:1", token: { chain: "solana", contractAddress: "TokenA", symbol: null, name: null, imageUrl: null }, category: "new_token_discovery", broadcastSequence: 1, score: 0.9, confidence: 0.9, marketCapUsd: null, priceUsd: null, triggeredAt: new Date(1_000).toISOString(), expiresAt: new Date(301_000).toISOString(), display: { title: "New token discovery", summary: "Qualified traders", reasonCodes: ["concurrent_qualified_entries"] } };
const legacyV2 = { version: 2, signalId: "legacy-v2", decisionId: "legacy-v2:decision", tokenId: "solana:TokenB", sequence: 1, publishedAt: 1_000, overallScore: 0.8, confidenceScore: 0.8, keyReasons: [{ code: "fresh_trader_evidence" }] };

describe("pre-outbox broadcast migration", () => {
  it("holds valid history, dead-letters unreplayable history, supports approval, and reruns idempotently", () => {
    const path = join(mkdtempSync(join(tmpdir(), "legacy-outbox-")), "address.sqlite");
    const initial = new DatabaseSync(path);
    migrateAddressRadarDatabase(initial);
    for (const token of ["TokenA", "TokenB", "TokenC"]) initial.prepare("INSERT INTO token_aggregation_state(token_id, chain, token_address, current_score, peak_score, broadcast_count, updated_at) VALUES (?, 'solana', ?, 0.9, 0.9, 1, 1000)").run(`solana:${token}`, token);
    const insert = initial.prepare("INSERT INTO broadcast_records(broadcast_id, token_id, broadcast_number, strategy_version, score, triggered_at, payload) VALUES (?, ?, 1, 'legacy', 0.9, 1000, ?)");
    insert.run("legacy-valid", "solana:TokenA", JSON.stringify(signal));
    insert.run("legacy-unreplayable", "solana:TokenB", JSON.stringify(legacyV2));
    insert.run("legacy-malformed", "solana:TokenC", "{bad-json");
    migrateAddressRadarDatabase(initial);
    migrateAddressRadarDatabase(initial);
    initial.close();

    const repository = openAddressRadarRepository(path);
    expect(repository.legacySignalOutboxReviews()).toEqual([
      expect.objectContaining({ reviewId: "legacy-review:legacy-malformed", status: "dead_letter", validationStatus: "invalid", reason: expect.any(String) }),
      expect.objectContaining({ reviewId: "legacy-review:legacy-unreplayable", status: "dead_letter", validationStatus: "legacy_unreplayable", reason: "missing_migration_context" }),
      expect.objectContaining({ reviewId: "legacy-review:legacy-valid", status: "legacy_review", validationStatus: "valid", idempotencyKey: signal.idempotencyKey }),
    ]);
    expect(repository.pendingSignalOutbox()).toEqual([]);
    expect(repository.approveLegacySignalOutbox("legacy-review:legacy-unreplayable", 2_000)).toBe(false);
    expect(repository.approveLegacySignalOutbox("legacy-review:legacy-valid", 2_000)).toBe(true);
    expect(repository.pendingSignalOutbox()).toEqual([expect.objectContaining({ broadcastId: "legacy-valid", status: "pending", broadcastSequence: 1 })]);
    expect(repository.approveLegacySignalOutbox("legacy-review:legacy-valid", 2_001)).toBe(false);
    expect(repository.legacySignalOutboxReviews()).toHaveLength(3);
    repository.close();
  });
});
