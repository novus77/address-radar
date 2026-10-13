import { expect, test, vi } from "vitest";
import { sourceRpcFixture } from "./postgres-source-fact-fixture.js";
import { createPostgresExecutionFactPublisher } from "../src/postgres-execution-fact-publisher.js";
import { createPostgresExecutionEnvelopeReader } from "../src/postgres-execution-envelope-reader.js";
import { createPostgresRpcSourceFactCandidateVerifier } from "../src/postgres-rpc-source-fact-candidate.js";
import { createPostgresServiceFactAdapters, postgresServiceFactFingerprint } from "../src/postgres-service-fact-adapters.js";
import { preparePostgresWalletCapture } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import type { PostgresBusinessRuntime } from "../../../packages/database/src/postgres-business-driver.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";

async function fixture() {
  const rpc = await sourceRpcFixture(), execution = rpc.request.execution, validation = rpc.request.validation;
  const target = { database: "address_radar", schema: "business", username: "execution_publisher", serverAddress: "127.0.0.1", serverPort: 5432,
    generationId: "generation", schemaVersion: 1, schemaFingerprint: "b".repeat(64) };
  let fact: Record<string, any> | undefined, attestation: Record<string, any> | undefined, now = 100_000, missing = false, duplicate = false;
  const query = vi.fn(async (sql: string, args: readonly unknown[] = []) => {
    if (sql.includes("execution-publisher-identity")) return { rows: [{ ...target, session_username: target.username,
      schema_generation: target.generationId, schema_version: 1, schema_fingerprint: target.schemaFingerprint,
      role_safe: true, consumer_member: false, objects_safe: true, can_publish: true }], rowCount: 1 };
    if (sql.includes("execution-publisher-validator")) return { rows: [{ valid_from: 0, valid_until: 200_000, revoked_at: null, import_revoked_at: null }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO wallet_service_fact_inputs")) fact = JSON.parse(String(args[0]));
    if (sql.startsWith("INSERT INTO wallet_service_fact_attestations")) {
      attestation = JSON.parse(String(args[0])); return { rows: [{ fact_id: attestation!.fact_id }], rowCount: 1 };
    }
    if (sql.includes("execution-envelope-read")) {
      const row = { ...rpc.row, ...fact, ...attestation, validator_from: 0, validator_until: 200_000,
        revoked_at: null, import_revoked_at: null, imported_at: 0, proof_scope: "validator_authority", ...overrides };
      return { rows: missing ? [] : duplicate ? [row, row] : [row], rowCount: missing ? 0 : duplicate ? 2 : 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const overrides: Record<string, unknown> = {};
  const run = <T>(operation: (tx: PostgresTransaction) => Promise<T>) => operation({ query });
  const publisher = await createPostgresExecutionFactPublisher({ run, target,
    forbiddenRoles: ["wallet", "scanner", "console", "backfill", "ability", "signal", "migration"],
    validators: [{ validatorId: "validator", keyId: "key", actorId: "reviewer", authorizationRef: "approval",
      publicKey: rpc.options.authority.publicKey, reviewedSourceProviders: ["replay-rpc"] }],
    maximumValidationAgeMs: 60_000, maximumPayloadBytes: 128_000, statementTimeoutMs: 1000, lockTimeoutMs: 100, now: () => now });
  await publisher.publish({ candidate: execution, validation, signal: rpc.request.signal });
  const options = { run, generationId: "generation", activatedAt: 1000, replayAuthority: rpc.options.authority,
    maximumValidationAgeMs: 60_000, maximumPayloadBytes: 128_000, maximumRunMs: 1000, now: () => now };
  const request = { generationId: "generation", sampleId: "sample", executionFingerprint: "a".repeat(64), signal: rpc.request.signal };
  const edit = (operation: (payload: any) => void) => {
    const payload = JSON.parse(fact!.payload); operation(payload); fact!.payload = JSON.stringify(payload);
    fact!.fingerprint = postgresServiceFactFingerprint(payload); attestation!.fingerprint = fact!.fingerprint;
  };
  return { rpc, execution, validation, query, run, options, request, reader: createPostgresExecutionEnvelopeReader(options), overrides, edit,
    fact: () => fact!, setNow: (value: number) => { now = value; }, missing: () => { missing = true; }, duplicate: () => { duplicate = true; } };
}

test("loads exact persisted envelope for the original sample revision without RPC, current profiles or fresh timestamps", async () => {
  const f = await fixture(), result = await f.reader.load(f.request);
  expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error(result.reasonCode);
  expect(result.request).toEqual({ sampleId: "sample", executionFingerprint: "a".repeat(64), execution: f.execution,
    validation: f.validation, signal: f.request.signal });
  expect(f.rpc.fetch).not.toHaveBeenCalled(); expect(f.rpc.profiles.load).not.toHaveBeenCalled();
  expect(result.request.execution.knownAt).toBe(f.execution.knownAt);
  expect(result.request.validation.claims.expiresAt).toBe(160_000);
  const writes = f.query.mock.calls.filter(([sql]) => /INSERT|UPDATE|DELETE/.test(sql)).length;
  expect((await createPostgresRpcSourceFactCandidateVerifier(f.rpc.options).verify(result.request)).status).toBe("candidate_ready");
  expect(f.query.mock.calls.filter(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toHaveLength(writes);
});

test("defers legacy rows without an original envelope rather than synthesizing one", async () => {
  const f = await fixture(); f.edit(payload => { delete payload.executionEnvelope; });
  expect(await f.reader.load(f.request)).toMatchObject({ status: "deferred", reasonCode: "execution_envelope_unavailable" });
});

test.each(["revision", "original", "sample", "generation", "quantity", "ownership", "execution-ref", "authority", "import", "expired", "future", "activation", "missing", "ambiguous"])(
  "fails closed on changed native binding: %s", async kind => {
    const f = await fixture();
    if (kind === "revision") f.overrides.revision_state = "pending_review";
    if (kind === "original") f.overrides.original_fingerprint = "c".repeat(64);
    if (kind === "sample") f.overrides.sample_id = "other";
    if (kind === "generation") f.overrides.generation_id = "other";
    if (kind === "quantity") f.overrides.token_quantity = "999";
    if (kind === "ownership") f.overrides.ownership_evidence_ref = "different";
    if (kind === "execution-ref") f.overrides.execution_evidence_ref = "different";
    if (kind === "authority") f.overrides.revoked_at = 99_000;
    if (kind === "import") f.overrides.import_revoked_at = 99_000;
    if (kind === "expired") f.setNow(160_000);
    if (kind === "future") f.overrides.recorded_at = 100_001;
    if (kind === "activation") f.overrides.activated_at = 1001;
    if (kind === "missing") f.missing();
    if (kind === "ambiguous") f.duplicate();
    expect(await f.reader.load(f.request)).toMatchObject({ status: "deferred" });
  });

test.each(["candidate", "signature", "validation", "acquired", "format", "original-time", "provider", "fingerprint"])(
  "rejects changed immutable envelope: %s", async kind => {
    const f = await fixture(); f.edit(payload => {
      if (kind === "candidate") payload.executionEnvelope.candidate.profile.versionId = "invented";
      if (kind === "signature") payload.executionEnvelope.validation.signature = "invalid";
      if (kind === "validation") payload.validation.claims.validationRef = "invented";
      if (kind === "acquired") payload.acquiredEvidence.blockHash = "invented";
      if (kind === "format") payload.executionEnvelope.format = 2;
      if (kind === "original-time") payload.executionEnvelope.candidate.knownAt = 100_001;
      if (kind === "provider") payload.executionEnvelope.candidate.providerId = "invented";
      if (kind === "fingerprint") payload.executionEnvelope.candidate.contentFingerprint = "d".repeat(64);
    });
    expect(await f.reader.load(f.request)).toMatchObject({ status: "deferred" });
  });

test("bounds native read, payload, generation and abort before producing a request", async () => {
  const f = await fixture();
  expect(await f.reader.load({ ...f.request, generationId: "other" })).toMatchObject({ status: "deferred" });
  const controller = new AbortController(); controller.abort();
  expect(await f.reader.load({ ...f.request, signal: controller.signal })).toMatchObject({ status: "deferred" });
  f.query.mockClear();
  expect(await createPostgresExecutionEnvelopeReader({ ...f.options, maximumPayloadBytes: 10 }).load(f.request)).toMatchObject({ status: "deferred" });
  expect(f.query.mock.calls[0]![0]).toMatch(/LIMIT 2/);
  expect(f.query.mock.calls[0]![0]).toContain("octet_length");
  expect(f.query.mock.calls[0]![0]).toContain("pending_review");
  expect(f.query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(/INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE/);
});

test.each(["full-envelope", "legacy"])("preserves purchase consumer compatibility with %s payload", async kind => {
  const f = await fixture(), profile = f.rpc.profile, claims = f.validation.claims;
  if (kind === "legacy") f.edit(payload => { delete payload.executionEnvelope; });
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("service-fact-inputs")
    ? [{ ...f.fact(), validator_id: claims.validatorId, validation_ref: claims.validationRef, checked_at: claims.checkedAt,
      expires_at: claims.expiresAt, validator_from: 0, validator_until: 200_000, revoked_at: null, import_revoked_at: null }]
    : sql.includes("service-fact-profile-cohort") ? [{ entity_id: profile.fact.entityId, wallet_family: "solana",
      subject_key: JSON.stringify(["wallet", "solana", profile.wallet.address]), proof_scope: "legacy_registry_linkage",
      imported_at: 90_000, observed_at: 95_000, import_revoked_at: null, enabled: true, suspended: false,
      profile_payload: JSON.stringify(profile), channel_payload: JSON.stringify(profile.fact),
      profile_known_at: 95_000, channel_known_at: 95_000, channel_version_id: profile.versionId,
      profile_version_id: "profile-version", import_id: "registry-import", owner_entity_id: profile.fact.entityId, conflict_at: null }] : [], rowCount: 1 }));
  const runtime = { run: <T>(operation: (tx: { query: typeof query }) => Promise<T>) => operation({ query }),
    probe: async () => ({ generation: "generation", service: "scanner", schema: "business", database: "address_radar" }) } as unknown as PostgresBusinessRuntime;
  const ports = await createPostgresServiceFactAdapters({ runtime, generationId: "generation", maximumProfiles: 10,
    now: () => 100_000, sources: { leaseMs: 5000, maximumProfileAgeMs: 60_000, maximumFactAgeMs: 60_000,
      maximumSafetyAgeMs: 10_000, providerTimeoutMs: 1000, maximumResponseBytes: 1000, maximumFactPayloadBytes: 128_000 } });
  const payload = preparePostgresWalletCapture({ generationId: "generation", collectorId: "solana", sessionId: "compatibility",
    chainFamily: "solana", receivedAt: 100_000, profile, executionTrust: "unverified", event: { eventId: "event", chain: "solana",
      walletAddress: profile.wallet.address, tokenAddress: claims.purchase.tokenAddress, side: "buy", occurredAt: claims.purchase.occurredAt,
      amountUsd: null, priceUsd: null, marketCapUsd: null, sourceReference: claims.sourceReference } }).payload;
  expect(await ports.facts.purchase({ generationId: "generation", asOf: 100_000, limit: 10, signal: f.request.signal,
    lease: {} as never, payload })).toMatchObject({ status: "verified", purchase: claims.purchase });
});
