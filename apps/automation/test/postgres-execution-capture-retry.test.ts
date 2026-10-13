import { describe, expect, it, vi } from "vitest";
import { createPostgresExecutionCaptureRetry } from "../src/postgres-execution-capture-retry.js";
import { sourceRpcFixture } from "./postgres-source-fact-fixture.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import { walletPurchaseBasisFingerprint } from "../../wallet-monitor/src/postgres-wallet-channel.js";

async function fixture() {
  const rpc = await sourceRpcFixture();
  const payload = { schemaVersion: "wallet-chain-v1", generationId: "generation", collectorId: "solana", chainFamily: "solana",
    profile: rpc.profile, purchase: null, externalBasis: null, entryPriceBasis: null,
    event: { eventId: "event", chain: "solana", walletAddress: rpc.profile.wallet.address, tokenAddress: "TokenCase",
      side: "buy", occurredAt: 90_000, amountUsd: null, priceUsd: null, marketCapUsd: null, sourceReference: "solana:signature" } };
  let rows: Record<string, unknown>[] = [{ job_id: "job", generation_id: "generation", committed_at: 95_000,
    normalized_payload: JSON.stringify(payload), proof_available: false }];
  let inTransaction = false, at = 100_000;
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows, rowCount: rows.length }));
  const run = async <T>(fn: (tx: PostgresTransaction) => Promise<T>): Promise<T> => {
    inTransaction = true; try { return await fn({ query: (sql,values) => sql.includes("execution-retry-scan-timeout") ? Promise.resolve({ rows: [],rowCount: 0 }) : query(sql,values) }); } finally { inTransaction = false; }
  };
  const receive = vi.fn(async (_input: { payloads: readonly unknown[]; signal: AbortSignal }) => {
    expect(inTransaction).toBe(false);
    return { processed: 1, acquired: 1, published: 1, deferred: 0,
      results: [{ status: "verified" as const, purchase: rpc.request.validation.claims.purchase,
        externalBasis: { generationId: "generation", sourceReference: payload.event.sourceReference,
          verifierId: "validator", evidenceRef: rpc.request.validation.claims.validationRef,
          verifiedAt: 100_000, executionKey: rpc.request.validation.claims.purchase.executionKey,
          purchaseFingerprint: walletPurchaseBasisFingerprint(rpc.request.validation.claims.purchase) } }] };
  });
  const options = { generationId: "generation", activatedAt: 1000, maximumCaptures: 1, maximumPayloadBytes: 20_000,
    maximumRunMs: 1000, lookaheadMs: 30_000, maximumFactAgeMs: 60_000, maximumFactPayloadBytes: 20_000,
    run, receiver: { receive }, now: () => at };
  return { options, query, receive, payload, setRows: (value: typeof rows) => { rows = value; }, setNow: (value: number) => { at = value; } };
}
const signal = () => new AbortController().signal;
describe("committed capture execution recovery", () => {
  it("reuses the real receiver outside SQL and does not fabricate or renew a signature", async () => {
    const f = await fixture(), retry = createPostgresExecutionCaptureRetry(f.options);
    expect(await retry.pollOnce(signal())).toMatchObject({ status: "polled", scanned: 1, attempted: 1, published: 1 });
    const input = f.receive.mock.calls[0]![0];
    expect(input.payloads[0]).toEqual(f.payload);
    expect(f.query.mock.calls[0]![0]).toContain("capture_consumer_jobs");
    expect(f.query.mock.calls[0]![0]).toContain("validator_authority");
    expect(f.query.mock.calls[0]![0]).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
  it("defers without authority before acquiring a connection", async () => {
    const f = await fixture();
    expect(await createPostgresExecutionCaptureRetry({ ...f.options, receiver: undefined }).pollOnce(signal()))
      .toMatchObject({ status: "deferred", reasonCode: "execution_retry_authority_unavailable" });
    expect(f.query).not.toHaveBeenCalled();
  });
  it("does not repeat RPC when a current independently attested proof already covers the consumer due time", async () => {
    const f = await fixture();
    f.setRows([{ job_id: "job", generation_id: "generation", committed_at: 95_000,
      normalized_payload: JSON.stringify(f.payload), proof_available: true }]);
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ alreadyAvailable: 1, attempted: 0 });
    expect(f.receive).not.toHaveBeenCalled();
  });
  it.each(["generation", "time", "overflow", "bytes"])("fails closed on an invalid scan: %s", async kind => {
    const f = await fixture();
    const row = { job_id: "job", generation_id: kind === "generation" ? "wrong" : "generation", committed_at: 95_000,
      normalized_payload: JSON.stringify({ ...f.payload, ...(kind === "time" ? { event: { ...f.payload.event, occurredAt: 999_999 } } : {}) }),
      proof_available: false, ...(kind === "bytes" ? { payload_bytes: 30_000 } : {}) };
    f.setRows(kind === "overflow" ? [row, { ...row, job_id: "second" }] : [row]);
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ status: "deferred", attempted: 0 });
    expect(f.receive).not.toHaveBeenCalled();
  });
  it("does not reuse previous external validation outputs during a new acquisition", async () => {
    const f = await fixture();
    f.setRows([{ job_id: "job", generation_id: "generation", committed_at: 95_000, proof_available: false,
      normalized_payload: JSON.stringify({ ...f.payload, purchase: { executionEvidenceRef: "expired-signature" },
        externalBasis: { verifiedAt: 1 }, entryPriceBasis: "executed_quote_per_token_nominal_usd" }) }]);
    await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal());
    expect(f.receive.mock.calls[0]![0].payloads[0]).toMatchObject({ purchase: null, externalBasis: null, entryPriceBasis: null, event: f.payload.event });
  });
  it("is restart recoverable and never records success for a receiver defer", async () => {
    const f = await fixture();
    f.receive.mockResolvedValue({ processed: 1, acquired: 0, published: 0, deferred: 1, results: [{ status: "deferred", reasonCode: "private-provider-error" }] } as any);
    const first = await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal());
    expect(first).toMatchObject({ published: 0, deferred: 1 });
    expect(JSON.stringify(first)).not.toContain("private-provider-error");
    await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal()); expect(f.receive).toHaveBeenCalledTimes(2);
  });
  it("does not invoke a receiver after the scan exhausted the deadline", async () => {
    const f = await fixture(); f.query.mockImplementation(async () => { f.setNow(102_000); return { rows: [], rowCount: 0 }; });
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ status: "deferred", attempted: 0 });
    expect(f.receive).not.toHaveBeenCalled();
  });
});

