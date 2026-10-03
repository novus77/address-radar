import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresUnitOfWork, createPostgresNormalizationRepository,
  POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, POSTGRES_NORMALIZATION_SCHEMA_SQL, POSTGRES_CONSUMER_WORK_SCHEMA_SQL, POSTGRES_CAPTURE_HEALTH_SCHEMA_SQL, POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL,
  createPostgresForwardPurchaseRepository, createPostgresConsumerWorkRepository, type VerifiedForwardPurchase,
  createPostgresCaptureHealthRepository,
  type PostgresPool, type PostgresTransaction, type NormalizationLease } from "@address-radar/database";
import { stagePostgresFomoMessage, normalizePostgresFomoLease } from "../src/postgres-fomo-normalization.js";
import { createPostgresFomoCdpCapture } from "../src/postgres-fomo-cdp-capture.js";
import { createPostgresFomoCaptureLifecycle } from "../src/postgres-fomo-capture-lifecycle.js";
import { consumePostgresForwardPurchase, FORWARD_PURCHASE_CONSUMER } from "../src/postgres-forward-purchase-consumer.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
if (connectionString) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.pathname.endsWith("_test")) throw new Error("PostgreSQL integration tests require a local test database");
}
type TestPool = PostgresPool & { end(): Promise<void> };
const schema = `fomo_adapter_test_${randomUUID().replaceAll("-", "")}`;
const now = Date.parse("2026-10-02T00:00:00Z");
const maximumPayloadBytes = 65536;
const activity = { tradeId: "position-1", userId: "account-1", userHandle: "trader", tokenAddress: "0xAbC",
  networkId: 8453, type: "swap_buy", createdAt: new Date(now).toISOString(), usdAmount: 50, price: 0.01, marketCap: 100000 };
const message = (sourceMessageId = "message-1", changes: Record<string, unknown> = {}) => ({
  sourceMessageId, sourceUrl: "wss://feed.example/live?access_token=secret", approvedOrigins: ["wss://feed.example"],
  maximumPayloadBytes, collectorId: "collector-1", sessionId: "session-1", receivedAt: now,
  body: JSON.stringify({ type: "data", topicType: "trading_activity", authorization: "Bearer secret",
    payload: { ...activity, ...changes, password: "secret" } }),
});

