import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { collectNativePostgresCompatibility } from "./migration-native-compatibility-collector.js";
import { migrationCutoverCanonicalJson, POSTGRES_COMPATIBILITY_GUARD_CHECKS, type WriterFencePolicy } from "./migration-cutover-coordinator.js";
import type { PostgresBusinessRuntime } from "./postgres-business-driver.js";
const sha = (value: unknown) => createHash("sha256").update(migrationCutoverCanonicalJson(value)).digest("hex");
const target = { database: "private_rehearsal", schema: "fixture", generation: "generation", schemaSha256: "a".repeat(64), releaseSha256: "b".repeat(64), serverAddress: "127.0.0.1", serverPort: 5434, systemIdentifier: "1" };
const policy = { evidenceMode: "production-observation", version: 2, binding: { target, rollbackTarget: { ...target, releaseSha256: "c".repeat(64) } },
  postgresRollbackCatalog: [{ table: "records", operations: ["insert"] }], postgresRollbackVerifier: { issuerId: "fixture", keyId: "fixture" },
  budgets: { maximumSqlStatements: 100 }, guards: [] } as unknown as WriterFencePolicy;
const select = { sql: "SELECT fixture", values: [] };
const program = { cases: [{ table: "records", operation: "insert" as const, candidate: { sql: "INSERT fixture", values: [] },
  compatibleRead: select, expectedReadSha256: sha([{ fixture: 1 }]), compatibleWrite: { sql: "INSERT fixture", values: [] } }],
  guards: POSTGRES_COMPATIBILITY_GUARD_CHECKS.map(check => ({ check, precondition: select, preconditionSha256: sha([{ fixture: 1 }]),
    attempt: { sql: "UPDATE guarded", values: [] }, expectedSqlState: null, preserved: select, preservedSha256: sha([{ fixture: 1 }]) })),
  rollbackProbe: { sql: "INSERT rollback", values: [] } };
function fixtures() {
  let now = 1700000000000;
  const calls: string[] = [];
  const runtime = {
    probe: async () => ({ ...target, schemaFingerprint: target.schemaSha256 }),
    run: async (fn: (tx: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) => fn({ query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('canonical_row')) return { rows: [{ canonical_row: '{"fixture":1}' }], rowCount: 1 };
      if (sql.startsWith('SELECT')) return { rows: [{ fixture: 1 }], rowCount: 1 };
      return { rows: [], rowCount: sql.includes('guarded') ? 0 : 1 };
    } }),
  } as unknown as PostgresBusinessRuntime;
  return { runtime, calls, clock: () => ++now, deadline: now + 10000 };
}
test("fixture ports exercise complete measured operation and fixed guard coverage", async () => {
  const f = fixtures();
  const proof = await collectNativePostgresCompatibility({ policy, program, candidate: f.runtime, compatible: f.runtime,
    deadline: f.deadline, clock: f.clock, reconcileCommitUnknown: async () => ({ committed: true, reconciled: true, receipt: { fixtureOnly: true } }) });
  assert.equal(proof.tableChecks[0]!.retainedSha256, proof.tableChecks[0]!.recoveredSha256);
  assert.equal(proof.guardChecks.length, 7);
  assert.ok(f.calls.some(sql => sql === 'INSERT fixture'));
});
test("missing actual operation plan fails before native writes", async () => {
  const f = fixtures();
  await assert.rejects(collectNativePostgresCompatibility({ policy, program: { ...program, cases: [] }, candidate: f.runtime,
    compatible: f.runtime, deadline: f.deadline, clock: f.clock,
    reconcileCommitUnknown: async () => { throw new Error('must not run'); } }));
  assert.equal(f.calls.length, 0);
});
test("expired original deadline fails before operations", async () => {
  const f = fixtures();
  await assert.rejects(collectNativePostgresCompatibility({ policy, program, candidate: f.runtime, compatible: f.runtime,
    deadline: 0, clock: f.clock, reconcileCommitUnknown: async () => { throw new Error('must not run'); } }));
  assert.equal(f.calls.length, 0);
});