describe("execution retry bounded deduplication and ACK fencing", () => {
  it.each(["expiring","ambiguous"])("never adds an overlapping proof while %s facts are live", async state => {
    const f = await fixture();
    f.setRows([{ job_id: "job", generation_id: "generation", committed_at: 95_000,
      normalized_payload: JSON.stringify(f.payload), proof_available: false, proof_live: true,
      proof_conflict: state === "ambiguous" }]);
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ attempted: 0, deferred: 1 });
    expect(f.receive).not.toHaveBeenCalled();
  });
  it("advances past a settled receiver exception without losing later captures", async () => {
    const f = await fixture(), retry = createPostgresExecutionCaptureRetry(f.options);
    f.receive.mockRejectedValueOnce(new Error("private endpoint exception"));
    expect(await retry.pollOnce(signal())).toMatchObject({ published: 0, failed: 1 });
    f.setRows([{ job_id: "later", generation_id: "generation", committed_at: 96_000,
      normalized_payload: JSON.stringify(f.payload), proof_available: false }]);
    expect(await retry.pollOnce(signal())).toMatchObject({ published: 1 });
    expect(f.query.mock.calls[1]![1]?.slice(4,6)).toEqual([95_000,"job"]);
  });
  it("rejects published counters that disagree with the receiver result", async () => {
    const f = await fixture();
    f.receive.mockResolvedValueOnce({ processed: 1, acquired: 1, published: 1, deferred: 0,
      results: [{ status: "deferred", reasonCode: "not-an-ack" }] } as any);
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ published: 0, failed: 1 });
  });
  it("rejects an ACK bound to another event or generation", async () => {
    const f = await fixture(), good = await f.receive({ payloads: [],signal: signal() });
    f.receive.mockClear();
    f.receive.mockResolvedValueOnce({ ...good,results: [{ ...good.results[0]!,
      externalBasis: { ...good.results[0]!.externalBasis,generationId: "wrong" } }] });
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ published: 0, failed: 1 });
  });
  it("holds busy until the native receiver actually acknowledges after cancellation", async () => {
    const f = await fixture(), good = await f.receive({ payloads: [],signal: signal() }); f.receive.mockClear();
    let finish!: (value: typeof good) => void;
    f.receive.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const retry = createPostgresExecutionCaptureRetry(f.options), controller = new AbortController();
    const pending = retry.pollOnce(controller.signal);
    await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce()); controller.abort();
    expect(await retry.pollOnce(signal())).toMatchObject({ reasonCode: "execution_retry_busy" });
    finish(good); expect(await pending).toMatchObject({ published: 1, reasonCode: "execution_retry_aborted_or_timed_out" });
  });
  it("checks SQL deduplication age, payload budget and independent authority without treating existence as validation", async () => {
    const f = await fixture(); await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal());
    const sql = f.query.mock.calls[0]![0];
    expect(sql).toContain("proof_live"); expect(sql).toContain("proof_conflict");
    expect(sql).toContain("observed_at<=f.known_at");
    expect(sql).toContain("maximum_fact_age");
    expect(sql).toContain("payload_bytes"); expect(sql).toContain("LIMIT 2");
  });
});

