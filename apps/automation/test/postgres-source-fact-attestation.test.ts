import { generateKeyPairSync, verify } from "node:crypto";
import { expect, test, vi } from "vitest";
import { sourceRpcFixture } from "./postgres-source-fact-fixture.js";
import { createPostgresRpcSourceFactCandidateVerifier } from "../src/postgres-rpc-source-fact-candidate.js";
import { createPostgresIndependentSourceValidator } from "../src/postgres-independent-source-validator.js";
import { createPostgresSourceFactPublisher } from "../src/postgres-source-fact-publisher.js";
import { createPostgresSourceFactReceiver } from "../src/postgres-source-fact-receiver.js";
import { sourceValidationSigningPayload } from "../src/postgres-source-fact-attestation.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";

const keys = generateKeyPairSync("ed25519"), at = 100_000;
async function fixture() {
  const rpc = await sourceRpcFixture();
  const ready = await createPostgresRpcSourceFactCandidateVerifier(rpc.options).verify(rpc.request);
  if (ready.status !== "candidate_ready") throw new Error(ready.reasonCode);
  const candidate = ready.candidate;
  let now = at, stateAvailable = true, failWake = false, safeIdentity = true, insertAvailable = true;
  let facts: Record<string, unknown>[] = [], attestations: Record<string, unknown>[] = [], wakes: unknown[][] = [];
  const target = { database: "address_radar", schema: "business", username: "source_publisher", serverAddress: "127.0.0.1", serverPort: 5432,
    generationId: "generation", schemaVersion: 1, schemaFingerprint: "b".repeat(64) };
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("execution-publisher-identity")) return { rows: [{ ...target, session_username: target.username,
      schema_generation: target.generationId, schema_version: 1, schema_fingerprint: target.schemaFingerprint,
      role_safe: safeIdentity, consumer_member: false, objects_safe: true, can_publish: true }], rowCount: 1 };
    if (sql.includes("source-publisher-privileges")) return { rows: [{ safe: safeIdentity }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO wallet_service_fact_inputs")) { facts.push(JSON.parse(String(values[0]))); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("INSERT INTO wallet_service_fact_attestations")) {
      const value = JSON.parse(String(values[0]));
      if (!insertAvailable || !stateAvailable) return { rows: [], rowCount: 0 };
      attestations.push(value); return { rows: [{ fact_id: value.fact_id }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO wallet_forward_signal_wake_intents")) {
      if (failWake) throw new Error("wake failed"); wakes.push([...values]); return { rows: [], rowCount: 1 };
    }
    if (sql.includes("source-publisher-existing")) {
      const fact = facts.find(row => row.fact_id === values[0]);
      return { rows: fact ? [{ input: fact, attestation: attestations.find(row => row.fact_id === fact.fact_id) }] : [], rowCount: fact ? 1 : 0 };
    }
    if (sql.includes("source-envelope-state")) return { rows: stateAvailable ? [{ sample_id: "sample", chain: "solana", token_address: "TokenCase" }] : [], rowCount: stateAvailable ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  });
  const run = async <T>(operation: (tx: PostgresTransaction) => Promise<T>) => {
    const snapshot = structuredClone({ facts, attestations, wakes });
    try { return await operation({ query }); }
    catch (error) { ({ facts, attestations, wakes } = snapshot); throw error; }
  };
  const binding = { generationId: "generation", activatedAt: 1000, maximumProfileAgeMs: 86_400_000,
    maximumValidationAgeMs: 60_000, maximumPayloadBytes: 128_000, replayAuthority: rpc.options.authority, now: () => now };
  const validatorOptions = { ...binding, run, validatorId: "source-validator", keyId: "source-key", actorId: "source-reviewer",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), signingKey: { loadPrivateKey: () => keys.privateKey },
    validationTtlMs: 30_000, maximumRunMs: 1000, maximumNonces: 100, nonce: () => "source_nonce_0123456789" };
  const publisherOptions = { ...binding, run, target, forbiddenRoles: ["wallet", "scanner", "console", "backfill", "ability", "signal", "migration"],
    validators: [{ validatorId: validatorOptions.validatorId, keyId: validatorOptions.keyId, actorId: validatorOptions.actorId,
      authorizationRef: "source-approval", publicKey: validatorOptions.publicKey, reviewedSourceProviders: ["replay-rpc"] }],
    statementTimeoutMs: 1000, lockTimeoutMs: 100 };
  const validator = createPostgresIndependentSourceValidator(validatorOptions);
  const publisher = await createPostgresSourceFactPublisher(publisherOptions);
  const signal = new AbortController().signal;
  const sign = async (value = candidate) => {
    const result = await validator.validateSource({ candidate: value, signal });
    if (result.status !== "verified") throw new Error(result.reasonCode);
    return result.validation;
  };
  return { ...rpc, candidate, validatorOptions, publisherOptions, validator, publisher, signal, sign, query,
    facts: () => facts, attestations: () => attestations, wakes: () => wakes,
    setNow: (value: number) => { now = value; }, setState: (value: boolean) => { stateAvailable = value; },
    failWake: () => { failWake = true; }, denyInsert: () => { insertAvailable = false; }, denyIdentity: () => { safeIdentity = false; } };
}

