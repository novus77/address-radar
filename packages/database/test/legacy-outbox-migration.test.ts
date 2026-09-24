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
    expect(repository.approveLegacySignalOutbox({ reviewId: "legacy-review:legacy-unreplayable", operator: "tester", reason: "approved after review", decidedAt: 2_000 })).toBe(false);
    expect(repository.approveLegacySignalOutbox({ reviewId: "legacy-review:legacy-valid", operator: "tester", reason: "approved after review", decidedAt: 2_000 })).toBe(true);
    expect(repository.pendingSignalOutbox()).toEqual([expect.objectContaining({ broadcastId: "legacy-valid", status: "pending", broadcastSequence: 1 })]);
    expect(repository.approveLegacySignalOutbox({ reviewId: "legacy-review:legacy-valid", operator: "tester", reason: "duplicate", decidedAt: 2_001 })).toBe(false);
    expect(repository.legacySignalOutboxReviews()).toHaveLength(3);
    repository.close();
  });

  it("blocks later sequences until earlier reviews are approved or explicitly skipped", () => {
    const path = join(mkdtempSync(join(tmpdir(), "legacy-order-")), "address.sqlite");
    const database = new DatabaseSync(path);
    migrateAddressRadarDatabase(database);
    const addToken = (token: string, withSecondOutbox: boolean) => {
      const tokenId = `solana:${token}`;
      database.prepare("INSERT INTO token_aggregation_state(token_id, chain, token_address, current_score, peak_score, broadcast_count, updated_at) VALUES (?, 'solana', ?, 0.9, 0.9, 2, 2000)").run(tokenId, token);
      for (const sequence of [1, 2]) {
        const payload = { ...signal, signalId: tokenId, idempotencyKey: `${tokenId}:broadcast:${sequence}`, token: { ...signal.token, contractAddress: token }, broadcastSequence: sequence, triggeredAt: new Date(sequence * 1_000).toISOString(), expiresAt: new Date(sequence * 1_000 + 300_000).toISOString() };
        database.prepare("INSERT INTO broadcast_records(broadcast_id, token_id, broadcast_number, strategy_version, score, triggered_at, payload) VALUES (?, ?, ?, 'legacy', 0.9, ?, ?)").run(`${token}-broadcast-${sequence}`, tokenId, sequence, sequence * 1_000, JSON.stringify(payload));
        if (sequence === 2 && withSecondOutbox) database.prepare("INSERT INTO signal_outbox(outbox_id, broadcast_id, token_id, broadcast_sequence, payload, status, attempt_count, next_retry_at, created_at) VALUES (?, ?, ?, 2, ?, 'pending', 0, 2000, 2000)").run(`outbox:${token}-broadcast-2`, `${token}-broadcast-2`, tokenId, JSON.stringify(payload));
      }
    };
    addToken("Approve", true);
    addToken("Skip", true);
    addToken("Review", false);
    migrateAddressRadarDatabase(database);
    database.close();

    const repository = openAddressRadarRepository(path);
    expect(repository.claimSignalOutbox({ workerId: "worker", now: 3_000, leaseMs: 1_000 })).toBeNull();
    expect(repository.approveLegacySignalOutbox({ reviewId: "legacy-review:Approve-broadcast-1", operator: "alice", reason: "safe to replay", decidedAt: 3_000 })).toBe(true);
    const first = repository.claimSignalOutbox({ workerId: "worker", now: 3_001, leaseMs: 1_000 })!;
    expect(first).toMatchObject({ tokenId: "solana:Approve", broadcastSequence: 1 });
    expect(repository.markSignalOutboxDelivered({ outboxId: first.outboxId, claimToken: first.claimToken!, deliveredAt: 3_002 })).toBe(true);
    expect(repository.claimSignalOutbox({ workerId: "worker", now: 3_003, leaseMs: 1_000 })).toMatchObject({ tokenId: "solana:Approve", broadcastSequence: 2 });

    expect(repository.skipLegacySignalOutbox({ reviewId: "legacy-review:Skip-broadcast-1", operator: "bob", reason: "known historical delivery", decidedAt: 3_010 })).toBe(true);
    expect(repository.claimSignalOutbox({ workerId: "worker-2", now: 3_011, leaseMs: 1_000 })).toMatchObject({ tokenId: "solana:Skip", broadcastSequence: 2 });
    expect(repository.legacySignalOutboxReviews().find(row => row.reviewId === "legacy-review:Skip-broadcast-1")).toMatchObject({ decision: "skipped", decidedBy: "bob", decisionReason: "known historical delivery", decidedAt: 3_010 });

    expect(repository.approveLegacySignalOutbox({ reviewId: "legacy-review:Review-broadcast-2", operator: "alice", reason: "out of order", decidedAt: 3_020 })).toBe(false);
    expect(repository.skipLegacySignalOutbox({ reviewId: "legacy-review:Review-broadcast-2", operator: "alice", reason: "out of order", decidedAt: 3_020 })).toBe(false);
    repository.close();
  });
});