async function realRecoveryFixture() {
  const f = await fixture(), rpc = await sourceRpcFixture();
  const { generateKeyPairSync,verify } = await import("node:crypto");
  const { createPostgresUnitOfWork } = await import("../../../packages/database/src/postgres-unit-of-work.js");
  const { createPostgresServiceFactAdapters } = await import("../src/postgres-service-fact-adapters.js");
  const { createPostgresSolanaExecutionProducer } = await import("../src/postgres-wallet-rpc-producer.js");
  const { createConfiguredWalletRpcClient } = await import("../../wallet-monitor/src/rpc.js");
  const { createPostgresIndependentExecutionValidator } = await import("../src/postgres-independent-execution-validator.js");
  const { createPostgresExecutionFactPublisher,executionValidationSigningPayload } = await import("../src/postgres-execution-fact-publisher.js");
  const { createPostgresWalletExecutionReceiver } = await import("../src/postgres-wallet-execution-receiver.js");
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki",format: "pem" }).toString();
  let at = 200_000, nonce = 0, commitCount = 0, rollbackCount = 0, failAttestation = false, failAck = false;
  let holdCommit: (() => Promise<void>) | undefined;
  let inputs: Record<string,unknown>[] = [], attestations: Record<string,unknown>[] = [];
  let stagedInputs: typeof inputs = [], stagedAttestations: typeof attestations = [];
  const target = { database: "radar_business",schema: "radar_generation",username: "independent_publisher",serverAddress: "127.0.0.1",
    serverPort: 5432,generationId: "generation",schemaVersion: 3,schemaFingerprint: "b".repeat(64) };
  const commands: string[] = [];
  const nativeQuery = vi.fn(async (sql: string,values: unknown[] = []) => {
    commands.push(sql); let rows: Record<string,unknown>[] = [];
    if (sql === "BEGIN") { stagedInputs = []; stagedAttestations = []; }
    else if (sql === "COMMIT") {
      if (stagedInputs.length && holdCommit) await holdCommit();
      inputs.push(...stagedInputs); attestations.push(...stagedAttestations);
      const wrote = stagedInputs.length > 0; stagedInputs = []; stagedAttestations = []; commitCount++;
      if (wrote && failAck) throw new Error("private commit acknowledgement failure");
    } else if (sql === "ROLLBACK") { stagedInputs = []; stagedAttestations = []; rollbackCount++; }
    else if (sql.includes("execution-publisher-identity")) rows = [{ ...target,session_username: target.username,
      schema_generation: "generation",schema_version: 3,schema_fingerprint: target.schemaFingerprint,
      role_safe: true,consumer_member: false,objects_safe: true,can_publish: true }];
    else if (sql.includes("execution-publisher-validator")) rows = [{ valid_from: 0,valid_until: 1_000_000,revoked_at: null,import_revoked_at: null }];
    else if (sql.includes("execution-publisher-existing")) {
      const existing = inputs.find(row => row.fact_id === values[0]);
      if (existing) rows = [{ input: existing,attestation: attestations.find(row => row.fact_id === existing.fact_id) }];
    } else if (sql.includes("INSERT INTO wallet_service_fact_inputs")) stagedInputs.push(JSON.parse(String(values[0])));
    else if (sql.includes("INSERT INTO wallet_service_fact_attestations")) {
      if (failAttestation) throw new Error("private attestation insert failure");
      const row = JSON.parse(String(values[0])); stagedAttestations.push(row); rows = [{ fact_id: row.fact_id }];
    }
    return { rows,rowCount: rows.length };
  });
  const work = createPostgresUnitOfWork({ connect: async () => ({ query: nativeQuery,release: () => {} }) },
    { statementTimeoutMs: 1000,lockTimeoutMs: 500 });
  const used = new Map<string,number>(), leased = new Map<string,string>();
  let denyBudget = false;
  const budgetQuery = vi.fn(async (sql: string,args: readonly unknown[] = []) => {
    let rows: Record<string,unknown>[] = [];
    if (sql.includes("service-provider-budget-lock")) {
      const id = args[1] === "https://source.example" ? "source-rpc" : "replay-rpc";
      rows = [{ provider_id: id,window_started_at: 190_000,window_ms: 60_000,
        maximum_requests: denyBudget ? 1 : 60,requests_used: denyBudget ? 1 : used.get(id) ?? 0,
        maximum_concurrency: 1,active_leases: [...leased.values()].filter(value => value === id).length,cooldown_until: 0 }];
    } else if (sql.includes("service-provider-budget-debit")) { used.set(String(args[1]),Number(args[3])); rows = [{ provider_id: args[1] }]; }
    else if (sql.includes("INSERT INTO wallet_service_provider_leases")) leased.set(String(args[0]),String(args[2]));
    else if (sql.includes("service-provider-release")) leased.delete(String(args[0]));
    return { rows,rowCount: rows.length };
  });
  const budgetRuntime = { run: async <T>(operation: (tx: PostgresTransaction) => Promise<T>) => operation({ query: budgetQuery }),
    probe: async () => ({ generation: "generation",service: "wallet-monitor" }) } as any;
  const ports = await createPostgresServiceFactAdapters({ runtime: budgetRuntime,generationId: "generation",maximumProfiles: 10,now: () => at,
    sources: { leaseMs: 1000,maximumProfileAgeMs: 60_000,maximumFactAgeMs: 60_000,maximumSafetyAgeMs: 60_000,
      providerTimeoutMs: 1000,maximumResponseBytes: 128_000,maximumFactPayloadBytes: 128_000,fetchImpl: rpc.fetch } });
  const producer = createPostgresSolanaExecutionProducer({ generationId: "generation",activatedAt: 1000,providerId: "source-rpc",
    expectedGenesisHash: "genesis",profiles: rpc.profiles,maximumProfiles: 10,maximumPayloadBytes: 128_000,maximumRunMs: 2000,now: () => at,
    rpc: createConfiguredWalletRpcClient({ endpoints: { solana: { primary: "https://source.example/rpc" } },fetch: ports.fetch,now: () => at }) });
  const validator = createPostgresIndependentExecutionValidator({ generationId: "generation",activatedAt: 1000,validatorId: "validator",keyId: "key",
    publicKey,signingKey: { loadPrivateKey: () => keys.privateKey },reviewedProviderBindings: [{ chain: "solana",sourceProviderId: "source-rpc",
      sourceEndpoint: "https://source.example/rpc",replayProviderId: "replay-rpc",replayEndpoint: "https://independent.example/rpc",expectedGenesisHash: "genesis" }],
    fetch: ports.fetch,profiles: rpc.profiles,maximumProfiles: 10,maximumRpcRequests: 20,maximumLogs: 100,maximumDecimalsReads: 4,
    maximumPayloadBytes: 128_000,maximumRunMs: 2000,validationTtlMs: 60_000,maximumNonces: 20,
    nonce: () => `retry_nonce_sequence_0123456789_${++nonce}`,now: () => at });
  const publisher = await createPostgresExecutionFactPublisher({ run: work.run,target,
    forbiddenRoles: ["scanner","automation","wallet-monitor","wallet-analysis","historical-backfill","console","migrator"],
    validators: [{ validatorId: "validator",keyId: "key",publicKey,actorId: "independent-actor",
      authorizationRef: "fixture:execution-only-approval",reviewedSourceProviders: ["replay-rpc"] }],
    maximumValidationAgeMs: 60_000,maximumPayloadBytes: 128_000,statementTimeoutMs: 1000,lockTimeoutMs: 500,now: () => at });
  const receiver = createPostgresWalletExecutionReceiver({ generationId: "generation",producer,validator,publisher,
    maximumCandidates: 1,maximumPayloadBytes: 128_000,maximumRunMs: 2000,now: () => at });
  const scan = vi.fn(async () => {
    const live = attestations.filter(row => Number(row.expires_at) > at);
    return { rows: [{ job_id: "job",generation_id: "generation",committed_at: 95_000,normalized_payload: JSON.stringify(f.payload),
      proof_available: live.length === 1,proof_live: live.length > 0,proof_conflict: live.length > 1 }],rowCount: 1 };
  });
  const options = { ...f.options,maximumRunMs: 2000,maximumPayloadBytes: 128_000,maximumFactPayloadBytes: 128_000,
    run: async <T>(operation: (tx: PostgresTransaction) => Promise<T>) => operation({ query: (sql,values) => sql.includes("execution-retry-scan-timeout") ? Promise.resolve({ rows: [],rowCount: 0 }) : scan() }),receiver,now: () => at };
  return { options,receiver,validator,publisher,keys,rpc,scan,used,leased,commands,payload: f.payload,
    expiredValidation: rpc.request.validation,inputs: () => inputs,attestations: () => attestations,
    commits: () => commitCount,rollbacks: () => rollbackCount,
    setTime: (value: number) => { at = value; },deny: () => { denyBudget = true; },
    failAttestation: () => { failAttestation = true; },failAck: () => { failAck = true; },
    holdCommit: (hold: () => Promise<void>) => { holdCommit = hold; },
    verifySignature: (value: { claims: unknown;signature: string }) => verify(null,executionValidationSigningPayload(value.claims as any),keys.publicKey,Buffer.from(value.signature,"base64")) };
}