test("independently rechecks native binding and signs the entire source envelope without repeating RPC", async () => {
  const f = await fixture(), validation = await f.sign();
  expect(verify(null, sourceValidationSigningPayload(validation.claims), keys.publicKey, Buffer.from(validation.signature, "base64"))).toBe(true);
  expect(validation.claims).toMatchObject({ sampleId: "sample", executionFingerprint: "a".repeat(64), targetVersionId: "version",
    validatorId: "source-validator", keyId: "source-key", checkedAt: at, expiresAt: at + 30_000 });
  expect(f.query.mock.calls.some(([sql]) => sql.includes("source-envelope-state"))).toBe(true);
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.facts()).toHaveLength(0);
});

test("publishes source fact, exact-envelope signature and wake atomically and deduplicates identical replay", async () => {
  const f = await fixture(), validation = await f.sign();
  const request = { candidate: f.candidate, validation, signal: f.signal };
  expect(await f.publisher.publish(request)).toMatchObject({ status: "published" });
  expect(await f.publisher.publish(request)).toMatchObject({ status: "duplicate" });
  expect(f.facts()).toHaveLength(1); expect(f.attestations()).toHaveLength(1); expect(f.wakes()).toHaveLength(1);
  const fact = f.facts()[0]!, payload = JSON.parse(String(fact.payload));
  expect(fact).toMatchObject({ kind: "source", subject_key: f.candidate.subjectKey, provider_id: "source-rpc" });
  expect(payload).toMatchObject({ canonical: "confirmed_live_execution", sampleId: "sample", executionFingerprint: "a".repeat(64),
    target: f.profile.fact, targetVersionId: "version", validation, replayEvidence: f.candidate.replayEvidence });
  expect(payload).not.toHaveProperty("riskVerdict"); expect(payload).not.toHaveProperty("independenceKey");
});

test.each(["sample", "revision", "target", "version", "replay", "signature", "checkedAt", "generation"])(
  "rejects tampered exact envelope before any write: %s", async kind => {
    const f = await fixture(), candidate = structuredClone(f.candidate);
    let validation = await f.sign();
    if (kind === "sample") (candidate.payload as any).sampleId = "other";
    if (kind === "revision") (candidate.payload as any).executionFingerprint = "c".repeat(64);
    if (kind === "target") (candidate.payload.target as any).ownershipEvidenceRef = "other";
    if (kind === "version") (candidate as any).targetVersionId = "other";
    if (kind === "replay") (candidate.replayEvidence.claims as any).validationRef = "other";
    if (kind === "signature") validation = { ...validation, signature: "invalid" };
    if (kind === "checkedAt") (candidate as any).checkedAt++;
    if (kind === "generation") (candidate as any).generationId = "old";
    await expect(f.publisher.publish({ candidate, validation, signal: f.signal })).rejects.toThrow();
    expect(f.facts()).toHaveLength(0);
  });

