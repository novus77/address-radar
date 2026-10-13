import { createHash } from "node:crypto";
import { mkdtemp, writeFile, symlink, rm, realpath, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertPreservationResources, validatePreservationRehearsalConfig, verifyPreservationParityChunk, readPrivatePreservationFile, createPreservationGuardedClient, createPreservationResourceCheckpoint, classifyPreservationFailure } from "../rehearse-postgres-full-preservation.js";
import type { VerifiedFullDataPreservationChunk, VerifiedFullDataPreservationManifest } from "../../packages/database/src/postgres-full-data-import.js";

import { PostgresCommitUncertainError, type PostgresClient } from "../../packages/database/src/postgres-unit-of-work.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const gib = 1024 ** 3;
const config = () => ({ version: 1, stage: "resume", bundleDirectory: "/private/fixture/bundle", evidenceDirectory: "/private/fixture/evidence",
  storagePath: "/private/fixture/pgdata", authorityModule: "/private/fixture/authority.mjs", authorityModuleSha256: "a".repeat(64),
  approvalRef: "external-fixture-approval", deadlineAtMs: Date.now() + 60_000,
  expected: { manifestSha256: "b".repeat(64), snapshotSha256: "c".repeat(64), catalogFingerprint: "d".repeat(64), tables: 141, rows: 6023033, chunks: 1548 },
  target: { database: "radar_rehearsal_0123456789abcdef", schema: "radar_rehearsal_0123456789abcdef_history", username: "radar_preserver",
    serverAddress: "127.0.0.1", serverPort: 5434, systemIdentifier: "7333333333333333333", schemaVersion: 1, schemaFingerprint: "e".repeat(64),
    generation: "historical-fixture-only", service: "migration-preservation" },
  resources: { reserveBytes: 5 * gib, maximumTargetGrowthBytes: 10 * gib, minimumAvailableMemoryBytes: gib,
    maximumRssBytes: 192 * 1024 ** 2, maximumMemoryPsiAvg10: 1, maximumResidentChunkBytes: 2 * 1024 ** 2 },
  maximumTotalQueries: 100000, maximumTransactionMs: 30000, maximumQueriesPerTransaction: 1000,
  interruptAfterCommittedChunks: 1 });