describe("real receiver execution retry integration", () => {
  it("reacquires and independently replays an old capture, signs a new proof and deduplicates after restart", async () => {
    const f = await realRecoveryFixture(), original = structuredClone(f.expiredValidation);
    expect(original.claims.expiresAt).toBeLessThan(200_000);
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ published: 1,failed: 0 });
    expect(f.inputs()).toHaveLength(1); expect(f.attestations()).toHaveLength(1);
    const stored = JSON.parse(String(f.inputs()[0]!.payload));
    expect(stored.validation.claims.checkedAt).toBe(200_000); expect(stored.validation.claims.expiresAt).toBe(260_000);
    expect(f.verifySignature(stored.validation)).toBe(true);
    expect(stored.executionEnvelope.candidate.knownAt).toBe(200_000);
    expect(f.expiredValidation).toEqual(original);
    expect(f.used.get("source-rpc")).toBe(4); expect(f.used.get("replay-rpc")).toBe(4); expect(f.leased.size).toBe(0);
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ attempted: 0,alreadyAvailable: 1 });
    expect(f.rpc.fetch).toHaveBeenCalledTimes(8); expect(f.inputs()).toHaveLength(1);
  });
  it("persists neither a lone fact nor a fake ACK when attestation insertion rolls back", async () => {
    const f = await realRecoveryFixture(); f.failAttestation();
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ published: 0,deferred: 1 });
    expect(f.inputs()).toHaveLength(0); expect(f.attestations()).toHaveLength(0); expect(f.rollbacks()).toBe(1);
    expect(f.commands).toContain("ROLLBACK"); expect(f.leased.size).toBe(0);
  });
  it("does not acknowledge an uncertain commit and uses durable evidence after restart", async () => {
    const f = await realRecoveryFixture(); f.failAck();
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ published: 0,deferred: 1 });
    expect(f.inputs()).toHaveLength(1); expect(f.attestations()).toHaveLength(1);
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ attempted: 0,alreadyAvailable: 1 });
    expect(f.rpc.fetch).toHaveBeenCalledTimes(8);
  });
  it("keeps the native commit and retry busy until the actual acknowledgement, even after cancellation", async () => {
    const f = await realRecoveryFixture(); let release!: () => void, committing = false;
    f.holdCommit(async () => { committing = true; await new Promise<void>(resolve => { release = resolve; }); });
    const retry = createPostgresExecutionCaptureRetry(f.options), controller = new AbortController();
    const pending = retry.pollOnce(controller.signal);
    await vi.waitFor(() => expect(committing).toBe(true),{ timeout: 1800 });
    expect(f.inputs()).toHaveLength(0); controller.abort();
    expect(await retry.pollOnce(signal())).toMatchObject({ reasonCode: "execution_retry_busy" });
    release(); expect(await pending).toMatchObject({ published: 1,reasonCode: "execution_retry_aborted_or_timed_out" });
    expect(f.inputs()).toHaveLength(1); expect(f.attestations()).toHaveLength(1);
  });
  it("uses the existing PG provider budget and never calls the provider on exhausted allowance", async () => {
    const f = await realRecoveryFixture(); f.deny();
    expect(await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal())).toMatchObject({ published: 0,deferred: 1,
      diagnostics: ["execution_rpc_provider_budget_unavailable"] });
    expect(f.rpc.fetch).not.toHaveBeenCalled(); expect(f.inputs()).toHaveLength(0); expect(f.leased.size).toBe(0);
  });
  it("rejects a new signature that expired before publication instead of extending it", async () => {
    const f = await realRecoveryFixture();
    const receiver = (await import("../src/postgres-wallet-execution-receiver.js")).createPostgresWalletExecutionReceiver({
      generationId: "generation",producer: { acquire: async input => {
        const { createPostgresSolanaExecutionProducer } = await import("../src/postgres-wallet-rpc-producer.js");
        return createPostgresSolanaExecutionProducer({ generationId: "generation",activatedAt: 1000,providerId: "source-rpc",expectedGenesisHash: "genesis",
          profiles: f.rpc.profiles,maximumProfiles: 10,maximumPayloadBytes: 128_000,maximumRunMs: 2000,now: () => 200_000,
          rpc: { request: async (_chain,method) => ({ getGenesisHash: "genesis",getSignatureStatuses: { value: [f.rpc.request.execution.evidence.signatureStatus] },
            getTransaction: f.rpc.request.execution.evidence.transaction,getBlock: f.rpc.request.execution.evidence.block } as Record<string,unknown>)[method] } }).acquire(input);
      } },validator: { validateExecution: async input => {
        const result = await f.validator.validateExecution(input);
        if (result.status === "verified") f.setTime(result.validation.claims.expiresAt);
        return result;
      } },publisher: f.publisher,maximumCandidates: 1,maximumRunMs: 2000,maximumPayloadBytes: 128_000,now: () => 200_000 });
    expect(await createPostgresExecutionCaptureRetry({ ...f.options,receiver }).pollOnce(signal())).toMatchObject({ published: 0,deferred: 1 });
    expect(f.inputs()).toHaveLength(0); expect(f.attestations()).toHaveLength(0);
  });
});

