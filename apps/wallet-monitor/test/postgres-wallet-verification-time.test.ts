import { describe, expect, it, vi } from "vitest";
import type { PostgresTransaction } from "@address-radar/database";
import {
  createPostgresWalletChannel, preparePostgresWalletCapture, walletPurchaseBasisFingerprint,
  type PostgresWalletChannelOptions,
} from "../src/postgres-wallet-channel.js";
import { deriveExecutionBasis } from "../src/execution-basis.js";

const walletAddress = "11111111111111111111111111111111";
const profile = {
  wallet: { address: walletAddress, accountId: "account", entityId: "entity", lifecycle: "active" as const },
  fact: { entityId: "entity", channel: "wallet" as const, subjectId: walletAddress, walletFamily: "solana" as const,
    associationConfidence: "confirmed" as const, associationSource: "chain_link", ownerCount: 1,
    walletConfidence: "confirmed" as const, walletSource: "chain_link", identityEvidenceRef: "identity:fixture",
    ownershipEvidenceRef: "owner:fixture", monitoringEnabled: true, suspended: false },
  profileEnabled: true, profileSuspended: false, bindingState: "owned" as const, versionId: "profile:v1",
};
const basis = deriveExecutionBasis({ successful: true, swapConfirmed: true,
  tokenDeltas: [{ asset: "TokenCase", quantity: 100 }],
  quoteDeltas: [{ asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC",
    quantity: -60, verifiedStablecoin: true }] });
const event = { eventId: "solana:fixture:1", chain: "solana", walletAddress, tokenAddress: "TokenCase", side: "buy" as const,
  amountUsd: 60, priceUsd: 0.6, marketCapUsd: null, occurredAt: 100_000,
  sourceReference: "solana:fixture", executionBasis: basis };
const purchase = { ...preparePostgresWalletCapture({ generationId: "generation", collectorId: "solana",
  sessionId: "fixture", chainFamily: "solana", receivedAt: 200_000, event, profile,
  executionTrust: "rpc_execution" }).payload.purchase!, executionEvidenceRef: "fixture:validation" };
const verified = (verifiedAt: number) => ({ status: "verified" as const, purchase,
  externalBasis: { verifierId: "fixture-validator", evidenceRef: purchase.executionEvidenceRef,
    generationId: "generation", sourceReference: event.sourceReference, executionKey: purchase.executionKey,
    purchaseFingerprint: walletPurchaseBasisFingerprint(purchase), verifiedAt } });

function harness(verifyPurchase: NonNullable<PostgresWalletChannelOptions["verifyPurchase"]>,
  now: () => number, eventCount = 1, maximumRunMs = 1000) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const transaction: PostgresTransaction = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes("RETURNING claim_generation")) return { rows: [{ claim_generation: 1,
      checkpoints_json: "{}", lease_expires_at: 260_000 }], rowCount: 1 };
    if (sql.includes("SELECT * FROM wallet_channel_collectors")) return { rows: [{ claim_generation: 1 }], rowCount: 1 };
    if (sql.includes("SELECT original_fingerprint")) return { rows: [{ original_fingerprint: null, revision_count: 0 }], rowCount: 1 };
    if (sql.includes("SELECT revision_number")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT job_id")) return { rows: [{ job_id: "fixture-job" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const channel = createPostgresWalletChannel({ generationId: "generation", ownerId: "owner", sessionId: "fixture",
    run: operation => operation(transaction), profiles: { async load() { return { status: "ready", profiles: [profile] }; } },
    collectors: [{ executionTrust: "rpc_execution", collector: { name: "solana", chainFamily: "solana", async collect() {
      return { partitions: [{ partitionKey: `wallet:${walletAddress}`, nextCheckpoint: "completed",
        events: Array.from({ length: eventCount }, (_, index) => ({ ...event, eventId: `${event.eventId}:${index}` })) }] };
    } } }], maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1, leaseMs: 60_000,
    maximumPayloadBytes: 65536, maximumRunMs, now, verifyPurchase });
  return { channel, calls };
}

describe("wallet capture time after independent publication", () => {
  it("commits evidence checked after collection instead of rejecting it as future validation", async () => {
    let now = 200_000;
    const f = harness(async () => { now += 10; return verified(now); }, () => now, 2);
    expect(await f.channel.pollOnce()).toMatchObject({ captured: 2, failed: 0 });
    const revisions = f.calls.filter(call => call.sql.includes("INSERT INTO capture_event_revisions"));
    expect(revisions).toHaveLength(2);
    expect(revisions.map(call => JSON.parse(String(call.values[5])).externalBasis.verifiedAt)).toEqual([200_010, 200_020]);
    expect(f.calls.filter(call => call.sql.includes("INSERT INTO wallet_capture_generation_bindings"))
      .map(call => call.values[4])).toEqual([200_010, 200_020]);
    expect(f.calls.filter(call => call.sql.includes("INSERT INTO capture_normalization_jobs"))
      .map(call => call.values[5])).toEqual([200_010, 200_020]);
    expect(f.calls.some(call => call.sql.includes("SET checkpoints_json"))).toBe(true);
  });

  it("still rejects genuinely future validation without appending or advancing", async () => {
    const f = harness(async () => verified(200_001), () => 200_000);
    const result = await f.channel.pollOnce();
    expect(result).toMatchObject({ captured: 0, failed: 1,
      diagnostics: [{ stage: "prepare", reasonCode: "execution_verification_time_or_generation_mismatch" }] });
    expect(f.calls.some(call => call.sql.includes("INSERT INTO capture_event_revisions") || call.sql.includes("SET checkpoints_json"))).toBe(false);
  });

  it("timestamps deferred captures after verification without promoting their numeric basis", async () => {
    let now = 200_000;
    const f = harness(async () => { now += 10; return { status: "deferred", reasonCode: "fixture_proof_unavailable" }; }, () => now);
    expect(await f.channel.pollOnce()).toMatchObject({ captured: 1, failed: 0 });
    const revision = f.calls.find(call => call.sql.includes("INSERT INTO capture_event_revisions"));
    expect(JSON.parse(String(revision?.values[5])).purchase).toBeNull();
    expect(f.calls.find(call => call.sql.includes("INSERT INTO wallet_capture_generation_bindings"))?.values[4]).toBe(200_010);
  });

  it("does not commit or overlap a verification still running after the collector deadline", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: ReturnType<typeof verified>) => void;
      const f = harness(async () => new Promise(resolve => { finish = resolve; }), () => 200_000, 1, 80);
      const pending = f.channel.pollOnce();
      await vi.advanceTimersByTimeAsync(81);
      expect(await pending).toMatchObject({ captured: 0, failed: 1,
        diagnostics: [{ stage: "verify_purchase", reasonCode: "timeout" }] });
      const statements = f.calls.length;
      expect(await f.channel.pollOnce()).toMatchObject({ deferred: 1, attempted: 0 });
      expect(f.calls).toHaveLength(statements);
      finish(verified(200_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls.some(call => call.sql.includes("INSERT INTO capture_event_revisions") || call.sql.includes("SET checkpoints_json"))).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
