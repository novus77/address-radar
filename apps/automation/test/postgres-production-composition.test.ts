import { describe, expect, it, vi } from "vitest";
import { createPostgresUnitOfWork, type PostgresTransaction } from "@address-radar/database";
import { boundPostgresOpportunityEvidence, createPostgresProductionComposition, receivePostgresProductionPriceBatch,
  type PostgresProductionCompositionOptions, type PostgresProductionPriceLease } from "../src/postgres-production-composition.js";
import { preparePostgresWalletCapture, resolveCapturedWalletPurchase } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { deriveExecutionBasis } from "../../wallet-monitor/src/execution-basis.js";

function harness() {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx: PostgresTransaction = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes("current_database()")) return { rows: [{ database: "radar_test", username: "radar", schema: "radar",
      server_address: "127.0.0.1", server_port: 5432 }], rowCount: 1 };
    if (sql.includes("SELECT activated_at")) return { rows: [{ activated_at: 100 }], rowCount: 1 };
    if (sql.includes("SELECT * FROM forward_capability_reconcile_cursors")) return { rows: [{ next_cycle_at: 0, last_entity_id: null }], rowCount: 1 };
    if (sql.includes("AS required(name)")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  } };
  const options: PostgresProductionCompositionOptions = {
    runtime: { backend: "postgresql", run: operation => operation(tx), async probe() {
      return { database: "radar_test", username: "radar", schema: "radar", serverAddress: "127.0.0.1", serverPort: 5432,
        generation: "generation", service: "automation", schemaVersion: 1, schemaFingerprint: "a".repeat(64) };
    } },
    identity: { database: "radar_test", username: "radar", schema: "radar", serverAddress: "127.0.0.1", serverPort: 5432,
      service: "automation", schemaVersion: 1, schemaFingerprint: "a".repeat(64) },
    generation: { generationId: "generation", activatedAt: 100 }, ownerId: "owner",
    principal: { actorId: "actor", authorizationEvidenceRef: "permission:proof", permissions: ["target_registry_write"] },
    adapters: {
      async purchase() { return { status: "deferred", reasonCode: "execution_unavailable" }; },
      async prices() { return { status: "deferred", reasonCode: "price_unavailable" }; },
      async target() { return { status: "unavailable" }; },
      async safety() { return { status: "deferred", reasonCode: "risk_unavailable" }; },
    },
    quotas: { normalization: 1, token: 1, purchase: 1, fanout: 1, opportunity: 1, capability: 1, signal: 1 },
    admissionLimit: 5, maximumClaims: 7, maximumRunMs: 10_000, leaseMs: 60_000,
    retryDelayMs: 1000, maximumPayloadBytes: 65536, maximumSamples: 10, factLimit: 10, reconcileIntervalMs: 60_000,
    now: () => 1000,
  };
  return { options, tx, calls };
}