describe("review regression: bounded scheduling progress", () => {
  it("defers an oversized head using metadata and still processes the legal successor", async () => {
    const f = await fixture();
    f.setRows([
      { job_id: "head",generation_id: "generation",committed_at: 94000,payload_bytes: 30000,item_bytes: 30500,result_bytes: 400,normalized_payload: null,proof_available: false },
      { job_id: "job",generation_id: "generation",committed_at: 95000,payload_bytes: 5000,item_bytes: 5500,result_bytes: 5900,normalized_payload: JSON.stringify(f.payload),proof_available: false },
    ]);
    const retry = createPostgresExecutionCaptureRetry({ ...f.options,maximumCaptures: 2 });
    expect(await retry.pollOnce(signal())).toMatchObject({ published: 1,deferred: 1,diagnostics: ["execution_retry_capture_payload_exceeded"] });
    f.setRows([]); await retry.pollOnce(signal());
    expect(f.query.mock.calls.at(-1)![1]?.slice(4,6)).toEqual([95000,"job"]);
  });
  it("processes the byte-fitting prefix and leaves the next legal row for the next page", async () => {
    const f = await fixture();
    f.setRows([
      { job_id: "first",generation_id: "generation",committed_at: 94000,payload_bytes: 10000,item_bytes: 11000,result_bytes: 11002,normalized_payload: JSON.stringify(f.payload),proof_available: false },
      { job_id: "second",generation_id: "generation",committed_at: 95000,payload_bytes: 10000,item_bytes: 11000,result_bytes: 22002,normalized_payload: null,proof_available: false },
    ]);
    const retry = createPostgresExecutionCaptureRetry({ ...f.options,maximumCaptures: 2 });
    expect(await retry.pollOnce(signal())).toMatchObject({ published: 1,deferred: 0 });
    f.setRows([{ job_id: "second",generation_id: "generation",committed_at: 95000,normalized_payload: JSON.stringify(f.payload),proof_available: false }]);
    expect(await retry.pollOnce(signal())).toMatchObject({ published: 1 });
    expect(f.query.mock.calls.at(-1)![1]?.slice(4,6)).toEqual([94000,"first"]);
  });
  it("revisits an early transient failure at a fixed tail despite continuously appended full pages", async () => {
    const f = await fixture(); let calls = 0;
    f.receive.mockRejectedValueOnce(new Error("transient"));
    f.query.mockImplementation(async (_sql,values) => {
      calls++;
      const after = values?.[4] as number | null;
      const tail = values?.[11] as number | null;
      const at = after === null ? 94000 : after + 1000;
      return { rows: [{ job_id: `job-${at}`,generation_id: "generation",committed_at: at,
        cycle_tail_at: tail ?? 95000,cycle_tail_job: `job-${tail ?? 95000}`,
        normalized_payload: JSON.stringify(f.payload),proof_available: false }],rowCount: 1 };
    });
    const retry = createPostgresExecutionCaptureRetry(f.options);
    expect(await retry.pollOnce(signal())).toMatchObject({ failed: 1 });
    await retry.pollOnce(signal());
    expect(await retry.pollOnce(signal())).toMatchObject({ published: 1 });
    expect(f.query.mock.calls[2]![1]?.[4]).toBeNull();
    expect(calls).toBe(3); expect(f.receive).toHaveBeenCalledTimes(3);
  });
  it("returns on the scan deadline but fences reentry until the SQL transaction drains", async () => {
    const f = await fixture(); let release!: () => void;
    f.query.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { rows: [],rowCount: 0 }; });
    const retry = createPostgresExecutionCaptureRetry({ ...f.options,maximumRunMs: 30 });
    const pending = retry.pollOnce(signal());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const early = await Promise.race([pending,new Promise(resolve => setTimeout(() => resolve("late"),100))]);
    expect(early).toMatchObject({ reasonCode: "execution_retry_aborted_or_timed_out" });
    expect(await retry.pollOnce(signal())).toMatchObject({ reasonCode: "execution_retry_busy" });
    release(); await new Promise(resolve => setTimeout(resolve,0));
    expect(f.receive).not.toHaveBeenCalled();
    f.setRows([]);
    expect(await retry.pollOnce(signal())).not.toMatchObject({ reasonCode: "execution_retry_busy" });
  });
  it("caps the scan SQL timeout by both remaining time and the existing native timeout", async () => {
    const f = await fixture(), sqls: string[] = [];
    const run = async <T>(operation: (tx: PostgresTransaction) => Promise<T>) => operation({ query: async (sql,values) => {
      sqls.push(sql); return sql.includes("execution-retry-scan-timeout") ? { rows: [],rowCount: 0 } : f.query(sql,values);
    } });
    await createPostgresExecutionCaptureRetry({ ...f.options,run }).pollOnce(signal());
    expect(sqls[0]).toContain("execution-retry-scan-timeout");
    expect(sqls[0]).toContain("least"); expect(sqls[0]).toContain("current_setting('statement_timeout')");
  });
});