test("does not promote candidate_ready or a claimed verified flag without an independent signature", async () => {
  const f = await fixture();
  await expect(f.publisher.publish({ candidate: f.candidate, validation: { status: "verified" } as any, signal: f.signal })).rejects.toThrow();
  expect(f.facts()).toHaveLength(0);
});

test.each(["revoked", "old-revision", "target-drift", "expired", "identity"])("defers changed publication state: %s", async kind => {
  const f = await fixture(), validation = await f.sign();
  if (kind === "expired") f.setNow(at + 30_000);
  else if (kind === "identity") f.denyIdentity();
  else f.setState(false);
  if (kind === "identity") await expect(f.publisher.publish({ candidate: f.candidate, validation, signal: f.signal })).rejects.toThrow();
  else expect(await f.publisher.publish({ candidate: f.candidate, validation, signal: f.signal })).toMatchObject({ status: "deferred" });
  expect(f.facts()).toHaveLength(0);
});

test("checks current authority/revision/target in the attestation INSERT and rolls back a lost binding", async () => {
  const f = await fixture(), validation = await f.sign(); f.denyInsert();
  await expect(f.publisher.publish({ candidate: f.candidate, validation, signal: f.signal })).rejects.toThrow();
  expect(f.facts()).toHaveLength(0); expect(f.attestations()).toHaveLength(0); expect(f.wakes()).toHaveLength(0);
  const sql = f.query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO wallet_service_fact_attestations"))![0];
  for (const guard of ["forward_trade_revisions", "pending_review", "targetVersionId", "revoked_at", "expiresAt", "forward_target_identity_bindings"])
    expect(sql).toContain(guard);
  expect(sql).not.toMatch(/FOR SHARE|FOR UPDATE/);
});

test("rolls back fact and attestation when wake persistence fails", async () => {
  const f = await fixture(), validation = await f.sign(); f.failWake();
  await expect(f.publisher.publish({ candidate: f.candidate, validation, signal: f.signal })).rejects.toThrow();
  expect(f.facts()).toHaveLength(0); expect(f.attestations()).toHaveLength(0);
});

test("rechecks live state for replay and rejects immutable proof collisions", async () => {
  const f = await fixture(), validation = await f.sign(), request = { candidate: f.candidate, validation, signal: f.signal };
  await f.publisher.publish(request); f.setState(false);
  expect(await f.publisher.publish(request)).toMatchObject({ status: "deferred" });
  f.setState(true); f.facts()[0]!.fingerprint = "tampered";
  await expect(f.publisher.publish(request)).rejects.toThrow(/collision/i);
});

test("validator defers missing current authority, stale proof, abort and repeated signing nonce", async () => {
  const f = await fixture(); f.setState(false);
  expect(await f.validator.validateSource({ candidate: f.candidate, signal: f.signal })).toMatchObject({ status: "deferred" });
  f.setState(true); await f.sign();
  expect(await f.validator.validateSource({ candidate: f.candidate, signal: f.signal })).toMatchObject({ status: "deferred" });
  f.setNow(at + 60_000);
  expect(await f.validator.validateSource({ candidate: f.candidate, signal: f.signal })).toMatchObject({ status: "deferred" });
  const controller = new AbortController(); controller.abort();
  expect(await f.validator.validateSource({ candidate: f.candidate, signal: controller.signal })).toMatchObject({ status: "deferred" });
});

test("receiver wires candidate -> independent validator -> publisher and fails closed without authority", async () => {
  const f = await fixture(), candidateVerifier = createPostgresRpcSourceFactCandidateVerifier(f.options);
  const receiver = createPostgresSourceFactReceiver({ candidateVerifier, validator: f.validator, publisher: f.publisher, maximumPayloadBytes: 128_000 });
  expect(await receiver.receive(f.request)).toMatchObject({ status: "published" });
  const missing = createPostgresSourceFactReceiver({ candidateVerifier, maximumPayloadBytes: 128_000 });
  expect(await missing.receive(f.request)).toMatchObject({ status: "deferred", reasonCode: "source_validator_or_publisher_unavailable" });
});