const resources = () => ({ freeBytes: 30 * gib, availableMemoryBytes: 2 * gib, rssBytes: 100 * 1024 ** 2, memoryPsiAvg10: 0 });
describe("bounded preservation rehearsal guards", () => {
  it("accepts only an explicitly pinned same-nonce private 5434 target", () => {
    expect(validatePreservationRehearsalConfig(config()).expected.rows).toBe(6023033);
  });
  it("accepts import-only work but refuses to extend its fifteen-minute invocation", () => {
    const c = { ...config(), stage: "import", deadlineAtMs: Date.now() + 899_000 };
    expect(validatePreservationRehearsalConfig(c).stage).toBe("import");
    expect(() => validatePreservationRehearsalConfig({ ...c, deadlineAtMs: Date.now() + 901_000 })).toThrow("limit");
  });
  it.each(["serverPort", "database", "schema"])("rejects unsafe target %s", key => {
    const c = config(); Object.assign(c.target, { [key]: key === "serverPort" ? 5433 : "radar_rehearsal_fedcba9876543210" });
    expect(() => validatePreservationRehearsalConfig(c)).toThrow();
  });
  it.each([0, 5 * gib - 1])("refuses disk reserve below five GiB: %s", reserveBytes => {
    const c = config(); c.resources.reserveBytes = reserveBytes;
    expect(() => validatePreservationRehearsalConfig(c)).toThrow();
  });
  it("requires growth headroom before import and retains reserve during resume", () => {
    const c = validatePreservationRehearsalConfig(config());
    expect(() => assertPreservationResources(c, { ...resources(), freeBytes: 14 * gib }, true)).toThrow("disk");
    expect(() => assertPreservationResources(c, { ...resources(), freeBytes: 6 * gib }, false)).not.toThrow();
    expect(() => assertPreservationResources(c, { ...resources(), freeBytes: 4 * gib }, false)).toThrow("disk");
  });
  it.each([{ availableMemoryBytes: gib - 1 }, { rssBytes: gib }, { memoryPsiAvg10: 2 }, { memoryPsiAvg10: NaN }])("stops on pressure or unknown measurement %j", change => {
    expect(() => assertPreservationResources(validatePreservationRehearsalConfig(config()), { ...resources(), ...change }, false)).toThrow();
  });
  it("rejects unknown config keys and missing source pins", () => {
    expect(() => validatePreservationRehearsalConfig({ ...config(), applyProduction: true })).toThrow();
    const c = config(); c.expected.snapshotSha256 = ""; expect(() => validatePreservationRehearsalConfig(c)).toThrow();
  });
  it("refuses heap-pressure-sized chunks rather than silently increasing the reviewed limit", () => {
    const c = config(); c.resources.maximumResidentChunkBytes = 16 * 1024 ** 2;
    expect(() => validatePreservationRehearsalConfig(c)).toThrow();
  });
  it("accepts a larger immutable chunk only through an explicit measured rollback allowance",()=>{
    const c=config();c.resources.maximumResidentChunkBytes=16775058;c.resources.maximumRssBytes=256*1024**2;
    const proof={manifestSha256:c.expected.manifestSha256,chunkSha256:"f".repeat(64),chunkBytes:16775058,measuredPeakRssBytes:100*1024**2,maximumRssBytes:c.resources.maximumRssBytes,rollbackObserved:true};
    expect(validatePreservationRehearsalConfig(c,proof).resources.maximumResidentChunkBytes).toBe(16775058);
    for(const change of [{rollbackObserved:false},{manifestSha256:"a".repeat(64)},{chunkBytes:16775059},{measuredPeakRssBytes:257*1024**2}])expect(()=>validatePreservationRehearsalConfig(c,{...proof,...change})).toThrow();
  });
  it("reads private regular bytes and rejects symlinks, public files and oversize files", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "radar-preservation-private-"));
    try {
      const file = join(root, "private.json"), link = join(root, "link.json"), publicFile = join(root, "public.json");
      await writeFile(file, "private bytes", { mode: 0o600 }); await writeFile(publicFile, "public", { mode: 0o644 }); await chmod(publicFile, 0o644);
      await symlink(file, link); expect((await readPrivatePreservationFile(file, 64)).toString()).toBe("private bytes");
      await expect(readPrivatePreservationFile(link, 64)).rejects.toThrow();
      await expect(readPrivatePreservationFile(publicFile, 64)).rejects.toThrow("private_file");
      await expect(readPrivatePreservationFile(file, 1)).rejects.toThrow("private_file");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("independent typed opaque-byte parity", () => {
  const body = Buffer.from(JSON.stringify({ values: [{ storage: "integer", value: "9223372036854775807" },
    { storage: "blob", value: "AP8=", encoding: "base64" }, { storage: "null" },
    { storage: "text", value: "AP8=", encoding: "base64" }, { storage: "real", value: "-inf" }] }));
  const manifest = { value: { operationId: "historical-op", snapshotSha256: "a".repeat(64) }, manifestSha256: "b".repeat(64) } as VerifiedFullDataPreservationManifest;
  const chunk = { rowBodies: [body], rows: [JSON.parse(body.toString())], body: Buffer.from("source chunk"),
    plan: { table: "history", ordinal: 2, startRow: 10, rowCount: 1, file: "table-0000-chunk-000002.json", sha256: hash("source chunk") } } as VerifiedFullDataPreservationChunk;
  const rows = () => [{ operation_id: "historical-op", snapshot_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64),
    table_name: "history", row_ordinal: "10", chunk_ordinal: "2", row_body: Buffer.from(body) }];
  it("preserves bigint, blob, null, opaque text and legacy infinity without qualification", () => {
    expect(verifyPreservationParityChunk(manifest, chunk, rows())).toEqual({ rows: 1, cells: { integer: 1, blob: 1, null: 1, text: 1, real: 1 },
      integersBeyondSafeRange: 1, blobBytes: 2, textBytes: 2, rowBytes: body.length });
  });
  it.each(["body", "lineage", "ordinal", "missing", "duplicate"])("rejects durable %s tampering", change => {
    const target = rows();
    if (change === "body") target[0]!.row_body = Buffer.from(body.toString().replace("9223372036854775807", "9223372036854775806"));
    if (change === "lineage") target[0]!.snapshot_sha256 = "c".repeat(64);
    if (change === "ordinal") target[0]!.row_ordinal = "11";
    if (change === "missing") target.pop(); if (change === "duplicate") target.push(target[0]!);
    expect(() => verifyPreservationParityChunk(manifest, chunk, target)).toThrow();
  });
});

const sqlMetrics = () => ({ rawSql: 0, commitAttempts: 0, acknowledgedCommits: 0,
  rollbackAttempts: 0, acknowledgedRollbacks: 0, failedRollbacks: 0 });
function guardedFixture(options: { maximumTotalQueries?: number; deadlineAtMs?: number; failRollback?: boolean; failCommit?: boolean } = {}) {
  const metrics = sqlMetrics(), calls: string[] = [], pressure = new Error("preservation_rehearsal_rss_limit");
  let pressured = false, releaseError: Error | boolean | undefined;
  const physical: PostgresClient = {
    async query(sql) {
      calls.push(sql);
      if (sql === "SELECT fixture_pressure") pressured = true;
      if (sql === "ROLLBACK" && options.failRollback) throw new Error("fixture_cleanup_secret_must_not_escape");
      if (sql === "COMMIT" && options.failCommit) throw new Error("fixture_commit_ack_lost_secret");
      return { rows: [], rowCount: 0 };
    },
    release(error) { releaseError = error; },
  };
  const client = createPreservationGuardedClient(physical, {
    checkpoint() { if (pressured) throw pressure; },
    deadlineAtMs: options.deadlineAtMs ?? Date.now() + 10000,
    maximumTotalQueries: options.maximumTotalQueries ?? 10, metrics,
  });
  return { client, calls, metrics, pressure, releaseError: () => releaseError };
}
describe("exact bounded cleanup after resource admission closes", () => {
  it("allows only exact ROLLBACK and records physical ACK without admitting writes or COMMIT", async () => {
    const fixture = guardedFixture();
    await fixture.client.query("BEGIN"); await fixture.client.query("SELECT fixture_pressure");
    for (const sql of ["INSERT fixture", "COMMIT", "ROLLBACK;", " rollback", "ROLLBACK TO SAVEPOINT fixture"])
      await expect(fixture.client.query(sql)).rejects.toBe(fixture.pressure);
    await fixture.client.query("ROLLBACK");
    expect(fixture.calls).toEqual(["BEGIN", "SELECT fixture_pressure", "ROLLBACK"]);
    expect(fixture.metrics).toEqual({ rawSql: 3, commitAttempts: 0, acknowledgedCommits: 0,
      rollbackAttempts: 1, acknowledgedRollbacks: 1, failedRollbacks: 0 });
    await expect(fixture.client.query("COMMIT")).rejects.toBe(fixture.pressure);
  });
  it.each(["deadline", "budget"])("does not exempt cleanup from its existing %s bound", async reason => {
    const fixture = guardedFixture(reason === "deadline" ? { deadlineAtMs: Date.now() - 1 } : { maximumTotalQueries: 0 });
    await expect(fixture.client.query("ROLLBACK")).rejects.toThrow(reason === "deadline" ? "deadline" : "physical_sql_budget");
    expect(fixture.calls).toEqual([]); expect(fixture.metrics.rollbackAttempts).toBe(0);
    expect(fixture.metrics.acknowledgedRollbacks).toBe(0);
  });
  it("retains the resource category and failed cleanup without manufacturing a rollback ACK", async () => {
    const fixture = guardedFixture({ failRollback: true });
    await fixture.client.query("BEGIN"); await fixture.client.query("SELECT fixture_pressure");
    let failure: unknown;
    try { await fixture.client.query("COMMIT"); }
    catch (original) {
      try { await fixture.client.query("ROLLBACK"); }
      catch (cleanup) { failure = new AggregateError([original, cleanup], "PostgreSQL operation and rollback failed"); }
    }
    expect(classifyPreservationFailure(failure)).toEqual({
      reason: "preservation_rehearsal_rss_limit", primaryCategory: "preservation_rehearsal_rss_limit",
      commitUncertaintyObserved: false, cleanupFailureObserved: true,
    });
    expect(fixture.metrics.rollbackAttempts).toBe(1); expect(fixture.metrics.acknowledgedRollbacks).toBe(0);
    expect(fixture.metrics.failedRollbacks).toBe(1); expect(fixture.metrics.acknowledgedCommits).toBe(0);
    const discarded = new Error("fixture_discard");
    fixture.client.release(discarded); expect(fixture.releaseError()).toBe(discarded);
    expect(JSON.stringify(classifyPreservationFailure(failure))).not.toContain("secret");
  });
  it("keeps COMMIT uncertainty even when a later ROLLBACK is acknowledged", async () => {
    const fixture = guardedFixture({ failCommit: true });
    await fixture.client.query("BEGIN");
    let uncertain: unknown;
    try { await fixture.client.query("COMMIT"); }
    catch (cause) { uncertain = new PostgresCommitUncertainError(cause); }
    await fixture.client.query("ROLLBACK");
    const failure = classifyPreservationFailure(uncertain);
    expect(failure.commitUncertaintyObserved).toBe(true);
    expect(failure.reason).toBe("FAILED_OR_COMMIT_UNKNOWN_RECONCILE_BEFORE_RETRY");
    expect(fixture.metrics.commitAttempts).toBe(1); expect(fixture.metrics.acknowledgedCommits).toBe(0);
    expect(fixture.metrics.acknowledgedRollbacks).toBe(1);
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
  it("bounds cyclic failure traversal and does not emit arbitrary prefixed messages", () => {
    const error = new Error("preservation_rehearsal_token_secret");
    Object.defineProperty(error, "cause", { value: error });
    expect(classifyPreservationFailure(error).reason).toBe("FAILED_OR_COMMIT_UNKNOWN_RECONCILE_BEFORE_RETRY");
  });
});
describe("released-frame checkpoint with sticky peak", () => {
  it("forces GC within the throttle interval without resetting an earlier peak", () => {
    const measurement = process.resourceUsage(), gc = vi.fn(), metrics = { peakRssBytes: 128 * 1024 ** 2 };
    vi.stubGlobal("gc", gc);
    const sample = vi.spyOn(process, "resourceUsage").mockReturnValue({ ...measurement, maxRSS: 64 * 1024 });
    try {
      const c = validatePreservationRehearsalConfig(config());
      const checkpoint = createPreservationResourceCheckpoint(c, metrics, () => undefined);
      checkpoint(); checkpoint(true); checkpoint(true);
      expect(gc).toHaveBeenCalledTimes(3); expect(metrics.peakRssBytes).toBe(128 * 1024 ** 2);
      sample.mockReturnValue({ ...measurement, maxRSS: 257 * 1024 });
      expect(() => checkpoint(true)).toThrow("rss_limit");
      sample.mockReturnValue({ ...measurement, maxRSS: 64 * 1024 });
      expect(() => checkpoint(true)).toThrow("rss_limit");
      expect(metrics.peakRssBytes).toBe(257 * 1024 ** 2);
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
  it("propagates pressure before new work even at a released boundary", () => {
    const pressure = new Error("fixture_pressure"), metrics = { peakRssBytes: 0 };
    const checkpoint = createPreservationResourceCheckpoint(validatePreservationRehearsalConfig(config()), metrics, () => pressure);
    expect(() => checkpoint(true)).toThrow(pressure); expect(metrics.peakRssBytes).toBe(0);
  });
});