describe("scan remaining-time and connection acquisition fences", () => {
  it("subtracts elapsed connection acquisition time before configuring the SQL timeout", async () => {
    const f = await fixture(), timeouts: number[] = [];
    const run = async <T>(operation: (tx: PostgresTransaction) => Promise<T>) => {
      f.setNow(100900);
      return operation({ query: async (sql,values) => {
        if (sql.includes("execution-retry-scan-timeout")) { timeouts.push(Number(values?.[0])); return { rows: [],rowCount: 0 }; }
        return f.query(sql,values);
      } });
    };
    expect(await createPostgresExecutionCaptureRetry({ ...f.options,run }).pollOnce(signal())).toMatchObject({ published: 1 });
    expect(timeouts[0]).toBeGreaterThan(0); expect(timeouts[0]).toBeLessThanOrEqual(100);
  });
  it("does not begin SQL after a timed-out connection acquisition finally drains", async () => {
    const f = await fixture(); let release!: () => void;
    const run = async <T>(operation: (tx: PostgresTransaction) => Promise<T>) => {
      await new Promise<void>(resolve => { release = resolve; }); return operation({ query: f.query });
    };
    const retry = createPostgresExecutionCaptureRetry({ ...f.options,run,maximumRunMs: 30 });
    expect(await retry.pollOnce(signal())).toMatchObject({ reasonCode: "execution_retry_aborted_or_timed_out" });
    expect(await retry.pollOnce(signal())).toMatchObject({ reasonCode: "execution_retry_busy" });
    release(); await new Promise(resolve => setTimeout(resolve,0));
    expect(f.query).not.toHaveBeenCalled(); expect(f.receive).not.toHaveBeenCalled();
  });
});