function purchaseFixture(amount = 60, failReceipt = false) {
  const fixture = harness(), { tx, options, calls } = fixture;
  const wallet = "11111111111111111111111111111111", token = "TokenCase";
  const profile = { wallet: { address: wallet, accountId: "account", entityId: "entity", lifecycle: "active" as const },
    fact: { entityId: "entity", channel: "wallet" as const, subjectId: wallet, walletFamily: "solana" as const,
      associationConfidence: "confirmed" as const, associationSource: "fixture", ownerCount: 1,
      walletConfidence: "confirmed" as const, walletSource: "fixture", identityEvidenceRef: "fixture:identity",
      ownershipEvidenceRef: "fixture:owner", monitoringEnabled: true, suspended: false },
    profileEnabled: true, profileSuspended: false, bindingState: "owned" as const, versionId: "fixture:profile" };
  const basis = deriveExecutionBasis({ successful: true, swapConfirmed: true,
    tokenDeltas: [{ asset: token, quantity: 100 }], quoteDeltas: [{ asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", quantity: -amount, verifiedStablecoin: true }] });
  const captured = preparePostgresWalletCapture({ generationId: "generation", collectorId: "solana", sessionId: "fixture",
    chainFamily: "solana", receivedAt: 1000, profile, executionTrust: "rpc_execution",
    event: { eventId: "solana:fixture:1", chain: "solana", walletAddress: wallet, tokenAddress: token, side: "buy",
      amountUsd: amount, priceUsd: amount / 100, marketCapUsd: null, occurredAt: 900,
      sourceReference: "solana:fixture", executionBasis: basis } });
  const source = { event_kind: "buy", source_user_id: "account", entity_id: "entity", chain: "solana", token_address: token,
    requires_review: false, normalized_payload: JSON.stringify(captured.payload) };
  let fingerprint = "", claimed = new Set<string>();
  const leased = { intent_id: "intent", job_id: "job", semantic_fingerprint: "input-fingerprint", parser_version: "wallet-chain-v1",
    claim_generation: 1, lease_expires_at: 61_000, requires_review: false };
  const base = tx.query;
  tx.query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes("FROM capture_consumer_jobs WHERE") && sql.includes("WITH due AS") && !claimed.has(String(values[0]))) {
      claimed.add(String(values[0])); return { rows: [leased], rowCount: 1 };
    }
    if (sql.startsWith("SELECT w.*,i.job_id")) return { rows: [leased], rowCount: 1 };
    if (sql.startsWith("SELECT") && sql.includes("FROM capture_normalized_results WHERE job_id")) return { rows: [source], rowCount: 1 };
    if (sql.startsWith("INSERT INTO forward_economic_trades")) fingerprint = String(values[3]);
    if (sql.startsWith("SELECT * FROM forward_economic_trades")) return { rows: [{ trade_id: "trade", original_fingerprint: fingerprint, entity_id: "entity" }], rowCount: 1 };
    if (sql.startsWith("SELECT sample_id FROM forward_purchase_samples")) return { rows: [{ sample_id: "sample" }], rowCount: 1 };
    if (sql.startsWith("SELECT * FROM forward_purchase_samples WHERE sample_id")) return { rows: [{ sample_id: "sample", generation_id: "generation",
      execution_fingerprint: fingerprint, chain: "solana", token_address: token, occurred_at: 900, expires_at: 2_592_000_900 }], rowCount: 1 };
    if (sql.startsWith("SELECT sample_id FROM forward_sample_work_intents")) return { rows: [{ sample_id: "sample" }], rowCount: 1 };
    if (sql.startsWith("SELECT * FROM forward_token_watches")) return { rows: [{ generation_id: "generation", chain: "solana", token_address: token,
      first_discovered_at: 1000, capture_until: 604_801_000, screening_enabled_at: null }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO forward_opportunity_requests")) return { rows: [{ request_key: values[3] }], rowCount: 1 };
    if (sql.startsWith("SELECT 1 FROM forward_strategy_generations g WHERE")) return { rows: [{ exists: true }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO forward_capability_requests") || sql.startsWith("INSERT INTO forward_capability_jobs")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("INSERT INTO capture_consumer_receipts") && values[1] === "forward_purchase_match" && failReceipt) throw new Error("Receipt write interrupted");
    return base(sql, values);
  };
  options.adapters.purchase = async input => resolveCapturedWalletPurchase(input.payload, input.generationId);
  return { ...fixture, source, captured };
}

describe("durable bounded admission regressions", () => {
  it("acknowledges opportunity source intent only after a durable idempotent request", async () => {
    const { options,tx,calls } = purchaseFixture(); const base = tx.query;
    tx.query = async (sql,values = []) => {
      if (sql.startsWith("SELECT i.sample_id,i.execution_fingerprint")) {
        calls.push({sql,values});return {rows:[{sample_id:"sample",execution_fingerprint:"actual-fingerprint"}],rowCount:1};
      }
      if (sql.startsWith("SELECT * FROM forward_purchase_samples WHERE sample_id")) return {rows:[{sample_id:"sample",generation_id:"generation",
        execution_fingerprint:"actual-fingerprint",chain:"solana",token_address:"TokenCase",occurred_at:900,expires_at:2_592_000_900}],rowCount:1};
      return base(sql,values);
    };
    await (await createPostgresProductionComposition({...options,activeStages:["opportunity"],includePrices:false})).runOnce();
    const request = calls.findIndex(call => call.sql.startsWith("INSERT INTO forward_opportunity_requests"));
    const acknowledgement = calls.findIndex(call => call.sql.includes("UPDATE forward_sample_work_intents SET status='dispatched'"));
    expect(request).toBeGreaterThanOrEqual(0);expect(acknowledgement).toBeGreaterThan(request);
    expect(calls.some(call => call.sql.includes("i.execution_fingerprint=s.execution_fingerprint"))).toBe(true);
  });
  it("deduplicates same-clock new purchase wakes by immutable source key, not assessment time", async () => {
    const {options,tx,calls} = harness(), base = tx.query, receipts = new Set<string>();
    const wakes = ["sample-a","sample-b"].map(key=>({source_kind:"sample",source_key:key,chain:"solana",token_address:"TokenCase",changed_at:900}));
    tx.query = async (sql,values=[]) => {
      if (sql.includes("wallet-signal-wake-admission")) { calls.push({sql,values});return {rows:wakes.filter(row=>!receipts.has(row.source_key)),rowCount:2}; }
      if (sql.startsWith("INSERT INTO wallet_forward_signal_wake_receipts")) {
        calls.push({sql,values});
        const key=String(values[2]);if(receipts.has(key))return {rows:[],rowCount:0};receipts.add(key);return {rows:[{source_key:key}],rowCount:1};
      }
      return base(sql,values);
    };
    const composition = await createPostgresProductionComposition({...options,activeStages:["signal"],includePrices:false});
    await composition.runOnce();await composition.runOnce();
    expect(receipts.size).toBe(2);
    const upserts=calls.filter(call=>call.sql.startsWith("INSERT INTO wallet_forward_signal_jobs"));
    expect(upserts).toHaveLength(2);expect(upserts[0]?.sql).toContain("wake_generation+1");
    const admission=calls.find(call=>call.sql.includes("wallet-signal-wake-admission"))!;
    expect(admission.sql).toContain("NOT EXISTS(SELECT 1 FROM wallet_forward_signal_wake_receipts");
    expect(admission.sql).toContain("'authorization'");expect(admission.sql).toContain("'revision'");
    expect(admission.sql).toContain("LIMIT $4");
  });
  it("stops expired/idle tokens without a recurring clock-only wake", async () => {
    const {options,calls}=harness();
    await (await createPostgresProductionComposition({...options,activeStages:["signal"],includePrices:false})).runOnce();
    const expiry=calls.find(call=>call.sql.includes("wallet-signal-expire"))!;
    expect(expiry.sql).toContain("status='expired'");expect(expiry.sql).toContain("LIMIT $4");
    const claim=calls.find(call=>call.sql.includes("UPDATE wallet_forward_signal_jobs j")&&call.sql.includes("RETURNING"))!;
    expect(claim.sql).toContain("status='pending'");expect(claim.sql).not.toContain("status='waiting_source'");
  });
});

describe("bounded PostgreSQL production composition", () => {
  it("rejects implicit runtime identities and incompatible total claim budgets before SQL", async () => {
    const { options, calls } = harness();
    await expect(createPostgresProductionComposition({ ...options, runtime: { ...options.runtime, backend: "sqlite" } } as unknown as PostgresProductionCompositionOptions)).rejects.toThrow(/PostgreSQL/);
    await expect(createPostgresProductionComposition({ ...options, maximumClaims: 6 })).rejects.toThrow(/quota/);
    expect(calls).toHaveLength(0);
  });

  it("fails startup on actual database identity, schema or generation mismatches", async () => {
    const { options } = harness();
    await expect(createPostgresProductionComposition({ ...options, identity: { ...options.identity, database: "wrong" } })).rejects.toThrow(/identity/);
    await expect(createPostgresProductionComposition({ ...options, generation: { ...options.generation, activatedAt: 200 } })).rejects.toThrow(/generation/);
  });

  it("requires installed business tables and never creates a fallback schema", async () => {
    const { options, tx, calls } = harness();
    const original = tx.query;
    tx.query = async (sql, values) => sql.includes("AS required(name)")
      ? { rows: [{ name: "wallet_channel_collectors" }], rowCount: 1 } : original(sql, values);
    await expect(createPostgresProductionComposition(options)).rejects.toThrow(/schema/);
    expect(calls.some(call => /CREATE TABLE|INSERT INTO forward_strategy_generations/.test(call.sql))).toBe(false);
  });

  it("services every stage within separate quotas and leaves missing facts without receipts", async () => {
    const { options, calls } = harness();
    const prices = vi.fn(options.adapters.prices);
    const composition = await createPostgresProductionComposition({ ...options, adapters: { ...options.adapters, prices } });
    const report = await composition.runOnce();
    expect(report.gatewayDeliveryEnabled).toBe(false);
    expect(report.fomoEnabled).toBe(false);
    expect(Object.keys(report.stages)).toEqual(["normalization", "token", "purchase", "fanout", "opportunity", "capability", "signal"]);
    for (const stage of Object.values(report.stages)) expect(stage.attempted).toBeLessThanOrEqual(1);
    expect(prices).toHaveBeenCalledWith(expect.objectContaining({ generationId: "generation", asOf: 1000, limit: 10 }));
    expect(calls.some(call => /INSERT INTO .*receipts/.test(call.sql))).toBe(false);
    expect(calls.some(call => call.sql.includes("capture_consumer_jobs") && call.values[0] === "forward_purchase_match")).toBe(true);
    expect(calls.some(call => call.sql.includes("forward_capability_jobs"))).toBe(true);
  });

  it("rotates the first stage across bounded runs and rejects overlapping runs", async () => {
    const { options, calls } = harness();
    const composition = await createPostgresProductionComposition(options);
    await composition.runOnce();
    calls.length = 0;
    await composition.runOnce();
    const firstClaim = calls.find(call => call.sql.includes("WITH due AS"));
    expect(firstClaim?.values[0]).toBe("forward_token_discovery");
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const busy = await createPostgresProductionComposition({ ...options,
      adapters: { ...options.adapters, prices: async () => { await waiting; return { status: "deferred", reasonCode: "missing" }; } } });
    const run = busy.runOnce();
    await expect(busy.runOnce()).rejects.toThrow(/running/);
    release();
    await run;
  });

  it("rolls back a result and receipt together when a real UOW completion fails", async () => {
    const { options, tx } = harness();
    const sql: string[] = [];
    const uow = createPostgresUnitOfWork({ async connect() { return {
      async query(statement, values) { sql.push(statement); return tx.query(statement, values); }, release() {},
    }; } }, { statementTimeoutMs: 1000, lockTimeoutMs: 100 });
    await expect(uow.run(async transaction => {
      await transaction.query("INSERT INTO result_table VALUES ('real-result')");
      throw new Error("Lease lost before receipt");
    })).rejects.toThrow(/Lease lost/);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    const composition = await createPostgresProductionComposition({ ...options, runtime: { ...options.runtime, run: uow.run } });
    await composition.runOnce();
    expect(sql).toContain("COMMIT");
  });

  it("does not manufacture price inputs after a failing adapter and continues other consumers", async () => {
    const { options, calls } = harness();
    const composition = await createPostgresProductionComposition({ ...options, adapters: { ...options.adapters,
      async prices() { throw new Error("provider unavailable"); } } });
    const report = await composition.runOnce();
    expect(report.facts.status).toBe("failed");
    expect(calls.some(call => call.sql.includes("INSERT INTO forward_peak_evidence"))).toBe(false);
    expect(Object.values(report.stages).every(stage => stage.attempted === 1)).toBe(true);
  });

  it("bounds trace reads to the active generation", async () => {
    const { options, calls } = harness();
    const composition = await createPostgresProductionComposition(options);
    await expect(composition.readTrace({ entityId: "entity", asOf: 1000, limit: 1, after: null })).rejects.toThrow(/snapshot/);
    const query = calls.find(call => call.sql.includes("WITH candidates AS"));
    expect(query?.values[1]).toBe("generation");
  });

  it("uses the business probe's explicit schema identity instead of current_schema", async () => {
    const { options, calls } = harness();
    const { backend: _backend, ...businessRuntime } = options.runtime;
    await createPostgresProductionComposition({ ...options, runtime: businessRuntime });
    expect(calls.some(call => call.sql.includes("current_schema"))).toBe(false);
    await expect(createPostgresProductionComposition({ ...options,
      runtime: { ...businessRuntime, async probe() { return { ...await businessRuntime.probe(), generation: "other" }; } } })).rejects.toThrow(/identity/);
  });

  it("scopes source admission and consumer receipt versions to wallet namespace and generation", async () => {
    const { options, calls } = harness();
    await (await createPostgresProductionComposition(options)).runOnce();
    const admitted = calls.filter(call => call.sql.startsWith("INSERT INTO capture_consumer_jobs"));
    expect(admitted).toHaveLength(2);
    for (const call of admitted) {
      expect(call.values[4]).toBe("wallet-chain-v1");
      expect(call.values[3]).toBe("wallet-chain");
      expect(call.values[5]).toBe("generation");
      expect(call.values[1]).toMatch(/v1:[a-f0-9]{64}$/);
    }
  });

  it("defers an actual claimed purchase when its factual resolver is unavailable", async () => {
    const { options, tx, calls } = harness();
    const base = tx.query;
    let claimed = false;
    const leasedRow = { intent_id: "intent", job_id: "job", semantic_fingerprint: "fingerprint",
      parser_version: "wallet-chain-v1", claim_generation: 1, lease_expires_at: 61_000, requires_review: false };
    tx.query = async (sql, values = []) => {
      if (sql.includes("FROM capture_consumer_jobs WHERE") && sql.includes("WITH due AS") && values[0] === "forward_purchase_match" && !claimed) {
        claimed = true; calls.push({ sql, values }); return { rows: [leasedRow], rowCount: 1 };
      }
      if (sql === "SELECT * FROM capture_normalized_results WHERE job_id=$1") return { rows: [{ event_kind: "buy",
        normalized_payload: JSON.stringify({ schemaVersion: "wallet-chain-v1", generationId: "generation", event: {}, purchase: null, profile: null }) }], rowCount: 1 };
      if (sql.startsWith("SELECT w.*,i.job_id")) return { rows: [leasedRow], rowCount: 1 };
      return base(sql, values);
    };
    const purchase = vi.fn(options.adapters.purchase);
    const report = await (await createPostgresProductionComposition({ ...options, adapters: { ...options.adapters, purchase } })).runOnce();
    expect(report.stages.purchase).toMatchObject({ claimed: 1, deferred: 1, applied: 0, failed: 0 });
    expect(purchase).toHaveBeenCalledWith(expect.objectContaining({ generationId: "generation", lease: expect.objectContaining({ claimGeneration: 1 }) }));
    expect(calls.some(call => call.sql.includes("SET status='pending'") && call.values.includes("execution_unavailable"))).toBe(true);
    expect(calls.some(call => call.sql.includes("INSERT INTO capture_consumer_receipts"))).toBe(false);
  });

  it("does not complete a replaced purchase claim during deferral", async () => {
    const { options, tx } = harness();
    const base = tx.query;
    tx.query = async (sql, values = []) => {
      if (sql.includes("FROM capture_consumer_jobs WHERE") && sql.includes("WITH due AS") && values[0] === "forward_purchase_match") {
        return { rows: [{ intent_id: "intent", job_id: "job", semantic_fingerprint: "fingerprint", parser_version: "wallet-chain-v1",
          claim_generation: 1, lease_expires_at: 61_000, requires_review: true }], rowCount: 1 };
      }
      return base(sql, values);
    };
    const report = await (await createPostgresProductionComposition(options)).runOnce();
    expect(report.stages.purchase).toMatchObject({ claimed: 1, applied: 0, deferred: 0, failed: 1 });
  });

  it("defers a real signal claim before target refresh when risk facts are absent", async () => {
    const { options, tx, calls } = harness();
    const base = tx.query;
    tx.query = async (sql, values = []) => {
      if (sql.includes("UPDATE wallet_forward_signal_jobs j") && sql.includes("RETURNING")) {
        calls.push({ sql, values }); return { rows: [{ chain: "solana", token_address: "TokenCase", claim_generation: 1, lease_expires_at: 61_000 }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT sample_id,execution_fingerprint,entity_id")) return { rows: [{ sample_id: "sample", execution_fingerprint: "fingerprint",
        entity_id: "entity", chain: "solana", token_address: "TokenCase", occurred_at: 900 }], rowCount: 1 };
      if (sql.startsWith("SELECT 1 FROM wallet_forward_signal_jobs")) return { rows: [{ owned: true }], rowCount: 1 };
      return base(sql, values);
    };
    const target = vi.fn(options.adapters.target);
    const report = await (await createPostgresProductionComposition({ ...options, adapters: { ...options.adapters, target } })).runOnce();
    expect(report.stages.signal).toMatchObject({ claimed: 1, deferred: 1, applied: 0, failed: 0 });
    expect(target).not.toHaveBeenCalled();
    expect(calls.some(call => /INSERT INTO .*receipts/.test(call.sql))).toBe(false);
    expect(calls.some(call => call.sql.includes("WHEN wake_generation>$6") && call.values.includes("risk_unavailable")
      && call.values.includes("waiting_source"))).toBe(true);
  });

  it("refuses to truncate opportunity price facts into an apparently complete evaluation", async () => {
    const query = vi.fn(async () => ({ rows: [{ payload: "first" }, { payload: "second" }], rowCount: 2 }));
    const bounded = boundPostgresOpportunityEvidence({ query }, 1);
    await expect(bounded.query("SELECT payload FROM forward_peak_evidence WHERE chain=$1 AND token_address=$2 AND observed_until>=$3 AND observed_from<$4 AND known_at<=$5 ORDER BY peak_id,revision_id",
      ["solana", "TokenCase", 100, 1000, 1000])).rejects.toThrow(/budget/);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("LIMIT $6"), ["solana", "TokenCase", 100, 1000, 1000, 2]);
  });

  it("rejects oversized price batches before persisting any peak", async () => {
    const { options, calls } = harness();
    const peak = { peakId: "peak", revisionId: "v1", chain: "solana", tokenAddress: "TokenCase", kind: "trade" as const,
      occurredAt: 900, knownAt: 900, priceUsd: "3", verification: "validated" as const, evidenceRef: "provider:trade" };
    const report = await (await createPostgresProductionComposition({ ...options, factLimit: 1,
      adapters: { ...options.adapters, async prices() { return { status: "available", lease: { generationId: "generation", ownerId: "owner", claimGeneration: 1,
        leaseExpiresAt: 61_000, async assertOwned() {}, async complete() {} }, peaks: [peak, { ...peak, peakId: "other" }], markets: [] }; } } })).runOnce();
    expect(report.facts.status).toBe("failed");
    expect(calls.some(call => call.sql.includes("INSERT INTO forward_peak_evidence"))).toBe(false);
  });

  it("composes actual wallet basis, token discovery, purchase samples and downstream work in one UOW", async () => {
    const { options, calls } = purchaseFixture();
    const report = await (await createPostgresProductionComposition(options)).runOnce();
    expect(report.stages.token).toMatchObject({ claimed: 1, applied: 1, failed: 0 });
    expect(report.stages.purchase).toMatchObject({ claimed: 1, applied: 1, failed: 0 });
    const receipt = calls.find(call => call.sql.startsWith("INSERT INTO capture_consumer_receipts") && call.values[1] === "forward_purchase_match");
    expect(receipt?.values[5]).toBe("produced");
    expect(receipt?.values[6]).toBe("forward-sample:sample");
    expect(calls.some(call => call.sql.startsWith("INSERT INTO forward_opportunity_requests"))).toBe(true);
    expect(calls.some(call => call.sql.startsWith("INSERT INTO forward_capability_requests"))).toBe(true);
    expect(report.gatewayDeliveryEnabled).toBe(false);
  });

  it("retains a below-50 nominal execution but excludes it from opportunity samples", async () => {
    const { options, calls } = purchaseFixture(49.99);
    const report = await (await createPostgresProductionComposition(options)).runOnce();
    expect(report.stages.purchase).toMatchObject({ applied: 1, failed: 0 });
    expect(calls.some(call => call.sql.startsWith("INSERT INTO forward_trade_revisions"))).toBe(true);
    expect(calls.some(call => call.sql.startsWith("INSERT INTO forward_purchase_samples"))).toBe(false);
    const receipt = calls.find(call => call.sql.startsWith("INSERT INTO capture_consumer_receipts") && call.values[1] === "forward_purchase_match");
    expect(receipt?.values[5]).toBe("no_output");
    expect(receipt?.values[7]).toBe("excluded_by_policy");
  });

  it("rolls back the actual purchase projection and work admission if its receipt insert fails", async () => {
    const { options, tx, calls } = purchaseFixture(60, true);
    const uow = createPostgresUnitOfWork({ async connect() { return {
      query: (sql, values) => tx.query(sql, values), release() {},
    }; } }, { statementTimeoutMs: 1000, lockTimeoutMs: 100 });
    const report = await (await createPostgresProductionComposition({ ...options, runtime: { ...options.runtime, run: uow.run } })).runOnce();
    expect(report.stages.purchase).toMatchObject({ claimed: 1, applied: 0, failed: 1 });
    const begin = calls.findIndex(call => call.sql.startsWith("INSERT INTO forward_trade_revisions"));
    const failedReceipt = calls.findIndex(call => call.sql.startsWith("INSERT INTO capture_consumer_receipts") && call.values[1] === "forward_purchase_match");
    const rollback = calls.findIndex((call, index) => index > failedReceipt && call.sql === "ROLLBACK");
    expect(begin).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(failedReceipt);
    expect(calls.slice(begin, rollback).some(call => call.sql === "COMMIT")).toBe(false);
  });

  it("runs only explicitly enabled stages and skips price retrieval for consumer roles", async () => {
    const { options, calls } = harness();
    const prices = vi.fn(options.adapters.prices);
    const quotas = { normalization: 1, token: 0, purchase: 1, fanout: 0, opportunity: 0, capability: 0, signal: 0 };
    const composition = await createPostgresProductionComposition({ ...options, quotas, activeStages: ["normalization", "purchase"],
      includePrices: false, maximumClaims: 2, adapters: { ...options.adapters, prices } });
    expect(calls.every(call => call.sql.startsWith("SELECT"))).toBe(true);
    const report = await composition.runOnce();
    expect(report.activeStages).toEqual(["normalization", "purchase"]);
    expect(report.facts.status).toBe("disabled");
    expect(prices).not.toHaveBeenCalled();
    expect(report.stages.normalization.attempted).toBe(1);
    expect(report.stages.purchase.attempted).toBe(1);
    for (const stage of ["token", "fanout", "opportunity", "capability", "signal"] as const) expect(report.stages[stage].attempted).toBe(0);
    calls.length = 0;
    await composition.runOnce();
    expect(calls.find(call => call.sql.includes("WITH due AS"))?.values[0]).toBe("forward_purchase_match");
  });

  it("rejects empty, duplicate, unknown and zero-quota active stages before probing", async () => {
    const { options, calls } = harness();
    for (const activeStages of [[], ["purchase", "purchase"], ["unknown"]]) {
      await expect(createPostgresProductionComposition({ ...options, activeStages } as unknown as PostgresProductionCompositionOptions)).rejects.toThrow(/active stages/);
    }
    await expect(createPostgresProductionComposition({ ...options, activeStages: ["purchase"], quotas: { ...options.quotas, purchase: 0 } })).rejects.toThrow(/budget/);
    expect(calls).toHaveLength(0);
  });

  it("claims normalization only within the selected wallet generation and requires ordinary permanent tables", async () => {
    const { options, calls } = harness();
    await (await createPostgresProductionComposition({ ...options, includePrices: false, activeStages: ["normalization"] })).runOnce();
    const claim = calls.find(call => call.sql.includes("UPDATE capture_normalization_jobs j"));
    expect(claim?.values[5]).toBe("generation");
    expect(claim?.sql).toContain("wallet_capture_generation_bindings");
    expect(claim?.sql).toContain("b.generation_id=$6");
    const schema = calls.find(call => call.sql.includes("AS required(name)"));
    expect(schema?.sql).toContain("c.relkind<>'r'");
    expect(schema?.sql).toContain("c.relpersistence<>'p'");
  });

  it("requires a real shared PG price-lease receiver and fences cursor completion", async () => {
    const { tx } = harness();
    const order: string[] = [];
    const lease: PostgresProductionPriceLease = { generationId: "generation", ownerId: "owner", claimGeneration: 1, leaseExpiresAt: 2000,
      async assertOwned() { order.push("fence"); }, async complete() { order.push("cursor-and-release"); } };
    expect(await receivePostgresProductionPriceBatch(tx, { generationId: "generation", asOf: 1000, limit: 1, now: () => 1000,
      batch: { status: "available", lease, peaks: [], markets: [] } })).toEqual({ peaks: 0, markets: 0 });
    expect(order).toEqual(["fence", "fence", "cursor-and-release"]);
    await expect(receivePostgresProductionPriceBatch(tx, { generationId: "generation", asOf: 1000, limit: 1, now: () => 2000,
      batch: { status: "available", lease, peaks: [], markets: [] } })).rejects.toThrow(/expired/);
  });
});

describe("purchase readiness scheduling never replaces factual resolution",()=>{
  it("alternates ready and FIFO turns under backlog without changing other stage quotas",async()=>{
    const {options,tx,calls}=purchaseFixture();
    const base=tx.query,turns:boolean[]=[];
    tx.query=async(sql,values=[])=>{
      if(sql.includes("ready-purchase-claim")){turns.push(values[9] as boolean);return {rows:[{intent_id:"intent",job_id:"job",semantic_fingerprint:"input-fingerprint",parser_version:"wallet-chain-v1",claim_generation:turns.length,lease_expires_at:61000,requires_review:false}],rowCount:1};}
      return base(sql,values);
    };
    const purchase=vi.fn(async()=>({status:"deferred" as const,reasonCode:"wallet_execution_proof_mismatch"}));
    const composition=await createPostgresProductionComposition({...options,adapters:{...options.adapters,purchase}});
    for(let n=0;n<4;n++){
      const report=await composition.runOnce();
      expect(report.stages.purchase).toMatchObject({attempted:1,claimed:1,applied:0,deferred:1,failed:0});
      for(const stage of Object.keys(report.stages) as Array<keyof typeof report.stages>)expect(report.stages[stage].attempted).toBeLessThanOrEqual(options.quotas[stage]);
    }
    expect(turns).toEqual([true,false,true,false]);expect(purchase).toHaveBeenCalledTimes(4);
    expect(calls.some(c=>c.sql.startsWith("INSERT INTO forward_economic_trades"))).toBe(false);
    expect(calls.some(c=>c.sql.startsWith("INSERT INTO capture_consumer_receipts")&&c.values[1]==="forward_purchase_match")).toBe(false);
  });
});