// Fixtures exercise the adapter contract, not coverage of an authenticated production Live Feed.
describe.skipIf(!connectionString)("PostgreSQL FOMO source adapter", () => {
  let admin: TestPool | undefined;
  let pool: TestPool | undefined;
  let unit: ReturnType<typeof createPostgresUnitOfWork>;
  let schemaCreated = false;
  beforeAll(async () => {
    const driver = createRequire(import.meta.url)("pg") as {
      Pool: new (options: { connectionString: string; max: number; options?: string }) => TestPool;
    };
    admin = new driver.Pool({ connectionString: connectionString!, max: 1 });
    const client = await admin.connect();
    try { await client.query(`CREATE SCHEMA ${schema}`); schemaCreated = true; } finally { client.release(); }
    pool = new driver.Pool({ connectionString: connectionString!, max: 2, options: `-c search_path=${schema}` });
    unit = createPostgresUnitOfWork(pool, { statementTimeoutMs: 3000, lockTimeoutMs: 1000 });
    await unit.run(transaction => transaction.query(POSTGRES_CAPTURE_INBOX_SCHEMA_SQL + POSTGRES_NORMALIZATION_SCHEMA_SQL + POSTGRES_CAPTURE_HEALTH_SCHEMA_SQL + POSTGRES_CONSUMER_WORK_SCHEMA_SQL + POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL));
  });
  beforeEach(async () => { await unit.run(transaction => transaction.query("TRUNCATE capture_event_identities,capture_source_heads,capture_source_sessions,forward_strategy_generations,forward_economic_trades CASCADE")); });
  afterAll(async () => {
    try { await pool?.end(); } finally {
      if (admin) {
        try {
          if (schemaCreated) {
            const client = await admin.connect();
            try { await client.query(`DROP SCHEMA ${schema} CASCADE`); } finally { client.release(); }
          }
        } finally { await admin.end(); }
      }
    }
  });
  async function claim(): Promise<NormalizationLease> {
    const lease = await unit.run(transaction => createPostgresNormalizationRepository(transaction, maximumPayloadBytes)
      .claim({ owner: "worker-1", now, leaseMs: 60000 }));
    if (!lease) throw new Error("Expected a normalization lease");
    return lease;
  }
  const normalize = (lease: NormalizationLease) => unit.run(transaction => normalizePostgresFomoLease(transaction, lease,
    { now: now + 1, maximumPayloadBytes }));

  it("commits capture, normalization and a consumer intent without granting economic eligibility", async () => {
    const staged = await unit.run(transaction => stagePostgresFomoMessage(transaction, message()));
    expect(staged?.captured.status).toBe("inserted");
    expect(await normalize(await claim())).toBe(true);
    const result = await unit.run(transaction => transaction.query(`SELECT r.*,p.scrubbed_payload FROM capture_normalized_results r
      JOIN capture_normalization_jobs j USING(job_id) JOIN capture_raw_payloads p
      USING(source_namespace,source_event_id,semantic_fingerprint)`));
    const row = result.rows[0]!;
    expect(row.entity_id).toBeNull();
    expect(row.event_kind).toBe("buy");
    expect(row.requires_review).toBe(false);
    expect(row.scrubbed_payload).not.toContain("secret");
    const payload = JSON.parse(String(row.normalized_payload)) as Record<string, unknown>;
    expect(payload).toMatchObject({ sourceEventId: "message-1", sourcePositionId: "position-1", eligibleForOpportunity: false,
      amountBasis: "source_reported_usd", entryBasis: "awaiting_execution_verification", amountEstimated: null });
    expect(payload).not.toHaveProperty("eventId");
    expect(payload).not.toHaveProperty("handle");
    const intents = await unit.run(transaction => transaction.query("SELECT status FROM capture_consumer_intents"));
    expect(intents.rows).toEqual([{ status: "pending" }]);
  });

  it("deduplicates replay across collector sessions", async () => {
    const first = await unit.run(transaction => stagePostgresFomoMessage(transaction, message()));
    const replay = await unit.run(transaction => stagePostgresFomoMessage(transaction,
      { ...message(), receivedAt: now + 1000, sessionId: "session-2" }));
    expect(replay?.captured.status).toBe("duplicate");
    expect(replay?.jobId).toBe(first?.jobId);
    const result = await unit.run(transaction => transaction.query("SELECT count(*)::integer AS count FROM capture_raw_payloads"));
    expect(result.rows).toEqual([{ count: 1 }]);
  });

  it("keeps separate source messages for the same position", async () => {
    await unit.run(transaction => stagePostgresFomoMessage(transaction, message("message-1")));
    await unit.run(transaction => stagePostgresFomoMessage(transaction, message("message-2")));
    expect(await normalize(await claim())).toBe(true);
    expect(await normalize(await claim())).toBe(true);
    const result = await unit.run(transaction => transaction.query("SELECT normalized_payload FROM capture_normalized_results"));
    const observations = result.rows.map(row => JSON.parse(String(row.normalized_payload)) as Record<string, unknown>);
    expect(new Set(observations.map(value => value.sourceEventId)).size).toBe(2);
    expect(new Set(observations.map(value => value.sourcePositionId))).toEqual(new Set(["position-1"]));
    expect(observations.every(value => value.economicTradeIdentity === "unverified")).toBe(true);
  });

  it("keeps a changed business payload as a review-required revision", async () => {
    await unit.run(transaction => stagePostgresFomoMessage(transaction, message()));
    expect(await normalize(await claim())).toBe(true);
    const revised = await unit.run(transaction => stagePostgresFomoMessage(transaction, message("message-1", { usdAmount: 75 })));
    expect(revised?.captured.status).toBe("revision_pending");
    expect(await normalize(await claim())).toBe(true);
    const result = await unit.run(transaction => transaction.query("SELECT requires_review FROM capture_normalized_results ORDER BY requires_review"));
    expect(result.rows).toEqual([{ requires_review: false }, { requires_review: true }]);
  });

  it("quarantines incomplete activity without losing its source projection", async () => {
    await unit.run(transaction => stagePostgresFomoMessage(transaction, message("message-1", { tokenAddress: null })));
    expect(await normalize(await claim())).toBe(true);
    const result = await unit.run(transaction => transaction.query(`SELECT status,failure_reason,
      (SELECT count(*)::integer FROM capture_raw_payloads) AS raw_count,
      (SELECT count(*)::integer FROM capture_normalized_results) AS result_count,
      (SELECT count(*)::integer FROM capture_consumer_intents) AS intent_count FROM capture_normalization_jobs`));
    expect(result.rows).toEqual([{ status: "quarantined", failure_reason: "unsupported_or_incomplete_activity",
      raw_count: 1, result_count: 0, intent_count: 0 }]);
  });

  it("rolls back source capture and task creation together", async () => {
    await expect(unit.run(async transaction => {
      await stagePostgresFomoMessage(transaction, message());
      throw new Error("Injected capture rollback");
    })).rejects.toThrow("Injected capture rollback");
    const result = await unit.run(transaction => transaction.query(`SELECT
      (SELECT count(*)::integer FROM capture_event_identities) AS identities,
      (SELECT count(*)::integer FROM capture_normalization_jobs) AS jobs`));
    expect(result.rows).toEqual([{ identities: 0, jobs: 0 }]);
  });

  it("rolls back normalized results and consumer intents before retrying the lease", async () => {
    await unit.run(transaction => stagePostgresFomoMessage(transaction, message()));
    const lease = await claim();
    await expect(unit.run(async transaction => {
      await normalizePostgresFomoLease(transaction, lease, { now: now + 1, maximumPayloadBytes });
      throw new Error("Injected normalization rollback");
    })).rejects.toThrow("Injected normalization rollback");
    const result = await unit.run(transaction => transaction.query(`SELECT status,
      (SELECT count(*)::integer FROM capture_normalized_results) AS results,
      (SELECT count(*)::integer FROM capture_consumer_intents) AS intents FROM capture_normalization_jobs`));
    expect(result.rows).toEqual([{ status: "leased", results: 0, intents: 0 }]);
    expect(await normalize(lease)).toBe(true);
  });

  it("does not persist messages from an unapproved origin", async () => {
    expect(await unit.run(transaction => stagePostgresFomoMessage(transaction,
      { ...message(), sourceUrl: "wss://feed.example.attacker/live" }))).toBeNull();
    const result = await unit.run(transaction => transaction.query("SELECT count(*)::integer AS count FROM capture_event_identities"));
    expect(result.rows).toEqual([{ count: 0 }]);
  });

  function capture(overrides: { readonly capacity?: number; readonly unitOfWork?: Pick<typeof unit, "run"> } = {}) {
    return createPostgresFomoCdpCapture({ unitOfWork: overrides.unitOfWork ?? unit, collectorId: "collector-1",
      pageId: "page-1", capacity: overrides.capacity ?? 5, maximumPayloadBytes, now: () => now });
  }
  const socketCreated = (url = "wss://prod-api.fomo.family/ws") => JSON.stringify({
    method: "Network.webSocketCreated", params: { requestId: "socket-1", url },
  });
  const frameReceived = () => JSON.stringify({ method: "Network.webSocketFrameReceived",
    params: { requestId: "socket-1", response: { opcode: 1, payloadData: message().body } } });

  it("requires approved socket provenance before staging browser deliveries", async () => {
    const collector = capture();
    expect(collector.receiveCdpMessage(frameReceived())).toBe(false);
    collector.receiveCdpMessage(socketCreated("wss://attacker.example/ws"));
    expect(collector.receiveCdpMessage(frameReceived())).toBe(false);
    expect(await collector.flush()).toBe(0);
    collector.receiveCdpMessage(socketCreated());
    expect(collector.receiveCdpMessage(frameReceived())).toBe(true);
    expect(await collector.flush()).toBe(1);
    expect(collector.diagnostics()).toMatchObject({ pending: 0, committed: 1, coverageComplete: false });
  });

  it("preserves separate deliveries without claiming separate economic trades", async () => {
    const collector = capture();
    collector.receiveCdpMessage(socketCreated());
    collector.receiveCdpMessage(frameReceived());
    collector.receiveCdpMessage(frameReceived());
    expect(await collector.flush()).toBe(2);
    expect(await normalize(await claim())).toBe(true);
    expect(await normalize(await claim())).toBe(true);
    const result = await unit.run(transaction => transaction.query("SELECT normalized_payload FROM capture_normalized_results"));
    const observations = result.rows.map(row => JSON.parse(String(row.normalized_payload)) as Record<string, unknown>);
    expect(new Set(observations.map(value => value.sourceEventId)).size).toBe(2);
    expect(observations.every(value => value.observationIdentityBasis === "collector_delivery"
      && value.eligibleForOpportunity === false && value.economicTradeIdentity === "unverified")).toBe(true);
  });

  it("bounds volatile buffering and requires an explicit resume after overflow", async () => {
    const collector = capture({ capacity: 1 });
    collector.receiveCdpMessage(socketCreated());
    expect(collector.receiveCdpMessage(frameReceived())).toBe(true);
    expect(collector.receiveCdpMessage(frameReceived())).toBe(false);
    expect(collector.resume()).toBe(false);
    expect(collector.diagnostics()).toMatchObject({ pending: 1, pausedReason: "capacity", rejectedCapacity: 1 });
    expect(await collector.flush()).toBe(1);
    expect(collector.receiveCdpMessage(frameReceived())).toBe(false);
    expect(collector.resume()).toBe(true);
    expect(collector.receiveCdpMessage(frameReceived())).toBe(true);
    expect(await collector.flush()).toBe(1);
    expect(collector.diagnostics()).toMatchObject({ rejectedCapacity: 1, rejectedWhilePaused: 1, coverageComplete: false });
  });

  it("serializes concurrent flushes so a delivery is staged only once", async () => {
    const collector = capture();
    collector.receiveCdpMessage(socketCreated());
    collector.receiveCdpMessage(frameReceived());
    const first = collector.flush();
    const second = collector.flush();
    expect(first).toBe(second);
    expect(await first).toBe(1);
    const result = await unit.run(transaction => transaction.query("SELECT count(*)::integer AS count FROM capture_raw_payloads"));
    expect(result.rows).toEqual([{ count: 1 }]);
  });

  it("retains a delivery after uncertain acknowledgement and reconciles the same identity on explicit retry", async () => {
    let failAcknowledgement = true;
    const wrapped = {
      async run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
        const value = await unit.run(operation);
        if (failAcknowledgement) { failAcknowledgement = false; throw new Error("Injected lost commit acknowledgement"); }
        return value;
      },
    };
    const collector = capture({ unitOfWork: wrapped });
    collector.receiveCdpMessage(socketCreated());
    collector.receiveCdpMessage(frameReceived());
    await expect(collector.flush()).rejects.toThrow("lost commit acknowledgement");
    expect(collector.diagnostics()).toMatchObject({ pending: 1, committed: 0, writeFailures: 1, pausedReason: "persistence" });
    expect(await collector.flush()).toBe(1);
    expect(collector.resume()).toBe(true);
    const result = await unit.run(transaction => transaction.query(`SELECT
      (SELECT count(*)::integer FROM capture_raw_payloads) AS payloads,
      (SELECT count(*)::integer FROM capture_normalization_jobs) AS jobs`));
    expect(result.rows).toEqual([{ payloads: 1, jobs: 1 }]);
  });

  function lifecycle(overrides: { readonly unitOfWork?: Pick<typeof unit,"run"> } = {}) {
    return createPostgresFomoCaptureLifecycle({ unitOfWork:overrides.unitOfWork??unit,collectorId:"collector-1",pageId:"page-1",
      capacity:1,maximumPayloadBytes,now:()=>now });
  }
  const gaps = () => unit.run(transaction => createPostgresCaptureHealthRepository(transaction).unverifiedGaps({
    sourceNamespace:"fomo-live-feed",collectorId:"collector-1",pageId:"page-1",limit:100,
  }));

  it("persists disconnection and bounds the gap on reconnect without claiming restored coverage", async () => {
    const source = lifecycle();
    await source.start();
    await source.connection(true);
    await source.connection(false);
    await source.connection(true);
    expect(source.diagnostics().pausedReason).toBe("disconnected");
    expect(await source.resume()).toBe(true);
    const rows = await gaps();
    expect(rows.map(row=>row.reason_code).sort()).toEqual(["collector_starting","disconnected"]);
    expect(rows.every(row=>row.coverage_state==="awaiting_verification" && Number(row.resumed_at)===now)).toBe(true);
  });

  it("fences an old collector after a replacement and preserves an uncertain tail gap", async () => {
    const first = lifecycle();
    await first.start(); await first.connection(true);
    first.receiveCdpMessage(socketCreated()); first.receiveCdpMessage(frameReceived());
    const replacement = lifecycle();
    await replacement.start(); await replacement.connection(true);
    await expect(first.flush()).rejects.toThrow("no longer active");
    expect(first.diagnostics()).toMatchObject({ pending:1,pausedReason:"persistence" });
    const rows = await gaps();
    expect(rows.find(row=>row.reason_code==="session_replaced")).toMatchObject({ start_is_lower_bound:true,
      coverage_state:"awaiting_verification" });
    const result = await unit.run(transaction=>transaction.query("SELECT count(*)::integer AS count FROM capture_raw_payloads"));
    expect(result.rows).toEqual([{count:0}]);
  });

  it("records overflow durably while preserving the pending source delivery", async () => {
    const source = lifecycle();
    await source.start(); await source.connection(true);
    source.receiveCdpMessage(socketCreated());
    expect(source.receiveCdpMessage(frameReceived())).toBe(true);
    expect(source.receiveCdpMessage(frameReceived())).toBe(false);
    expect(await source.flush()).toBe(1);
    expect((await gaps()).find(row=>row.reason_code==="capacity")).toMatchObject({ coverage_state:"open" });
    expect(await source.resume()).toBe(true);
    expect((await gaps()).find(row=>row.reason_code==="capacity")).toMatchObject({ coverage_state:"awaiting_verification" });
  });

  it("retains a pending failure marker when health persistence also fails", async () => {
    let unavailable = false;
    const wrapped = {
      async run<T>(operation:(transaction:PostgresTransaction)=>Promise<T>):Promise<T> {
        if (unavailable) throw new Error("Injected storage unavailable");
        return unit.run(operation);
      },
    };
    const source = lifecycle({unitOfWork:wrapped});
    await source.start(); await source.connection(true);
    source.receiveCdpMessage(socketCreated()); source.receiveCdpMessage(frameReceived());
    unavailable = true;
    await expect(source.flush()).rejects.toThrow("storage unavailable");
    expect(source.diagnostics()).toMatchObject({pending:1,pendingHealthKind:"persistence"});
    unavailable = false;
    expect(await source.flush()).toBe(1);
    expect(source.diagnostics().pendingHealthKind).toBeNull();
    expect((await gaps()).find(row=>row.reason_code==="persistence")).toMatchObject({coverage_state:"open"});
  });

  it("drains queued data before recording a clean shutdown", async () => {
    const source = lifecycle();
    await source.start(); await source.connection(true);
    source.receiveCdpMessage(socketCreated()); source.receiveCdpMessage(frameReceived());
    await source.close();
    expect(source.diagnostics()).toMatchObject({closed:true,pending:0,committed:1});
    const result = await unit.run(transaction=>transaction.query("SELECT state FROM capture_source_sessions"));
    expect(result.rows).toEqual([{state:"closed"}]);
    expect((await gaps()).find(row=>row.reason_code==="closed")).toMatchObject({coverage_state:"open"});
  });

  it("deduplicates a durable health event and rejects conflicting or reversed transitions", async () => {
    const source = lifecycle(); await source.start();
    const sessionId = source.diagnostics().sessionId;
    const event = {eventId:"health-event-1",kind:"connected" as const,occurredAt:now};
    expect(await unit.run(transaction=>createPostgresCaptureHealthRepository(transaction).transition(sessionId,event))).toBe(true);
    expect(await unit.run(transaction=>createPostgresCaptureHealthRepository(transaction).transition(sessionId,event))).toBe(false);
    await expect(unit.run(transaction=>createPostgresCaptureHealthRepository(transaction).transition(sessionId,
      {...event,kind:"disconnected"}))).rejects.toThrow("conflicts");
    await expect(unit.run(transaction=>createPostgresCaptureHealthRepository(transaction).transition(sessionId,
      {eventId:"health-event-2",kind:"disconnected",occurredAt:now-1}))).rejects.toThrow("reverse event time");
  });

  it("confirms local startup only after the transaction acknowledgement", async () => {
    let releaseAcknowledgement!: () => void;
    let signalCommitted!: () => void;
    const acknowledgement = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
    const committed = new Promise<void>(resolve => { signalCommitted = resolve; });
    const wrapped = {
      async run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
        const value = await unit.run(operation);
        signalCommitted();
        await acknowledgement;
        return value;
      },
    };
    const source = lifecycle({ unitOfWork: wrapped });
    const starting = source.start();
    await committed;
    const startedBeforeAcknowledgement = source.diagnostics().started;
    releaseAcknowledgement();
    await starting;
    expect(startedBeforeAcknowledgement).toBe(false);
    expect(source.diagnostics().started).toBe(true);
  });

  it("reconciles lost startup acknowledgement without falsely confirming startup or duplicating a session", async () => {
    let failAcknowledgement = true;
    const wrapped = {
      async run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
        const value = await unit.run(operation);
        if (failAcknowledgement) { failAcknowledgement = false; throw new Error("Injected lost startup acknowledgement"); }
        return value;
      },
    };
    const source = lifecycle({ unitOfWork: wrapped });
    await expect(source.start()).rejects.toThrow("lost startup acknowledgement");
    expect(source.diagnostics().started).toBe(false);
    await source.start();
    expect(source.diagnostics().started).toBe(true);
    const result = await unit.run(transaction => transaction.query("SELECT count(*)::integer AS count FROM capture_source_sessions"));
    expect(result.rows).toEqual([{ count: 1 }]);
  });

  it("waits for in-flight startup before confirming shutdown", async () => {
    let releaseAcknowledgement!: () => void;
    let signalCommitted!: () => void;
    const acknowledgement = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
    const committed = new Promise<void>(resolve => { signalCommitted = resolve; });
    const wrapped = {
      async run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
        const value = await unit.run(operation);
        signalCommitted();
        await acknowledgement;
        return value;
      },
    };
    const source = lifecycle({ unitOfWork: wrapped });
    const starting = source.start();
    await committed;
    const closing = source.close();
    releaseAcknowledgement();
    await starting;
    await closing;
    const result = await unit.run(transaction => transaction.query("SELECT state FROM capture_source_sessions"));
    expect(result.rows).toEqual([{ state: "closed" }]);
    expect(source.diagnostics()).toMatchObject({ closed: true, pending: 0 });
  });

  it("reconciles a lost shutdown acknowledgement and makes repeated shutdown idempotent", async () => {
    let failAcknowledgement = false;
    const wrapped = {
      async run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
        const value = await unit.run(operation);
        if (failAcknowledgement) { failAcknowledgement = false; throw new Error("Injected lost shutdown acknowledgement"); }
        return value;
      },
    };
    const source = lifecycle({ unitOfWork: wrapped });
    await source.start(); await source.connection(true);
    failAcknowledgement = true;
    await expect(source.close()).rejects.toThrow("lost shutdown acknowledgement");
    await source.close();
    await source.close();
    const result = await unit.run(transaction => transaction.query("SELECT count(*)::integer AS count FROM capture_source_health_events WHERE event_kind='closed'"));
    expect(result.rows).toEqual([{ count: 1 }]);
  });

  it.each(["connected", "closed"] as const)("deduplicates concurrent %s events after waiting for ownership", async kind => {
    const source = lifecycle(); await source.start();
    const sessionId = source.diagnostics().sessionId;
    const event = { eventId: "concurrent-health-event", kind, occurredAt: now };
    let releaseInitialReads!: () => void;
    const initialReads = new Promise<void>(resolve => { releaseInitialReads = resolve; });
    let arrivals = 0;
    const concurrentUnit = createPostgresUnitOfWork({
      async connect() {
        const client = await pool!.connect();
        return {
          async query(text: string, values?: unknown[]) {
            const result = await client.query(text, values);
            if (text === "SELECT * FROM capture_source_health_events WHERE event_id=$1"
              && values?.[0] === event.eventId && arrivals < 2) {
              arrivals += 1;
              if (arrivals === 2) releaseInitialReads();
              await initialReads;
            }
            return result;
          },
          release(error?: Error) { client.release(error); },
        };
      },
    }, { statementTimeoutMs: 3000, lockTimeoutMs: 1000 });
    const results = await Promise.all([1, 2].map(() => concurrentUnit.run(transaction =>
      createPostgresCaptureHealthRepository(transaction).transition(sessionId, event))));
    expect(results.sort()).toEqual([false, true]);
    const result = await unit.run(transaction => transaction.query("SELECT count(*)::integer AS count FROM capture_source_health_events WHERE event_id=$1", [event.eventId]));
    expect(result.rows).toEqual([{ count: 1 }]);
  });

  const purchase = (changes:Partial<VerifiedForwardPurchase> = {}):VerifiedForwardPurchase => ({executionKey:"verified-fill-1",chain:"base",
    tokenAddress:"0xabc",entityId:"entity-1",sourceUserId:"account-1",occurredAt:now,tokenQuantity:"5000",quoteAsset:"USDC",
    quoteAmount:"50",amountUsd:"50",entryPriceUsd:"0.01",amountBasis:"stablecoin_nominal",amountEstimated:true,
    executionEvidenceRef:"execution-proof-1",ownershipEvidenceRef:"ownership-proof-1",...changes});
  async function purchaseLease(messageId = "purchase-message-1") {
    await unit.run(transaction=>stagePostgresFomoMessage(transaction,message(messageId)));
    await normalize(await claim());
    return unit.run(async transaction=>{
      const repository = createPostgresConsumerWorkRepository(transaction,FORWARD_PURCHASE_CONSUMER);
      await repository.schedulePending(now+1,100);
      const lease = await repository.claim({owner:"purchase-worker",now:now+1,leaseMs:60000});
      if (!lease) throw new Error("Expected a purchase consumer lease");
      return lease;
    });
  }
  async function generation(activatedAt = now) {
    await unit.run(transaction=>createPostgresForwardPurchaseRepository(transaction).registerGeneration({generationId:"forward-test",activatedAt}));
  }
  const consume = async (lease:Awaited<ReturnType<typeof purchaseLease>>,verified = purchase(),recordedAt = now+2) =>
    unit.run(transaction=>consumePostgresForwardPurchase(transaction,lease,{generationId:"forward-test",
      resolution:{status:"verified",purchase:verified},now:recordedAt,retryAt:recordedAt+300000}));

  it("atomically creates a qualified per-buy sample, work intent and consumer receipt",async()=>{
    await generation(); const lease = await purchaseLease();
    const result = await consume(lease);
    expect(result.status).toBe("sample_ready");
    const rows = await unit.run(transaction=>transaction.query(`SELECT s.*,r.amount_estimated,r.amount_basis
      FROM forward_purchase_samples s JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint`));
    expect(rows.rows[0]).toMatchObject({entity_id:"entity-1",state:"observing",amount_estimated:true,amount_basis:"stablecoin_nominal"});
    expect(Number(rows.rows[0]?.expires_at)-Number(rows.rows[0]?.occurred_at)).toBe(30*24*60*60*1000);
    const receipts = await unit.run(transaction=>transaction.query(`SELECT
      (SELECT count(*)::integer FROM forward_sample_work_intents) AS intents,
      (SELECT count(*)::integer FROM capture_consumer_receipts) AS receipts`));
    expect(receipts.rows).toEqual([{intents:1,receipts:1}]);
  });

  it("maps two source observations of one verified execution to one sample",async()=>{
    await generation(); await consume(await purchaseLease("source-1"));
    await consume(await purchaseLease("source-2"));
    const result = await unit.run(transaction=>transaction.query(`SELECT
      (SELECT count(*)::integer FROM forward_purchase_samples) AS samples,
      (SELECT count(*)::integer FROM forward_trade_source_links) AS links,
      (SELECT count(*)::integer FROM capture_consumer_receipts) AS receipts`));
    expect(result.rows).toEqual([{samples:1,links:2,receipts:2}]);
  });

  it("keeps distinct verified buys of the same token in independent windows",async()=>{
    await generation(); await consume(await purchaseLease("buy-1"));
    await consume(await purchaseLease("buy-2"),purchase({executionKey:"verified-fill-2",occurredAt:now+1}));
    const result = await unit.run(transaction=>transaction.query("SELECT occurred_at,expires_at FROM forward_purchase_samples ORDER BY occurred_at"));
    expect(result.rows).toHaveLength(2);
    expect(Number(result.rows[1]?.expires_at)-Number(result.rows[0]?.expires_at)).toBe(1);
  });

  it("retains conflicting ownership for review without merging identities or producing another receipt",async()=>{
    await generation(); await consume(await purchaseLease("owner-1"));
    const result = await consume(await purchaseLease("owner-2"),purchase({entityId:"entity-2",ownershipEvidenceRef:"ownership-proof-2"}));
    expect(result.status).toBe("deferred");
    const counts = await unit.run(transaction=>transaction.query(`SELECT
      (SELECT count(*)::integer FROM forward_purchase_samples) AS samples,
      (SELECT count(*)::integer FROM forward_trade_revisions WHERE state='pending_review') AS revisions,
      (SELECT count(*)::integer FROM capture_consumer_receipts) AS receipts`));
    expect(counts.rows).toEqual([{samples:1,revisions:1,receipts:1}]);
  });

  it("does not overwrite entry evidence when a verified economic revision changes",async()=>{
    await generation(); await consume(await purchaseLease("entry-1"));
    expect((await consume(await purchaseLease("entry-2"),purchase({entryPriceUsd:"0.02"}))).status).toBe("deferred");
    const rows = await unit.run(transaction=>transaction.query("SELECT state,entry_price_usd::text AS price FROM forward_trade_revisions ORDER BY state"));
    expect(rows.rows).toEqual([{state:"original",price:"0.01"},{state:"pending_review",price:"0.02"}]);
  });

  it("defers missing execution evidence without creating trades, samples or success receipts",async()=>{
    const lease = await purchaseLease();
    const result = await unit.run(transaction=>consumePostgresForwardPurchase(transaction,lease,{generationId:"forward-test",
      resolution:{status:"deferred",reasonCode:"execution_basis_missing"},now:now+2,retryAt:now+300000}));
    expect(result.status).toBe("deferred");
    const counts = await unit.run(transaction=>transaction.query(`SELECT
      (SELECT count(*)::integer FROM forward_economic_trades) AS trades,
      (SELECT count(*)::integer FROM forward_purchase_samples) AS samples,
      (SELECT count(*)::integer FROM capture_consumer_receipts) AS receipts`));
    expect(counts.rows).toEqual([{trades:0,samples:0,receipts:0}]);
  });

  it("preserves an actual below-threshold trade but excludes it from purchase samples",async()=>{
    await generation(); const result = await consume(await purchaseLease(),purchase({amountUsd:"49.999",quoteAmount:"49.999"}));
    expect(result.status).toBe("below_threshold");
    const rows = await unit.run(transaction=>transaction.query(`SELECT
      (SELECT count(*)::integer FROM forward_economic_trades) AS trades,
      (SELECT count(*)::integer FROM forward_purchase_samples) AS samples,
      (SELECT outcome FROM capture_consumer_receipts LIMIT 1) AS outcome`));
    expect(rows.rows).toEqual([{trades:1,samples:0,outcome:"no_output"}]);
  });

  it("rolls back trade/sample writes when the consumer lease cannot confirm their receipt",async()=>{
    await generation(); const lease = await purchaseLease();
    await expect(consume({...lease,owner:"stale-worker"})).rejects.toThrow("not fenced");
    const rows = await unit.run(transaction=>transaction.query(`SELECT
      (SELECT count(*)::integer FROM forward_economic_trades) AS trades,
      (SELECT count(*)::integer FROM forward_purchase_samples) AS samples,
      (SELECT count(*)::integer FROM capture_consumer_receipts) AS receipts`));
    expect(rows.rows).toEqual([{trades:0,samples:0,receipts:0}]);
  });

  it("records an elapsed observation window as unverified rather than a failed opportunity",async()=>{
    const old = now-31*24*60*60*1000; await generation(old);
    await consume(await purchaseLease(),purchase({occurredAt:old}));
    const rows = await unit.run(transaction=>transaction.query("SELECT state FROM forward_purchase_samples"));
    expect(rows.rows).toEqual([{state:"window_elapsed_unverified"}]);
  });

  it("preserves lossless decimals and requires explicit stablecoin estimation",async()=>{
    await generation(); const lease = await purchaseLease();
    await expect(consume(lease,purchase({amountEstimated:false}))).rejects.toThrow("estimation marker");
    const exact = "50.0000000000000000001";
    await consume(lease,purchase({amountUsd:exact,quoteAmount:exact}));
    const rows = await unit.run(transaction=>transaction.query("SELECT amount_usd::text AS amount,source_representations FROM forward_trade_revisions"));
    expect(rows.rows[0]?.amount).toBe(exact);
    expect(JSON.parse(String(rows.rows[0]?.source_representations)).amountUsd).toBe(exact);
  });
});