describe("page container reservation boundaries", () => {
  it.each([0,1,2])("reserves two container bytes for an item at budget minus %i", async reserve => {
    const f = await fixture(), budget = f.options.maximumPayloadBytes;
    const row = { job_id: "edge",generation_id: "generation",committed_at: 94000,
      item_bytes: budget - reserve,payload_bytes: 1000,result_bytes: reserve < 2 ? 600 : budget,
      normalized_payload: reserve < 2 ? null : JSON.stringify(f.payload),proof_available: false };
    f.setRows([row]);
    const retry = createPostgresExecutionCaptureRetry(f.options);
    expect(await retry.pollOnce(signal())).toMatchObject(reserve < 2
      ? { deferred: 1,published: 0,diagnostics: ["execution_retry_capture_payload_exceeded"] }
      : { deferred: 0,published: 1 });
    f.setRows([]); await retry.pollOnce(signal());
    expect(f.query.mock.calls.at(-1)![1]?.slice(4,6)).toEqual([94000,"edge"]);
  });
  it("uses the same reserved item budget for SQL admission, JSON parsing and returned payload", async () => {
    const f = await fixture(); await createPostgresExecutionCaptureRetry(f.options).pollOnce(signal());
    const sql = f.query.mock.calls[0]![0];
    expect(sql.match(/item_bytes<=\(\$4-2\)/g)).toHaveLength(3);
    expect(sql).toContain("octet_length(n.normalized_payload)<=($4-2)");
  });
});

