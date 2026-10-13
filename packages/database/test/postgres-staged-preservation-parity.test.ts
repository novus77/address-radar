import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPostgresUnitOfWork, type PostgresClient } from "../src/postgres-unit-of-work.js";
import { verifyFullDataPreservationManifest } from "../src/postgres-full-data-import.js";
import { verifyStagedFullDataPreservationSegment, finalizeStagedFullDataPreservation, createStagedPreservationCompletionSchemaSql } from "../src/postgres-staged-preservation-parity.js";

const canonical = (value: any): string => Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" :
  value !== null && typeof value === "object" ? "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child)).join(",") + "}" : JSON.stringify(value);
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function fixture(run: (f: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "radar-staged-parity-"));
  const row = { values: [{ storage: "integer", value: "42" }] };
  const catalog = { objects: [{ type: "table", name: "history", tbl_name: "history", sql: "CREATE TABLE history(a)" }],
    tables: [{ name: "history", columns: [[0, "a", "", 0, null, 0, 0]], foreignKeys: [], indexes: [] }],
    sequences: [], pragmas: { encoding: "UTF-8", user_version: 0, application_id: 0 } };
  const plans = [], chunks: any[] = [], rows: any[] = [];
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    const file = `table-0000-chunk-${String(ordinal).padStart(6, "0")}.json`;
    const bytes = Buffer.from(canonical({ version: 1, operationId: "preserve-1", snapshotSha256: "a".repeat(64), table: "history", ordinal, startRow: ordinal, rows: [row] }));
    plans.push({ file, table: "history", ordinal, startRow: ordinal, rowCount: 1, sha256: digest(bytes) });
    chunks.push({ table_name: "history", ordinal: String(ordinal), file, start_row: String(ordinal), row_count: "1", sha256: digest(bytes), chunk_body: bytes, chunk_bytes: String(bytes.length) });
    rows.push({ table_name: "history", row_ordinal: String(ordinal), chunk_ordinal: String(ordinal), row_body: Buffer.from(canonical(row)) });
    await writeFile(join(directory, file), bytes);
  }
  const manifestBody = Buffer.from(canonical({ version: 1, operationId: "preserve-1", snapshotSha256: "a".repeat(64), snapshotBytes: 4096,
    catalogFingerprint: digest(canonical(catalog)), completed: true, businessActivation: false,
    limits: { maximumChunkBytes: 16384, rowsPerChunk: 64 }, catalog,
    tables: [{ name: "history", completed: true, rowCount: 2, contentSha256: digest((canonical(row) + "\n").repeat(2)), chunks: plans }] }));
  await writeFile(join(directory, "manifest.json"), manifestBody);
  const manifest = verifyFullDataPreservationManifest(manifestBody);
  const lineage = { operation_id: "preserve-1", snapshot_sha256: manifest.value.snapshotSha256, manifest_sha256: manifest.manifestSha256 };
  chunks.forEach(item => Object.assign(item, lineage)); rows.forEach(item => Object.assign(item, lineage));
  const table = { ...lineage, table_name: "history", row_count: "2", chunk_count: "2", content_sha256: manifest.value.tables[0]!.contentSha256 };
  const operation = { ...lineage, catalog_fingerprint: manifest.value.catalogFingerprint, manifest_body: manifestBody,
    planned_tables: "1", planned_chunks: "2", planned_rows: "2", completed: false };
  const binding = { sessionId: "session-1", freezeEpoch: "epoch-1", operationId: "preserve-1", snapshotSha256: manifest.value.snapshotSha256,
    manifestSha256: manifest.manifestSha256, target: { database: "fixture", schema: "preservation", endpoint: "private-socket", systemIdentifier: "123" },
    freezeEvidenceSha256: "f".repeat(64) };
  let completion: any = null, uncertain = false, rollback: any, reads = 0, measurementEpoch = "epoch-1", extraRow = false;
  let commitPersists = true, failCompletion = false;
  const calls: string[] = [], trustedArtifacts = new Set<string>();
  function uow(role: string) {
    const client: PostgresClient = { release() {}, async query(text, values = []) {
      calls.push(text);
      if (role === "finalizer") {
        // SQL ACL model only: this is not a live PostgreSQL privilege/freeze attestation.
        if (text.includes("staged-parity:selectCompletion") && /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/i.test(text)) {
          throw new Error("completion receipt ACL denies UPDATE/row locking");
        }
        if (/\b(?:CREATE|ALTER|DROP|GRANT|REVOKE)\b|\bSET\s+ROLE\b/i.test(text)) throw new Error("finalizer ACL denies authority changes");
        if (/\bUPDATE\b/i.test(text) && !/\bFOR\s+UPDATE\b/i.test(text)) {
          const allowed = text.includes("preservation:verifyTable") ? new Set(["verified_manifest_sha256", "verified_row_count", "verified_chunk_count"]) :
            text.includes("preservation:completeOperation") ? new Set(["completed"]) : new Set<string>();
          const assignments = /\bSET\s+([\s\S]*?)\bWHERE\b/i.exec(text)?.[1] ?? "";
          const columns = [...assignments.matchAll(/\b([a-z_]+)\s*=/g)].map(match => match[1]!);
          if (!columns.length || columns.some(column => !allowed.has(column))) throw new Error("finalizer column ACL denies UPDATE");
        }
        if (/\bINSERT\s+INTO\b/i.test(text) && !text.includes("staged-parity:insertCompletion")) throw new Error("finalizer ACL denies data INSERT");
        if (/\b(?:DELETE|TRUNCATE)\b/i.test(text)) throw new Error("finalizer ACL denies data mutation");
      }
      const result = (items: any[] = []) => ({ rows: items, rowCount: items.length });
      if (text === "BEGIN") rollback = { completed: operation.completed, completion };
      if (text === "ROLLBACK") { operation.completed = rollback.completed; completion = rollback.completion; }
      if (text === "COMMIT") {
        if (uncertain && operation.completed && !commitPersists) {
          operation.completed = rollback.completed; completion = rollback.completion;
          uncertain = false; throw new Error("lost acknowledgement before commit");
        }
        rollback = { completed: operation.completed, completion };
        if (uncertain && operation.completed) { uncertain = false; throw new Error("lost acknowledgement"); }
      }
      if (text.includes("preservation:targetIdentity")) return result([{ ...binding.target, role }]);
      if (text.includes("preservation:selectOperation")) return result([operation]);
      if (text.includes("preservation:selectTables")) return result([table]);
      if (text.includes("preservation:selectChunkBodySlice")) return result(chunks.filter(c => c.ordinal === String(values[2])).map(c => ({ body: c.chunk_body.subarray(Number(values[3]) - 1, Number(values[3]) - 1 + Number(values[4])) })));
      if (text.includes("preservation:selectChunk")) return result(chunks.filter(c => c.ordinal === String(values[2])));
      if (text.includes("preservation:selectRows")) return result(rows.filter(r => Number(r.row_ordinal) >= Number(values[2]) && Number(r.row_ordinal) < Number(values[3])));
      if (text.includes("preservation:countRows")) return result([{ row_count: String(rows.length + Number(extraRow)) }]);
      if (text.includes("staged-parity:counts")) return result([{ table_count: "1", chunk_count: String(chunks.length), row_count: String(rows.length + Number(extraRow)) }]);
      if (text.includes("staged-parity:selectCompletion")) return result(completion ? [completion] : []);
      if (text.includes("staged-parity:insertCompletion")) { if (failCompletion) throw new Error("injected completion failure"); completion = { operation_id: values[0], snapshot_sha256: values[1], manifest_sha256: values[2], session_id: values[3], freeze_epoch: values[4], boundary_sha256: values[5], proofs_sha256: values[6] }; return result([completion]); }
      if (text.includes("preservation:verifyTable")) return result([{ table_name: "history" }]);
      if (text.includes("preservation:completeOperation")) { operation.completed = true; return result([{ operation_id: "preserve-1" }]); }
      return result();
    } };
    return createPostgresUnitOfWork({ async connect() { return client; } }, { statementTimeoutMs: 1000, lockTimeoutMs: 1000 });
  }
  const input = { bundleDirectory: directory, unitOfWork: uow("verifier"), target: { ...binding.target, role: "verifier" }, binding,
    maximumEvidenceAgeMs: 60_000,
    executionBudget: { deadlineAtMs: Date.now() + 30_000, maximumTransactionMs: 5000, maximumQueriesPerTransaction: 10000, maximumTotalQueries: 100000,
      opaqueRowWindows: { maximumRows: 1, maximumBytes: 64 } }, closeReserveMs: 1000,
    freeze: { async readLiveMeasurement() { reads++; return Buffer.from(canonical({ binding: { ...binding, freezeEpoch: measurementEpoch }, observedAtMs: Date.now(), validUntilMs: Date.now() + 60_000 })); },
      async verifyMeasurement(bytes: Uint8Array) { return JSON.parse(Buffer.from(bytes).toString()); } } };
  const proofs: any[] = [];
  async function verify(start: number, end: number) {
    const proof = await verifyStagedFullDataPreservationSegment({ ...input, selection: { startChunkIndex: start, endChunkIndexExclusive: end } });
    proofs.push(proof); trustedArtifacts.add(proof.artifactSha256); return proof;
  }
  const finalInput = (role = "owner") => ({ ...input, unitOfWork: uow(role), target: { ...binding.target, role }, proofs,
    evidence: { trustedVerifierId: "protected-receipts", async verifyArtifact(bytes: Uint8Array) {
      const artifactSha256 = digest(bytes); return trustedArtifacts.has(artifactSha256) ? { artifactSha256, verifierId: "protected-receipts" } : null;
    } } });
  try { await run({ input, verify, proofs, finalInput, chunks, rows, operation, calls, reads: () => reads,
    setEpoch: (value: string) => { measurementEpoch = value; }, uncertain: () => { uncertain = true; },
    setExtraRow: () => { extraRow = true; }, completion: () => completion,
    loseCommit: () => { uncertain = true; commitPersists = false; }, failCompletion: () => { failCompletion = true; } }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe("independent staged preservation parity", () => {
  it("exports opt-in receipt DDL with a source lineage FK and rejects unsafe schema names", () => {
    expect(createStagedPreservationCompletionSchemaSql("preservation")).toContain("full_data_preservation_staged_completions");
    expect(createStagedPreservationCompletionSchemaSql("preservation")).toContain("FOREIGN KEY (operation_id,snapshot_sha256,manifest_sha256)");
    expect(() => createStagedPreservationCompletionSchemaSql("public")).toThrow();
    expect(() => createStagedPreservationCompletionSchemaSql('x"; DROP SCHEMA x')).toThrow();
  });
  it("compares both target representations without importer verification flags and revalidates freeze", async () => fixture(async f => {
    const proof = await f.verify(0, 1);
    expect(proof.artifactSha256).toBe(digest(proof.bytes));
    expect(f.reads()).toBe(2);
    expect(f.operation.completed).toBe(false);
    expect(f.calls.some((text: string) => text.includes("verifyChunk") || text.includes("completeOperation"))).toBe(false);
  }));
  it.each(["chunk", "row"])("rejects changed %s bytes independently", async representation => fixture(async f => {
    if (representation === "chunk") f.chunks[0].chunk_body = Buffer.from("changed"); else f.rows[0].row_body = Buffer.from("changed");
    await expect(f.verify(0, 1)).rejects.toThrow(/body/);
  }));
  it("rejects freeze changes after target reads", async () => fixture(async f => {
    const original = f.input.freeze.readLiveMeasurement;
    f.input.freeze.readLiveMeasurement = async () => { if (f.reads() === 1) f.setEpoch("changed"); return original(); };
    await expect(f.verify(0, 1)).rejects.toThrow(/freeze/);
  }));
  it("rejects an unavailable measurement verifier", async () => fixture(async f => {
    f.input.freeze.verifyMeasurement = async () => null;
    await expect(f.verify(0, 1)).rejects.toThrow(/freeze/);
    expect(f.calls).toHaveLength(0);
  }));
  it("rejects a freeze lifetime that does not cover work and close reserve", async () => fixture(async f => {
    const original = f.input.freeze.verifyMeasurement;
    f.input.freeze.verifyMeasurement = async (...args: any[]) => ({ ...await original(...args), validUntilMs: Date.now() + 1000 });
    await expect(f.verify(0, 1)).rejects.toThrow(/freeze_lifetime/);
    expect(f.calls).toHaveLength(0);
  }));
  it("rejects an invocation exceeding fifteen minutes", async () => fixture(async f => {
    f.input.executionBudget.deadlineAtMs = Date.now() + 901_000;
    await expect(f.verify(0, 1)).rejects.toThrow(/invocation_budget/);
    expect(f.calls).toHaveLength(0);
  }));
});
describe("staged preservation finalizer", () => {
  it("uses direct native UOW with a nonowner column-limited finalizer and insert-only receipt ledger", async () => fixture(async f => {
    await f.verify(0, 2);
    const start = f.calls.length;
    expect(await finalizeStagedFullDataPreservation(f.finalInput("finalizer"))).toMatchObject({ completed: true, completionOutcome: "acknowledged" });
    const calls: string[] = f.calls.slice(start);
    expect(calls.some(text => text.includes("preservation:selectOperation") && text.includes("FOR UPDATE"))).toBe(true);
    expect(calls.some(text => text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(calls.filter(text => text.includes("staged-parity:selectCompletion")).every(text => !text.includes("FOR UPDATE"))).toBe(true);
    expect(calls.some(text => text.includes("staged-parity:insertCompletion"))).toBe(true);
    const inserts = f.calls.filter((text: string) => text.includes("staged-parity:insertCompletion")).length;
    await finalizeStagedFullDataPreservation(f.finalInput("finalizer"));
    expect(f.calls.filter((text: string) => text.includes("staged-parity:insertCompletion"))).toHaveLength(inserts);
  }));
  it("reconciles unknown native COMMIT with the same nonowner finalizer ACL", async () => fixture(async f => {
    await f.verify(0, 2); f.uncertain();
    expect(await finalizeStagedFullDataPreservation(f.finalInput("finalizer"))).toMatchObject({ completed: true, completionOutcome: "reconciled" });
  }));
  it("rejects oversized proof bytes before source or target work", async () => fixture(async f => {
    const input = f.finalInput();
    input.proofs.push({ artifactSha256: "a".repeat(64), bytes: Buffer.alloc(4 * 1024 ** 2 + 1) });
    await expect(finalizeStagedFullDataPreservation(input)).rejects.toThrow(/artifact_size/);
    expect(f.calls).toHaveLength(0); expect(f.reads()).toBe(0);
  }));
  it("requires full trusted artifact coverage then commits exact completion bindings", async () => fixture(async f => {
    await f.verify(0, 1); await f.verify(1, 2);
    const result = await finalizeStagedFullDataPreservation(f.finalInput());
    expect(result).toMatchObject({ completed: true, parityComplete: true, completionOutcome: "acknowledged", grantsBusinessEligibility: false });
    expect(f.operation.completed).toBe(true); expect(f.completion().freeze_epoch).toBe("epoch-1");
  }));
  it.each(["missing", "duplicate", "bytes", "epoch", "untrusted", "extra"])("cannot complete with %s proof/accounting", async failure => fixture(async f => {
    await f.verify(0, 1); await f.verify(1, 2);
    const input = f.finalInput();
    if (failure === "missing") input.proofs.pop();
    if (failure === "duplicate") input.proofs.push(input.proofs[0]);
    if (failure === "bytes") input.proofs[0] = { ...input.proofs[0], bytes: Buffer.from("{}") };
    if (failure === "epoch") f.setEpoch("changed");
    if (failure === "untrusted") input.evidence.verifyArtifact = async () => null;
    if (failure === "extra") f.setExtraRow();
    await expect(finalizeStagedFullDataPreservation(input)).rejects.toThrow();
    expect(f.operation.completed).toBe(false);
  }));
  it("reconciles lost native COMMIT acknowledgement against exact durable receipt", async () => fixture(async f => {
    await f.verify(0, 2); f.uncertain();
    expect(await finalizeStagedFullDataPreservation(f.finalInput())).toMatchObject({ completionOutcome: "reconciled", completed: true });
  }));
  it("rejects legacy completed=true without a staged receipt", async () => fixture(async f => {
    await f.verify(0, 2); f.operation.completed = true;
    await expect(finalizeStagedFullDataPreservation(f.finalInput())).rejects.toThrow(/completion/);
  }));
  it("rejects changed artifact bytes even when their digest is recomputed", async () => fixture(async f => {
    await f.verify(0, 2);
    const input = f.finalInput(), changed = JSON.parse(Buffer.from(input.proofs[0].bytes).toString());
    changed.observedAtMs++;
    const bytes = Buffer.from(canonical(changed));
    input.proofs[0] = { bytes, artifactSha256: digest(bytes) };
    await expect(finalizeStagedFullDataPreservation(input)).rejects.toThrow(/artifact_untrusted/);
    expect(f.operation.completed).toBe(false);
  }));
  it("fails closed when uncertain completion has no matching durable receipt", async () => fixture(async f => {
    await f.verify(0, 2); f.loseCommit();
    await expect(finalizeStagedFullDataPreservation(f.finalInput())).rejects.toThrow(/completion_unknown_unreconciled/);
    expect(f.operation.completed).toBe(false);
  }));
  it("rolls back completion when receipt insertion fails", async () => fixture(async f => {
    await f.verify(0, 2); f.failCompletion();
    await expect(finalizeStagedFullDataPreservation(f.finalInput())).rejects.toThrow(/injected/);
    expect(f.operation.completed).toBe(false); expect(f.completion()).toBeNull();
  }));
  it("rejects completion under another epoch rather than treating a boolean as proof", async () => fixture(async f => {
    await f.verify(0, 2);
    await finalizeStagedFullDataPreservation(f.finalInput());
    f.completion().freeze_epoch = "other";
    await expect(finalizeStagedFullDataPreservation(f.finalInput())).rejects.toThrow(/completion_binding/);
  }));
});