// Opt-in synthetic SQL acceptance in a caller-owned, network-isolated disposable PG16 container.
// This never accepts a connection URL, existing database, host port or production credentials.
const isolatedPgContainer = process.env.ADDRESS_RADAR_EXECUTION_RETRY_PG_CONTAINER;
describe("isolated PostgreSQL page container boundaries", () => {
  it.skipIf(!isolatedPgContainer).each([0,1,2])("executes the production scan at budget minus %i", async reserve => {
    const { spawnSync } = await import("node:child_process");
    expect(isolatedPgContainer).toMatch(/^address-only-execution-retry-[a-f0-9]{16}$/);
    const inspect = spawnSync("docker",["inspect","--format",
      '{{index .Config.Labels "address-radar.fixture"}}|{{.HostConfig.NetworkMode}}|{{json .HostConfig.PortBindings}}',isolatedPgContainer!],
    { encoding: "utf8",timeout: 3000,maxBuffer: 4096 });
    expect(inspect.status).toBe(0);
    expect(inspect.stdout.trim()).toMatch(/^execution-retry-boundaries\|none\|(null|\{\})$/);
    const f = await fixture(); await createPostgresExecutionCaptureRetry({ ...f.options,maximumCaptures: 2 }).pollOnce(signal());
    const [sql,originalValues] = f.query.mock.calls[0]!;
    const literal = (value: unknown) => value === null ? "NULL" : typeof value === "number" ? String(value)
      : "'" + String(value).replaceAll("'","''") + "'";
    const { writeFileSync } = await import("node:fs");
    let fixtureSequence = 0;
    const execute = (values: readonly unknown[]) => {
      const ddl = `
        CREATE TEMP TABLE capture_normalized_results(job_id text,normalized_payload text,committed_at bigint,event_kind text,requires_review boolean);
        CREATE TEMP TABLE capture_normalization_jobs(job_id text,source_namespace text,source_event_id text,semantic_fingerprint text,status text);
        CREATE TEMP TABLE wallet_capture_generation_bindings(source_namespace text,source_event_id text,semantic_fingerprint text,generation_id text,created_at bigint);
        CREATE TEMP TABLE forward_strategy_generations(generation_id text,activated_at bigint);
        CREATE TEMP TABLE capture_consumer_intents(intent_id text,job_id text);
        CREATE TEMP TABLE capture_consumer_jobs(intent_id text,consumer_name text,status text,next_attempt_at bigint);
        CREATE TEMP TABLE wallet_service_fact_inputs(fact_id text,fingerprint text,payload text,observed_at bigint,known_at bigint,generation_id text,kind text,provider_id text,subject_key text);
        CREATE TEMP TABLE wallet_service_fact_attestations(generation_id text,fact_id text,kind text,fingerprint text,checked_at bigint,expires_at bigint,validation_ref text,validator_id text);
        CREATE TEMP TABLE wallet_service_fact_validators(generation_id text,validator_id text,kind text,import_id text,valid_from bigint,valid_until bigint,revoked_at bigint);
        CREATE TEMP TABLE wallet_service_import_ledger(generation_id text,import_id text,revoked_at bigint,proof_scope text,imported_at bigint);
      `;
      const padded = JSON.stringify({ ...f.payload,fixturePadding: "x".repeat(6000) });
      const seed = `
        INSERT INTO forward_strategy_generations VALUES('generation',1000);
        INSERT INTO capture_normalized_results VALUES('edge',${literal(padded)},94000,'buy',false),('later',${literal(JSON.stringify(f.payload))},95000,'buy',false);
        INSERT INTO capture_normalization_jobs VALUES('edge','fixture','edge','a','completed'),('later','fixture','later','b','completed');
        INSERT INTO wallet_capture_generation_bindings VALUES('fixture','edge','a','generation',94000),('fixture','later','b','generation',95000);
        INSERT INTO capture_consumer_intents VALUES('edge','edge'),('later','later');
        INSERT INTO capture_consumer_jobs VALUES('edge','forward_purchase_match','pending',100000),('later','forward_purchase_match','pending',100000);
      `;
      // PREPARE intentionally has no declared parameter types: exercise native driver-style inference too.
      const script = `BEGIN; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='500ms';
        SET LOCAL search_path=pg_catalog,pg_temp; ${ddl} ${seed}
        PREPARE retry_scan AS SELECT row_to_json(scan) FROM (${sql}) scan;
        EXECUTE retry_scan(${values.map(literal).join(",")}); DEALLOCATE retry_scan; ROLLBACK;`;
      writeFileSync(`/private/tmp/address-only-execution-retry-boundary-${reserve}-${++fixtureSequence}.sql`,script,{ mode: 0o600 });
      const result = spawnSync("docker",["exec","-i",isolatedPgContainer!,"psql","-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-U","postgres","-d","postgres"],
        { input: script,encoding: "utf8",timeout: 5000,maxBuffer: 512000 });
      // Synthetic fixture only; report the SQLSTATE rather than SQL text or payload on failure.
      if (result.status !== 0) throw new Error("Isolated execution retry SQL fixture failed: " +
        (result.stderr.match(/ERROR:\s*([^\n]+)/)?.[1]?.replace(/"[^\"]*"/g,'"redacted"') ?? "unavailable"));
      return result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string,unknown>);
    };
    const probe = execute(originalValues!);
    expect(probe[0]?.job_id).toBe("edge");
    const budget = Number(probe[0]!.item_bytes) + reserve;
    const values = [...originalValues!]; values[3] = budget;
    const rows = execute(values);
    writeFileSync(`/private/tmp/address-only-execution-retry-boundary-${reserve}.expected.json`,JSON.stringify({
      budget,itemBytes: Number(probe[0]!.item_bytes),reserve,
      rows: rows.map(row => ({ jobId: row.job_id,payloadPresent: typeof row.normalized_payload === "string",resultBytes: Number(row.result_bytes) })),
      nextCursor: [94000,"edge"],nextTail: [95000,"later"],nextFirstJob: "later",
    },null,2)+"\n",{ mode: 0o600 });
    expect(rows[0]?.job_id).toBe("edge");
    expect(Number(rows[0]!.result_bytes)).toBeLessThanOrEqual(budget);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(budget);
    if (reserve < 2) {
      expect(rows[0]!.normalized_payload).toBeNull();
      expect(rows[1]?.job_id).toBe("later"); expect(rows[1]!.normalized_payload).toBeTypeOf("string");
    } else {
      expect(rows[0]!.normalized_payload).toBeTypeOf("string"); expect(rows).toHaveLength(1);
    }
    values[4] = 94000; values[5] = "edge"; values[11] = 95000; values[12] = "later";
    expect(execute(values)[0]?.job_id).toBe("later");
  });
});
