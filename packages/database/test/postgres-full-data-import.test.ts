import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { runFullDataPreservationValidationCli } from "../../../scripts/import-full-data-preservation.js";
import { createPostgresUnitOfWork, PostgresCommitUncertainError, type PostgresClient } from "../src/postgres-unit-of-work.js";
import { importStagedFullDataPreservationSegment } from "../src/postgres-staged-full-data-import.js";
import {
  createFullDataPreservationSchemaSql, fullDataPreservationSql, type FullDataPreservationUnitOfWork,
  importFullDataPreservationBundle, readFullDataPreservationBundle,
  verifyFullDataPreservationChunk, verifyFullDataPreservationManifest, verifyOpaqueFullDataPreservationChunk, preservationRowByteWindows,
  withFullDataPreservationSourceReader,
} from "../src/postgres-full-data-import.js";

const digest = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, field]) => JSON.stringify(key) + ":" + canonical(field)).join(",") + "}";
  return JSON.stringify(value);
}
const row = { values: [
  { storage: "integer", value: "9223372036854775807" },
  { storage: "real", value: "-0x0.0p+0" },
  { storage: "text", value: "AP8=", encoding: "base64" },
  { storage: "blob", value: "AP8=", encoding: "base64" },
  { storage: "null" },
] };
function fixture(empty = false) {
  const catalog = { objects: empty ? [] : [{ type: "table", name: "history", tbl_name: "history", sql: "CREATE TABLE history(a,b,c,d,e)" }],
    tables: empty ? [] : [{ name: "history", columns: ["a", "b", "c", "d", "e"].map((name, cid) => [cid, name, "", 0, null, 0, 0]), foreignKeys: [], indexes: [] }],
    sequences: [], pragmas: { encoding: "UTF-8", user_version: 0, application_id: 0 } };
  const chunk = { version: 1, operationId: "preserve-1", snapshotSha256: "a".repeat(64), table: "history", ordinal: 0, startRow: 0, rows: [row] };
  const bytes = Buffer.from(canonical(chunk));
  const manifest = { version: 1, operationId: chunk.operationId, snapshotSha256: chunk.snapshotSha256,
    snapshotBytes: 4096, limits: { maximumChunkBytes: 16384, rowsPerChunk: 64 }, businessActivation: false,
    catalogFingerprint: digest(canonical(catalog)), completed: true, catalog,
    tables: empty ? [] : [{ name: "history", completed: true, rowCount: 1, contentSha256: digest(canonical(row) + "\n"),
      chunks: [{ file: "table-0000-chunk-000000.json", table: "history", ordinal: 0, startRow: 0, rowCount: 1, sha256: digest(bytes) }] }] };
  return { manifest, chunk, bytes, manifestBytes: () => Buffer.from(canonical(manifest)) };
}
async function withBundle<T>(operation: (directory: string, source: ReturnType<typeof fixture>) => Promise<T>, empty = false) {
  const directory = await mkdtemp(join(tmpdir(), "radar-preservation-"));
  const source = fixture(empty);
  try {
    await writeFile(join(directory, "manifest.json"), source.manifestBytes());
    if (!empty) await writeFile(join(directory, source.manifest.tables[0]!.chunks[0]!.file), source.bytes);
    return await operation(directory, source);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const target = { schema: "isolated_preservation", database: "test_database", role: "test_role" };
const executionBudget = () => ({ deadlineAtMs: Date.now() + 30_000, maximumTransactionMs: 5000, maximumQueriesPerTransaction: 10_000, maximumTotalQueries: 100_000 });
describe("opaque bounded row verifier",()=>{
  it("matches lossless typed verifier while retaining original raw row views",()=>{
    const f=fixture(),m=verifyFullDataPreservationManifest(f.manifestBytes());
    const opaque=verifyOpaqueFullDataPreservationChunk(f.bytes,m,"history",0), typed=verifyFullDataPreservationChunk(f.bytes,m,"history",0);
    expect(opaque.rowBodies).toEqual(typed.rowBodies);expect(opaque.body).toBe(f.bytes);expect("rows" in opaque).toBe(false);
    expect(opaque.rowBodies[0]!.buffer).toBe(f.bytes.buffer);
  });
  it.each(["storage","header","duplicate","delimiter"])("rejects digest-repinned malformed %s",change=>{
    const f=fixture();let body=f.bytes.toString();
    if(change==="storage")body=body.replace('"storage":"integer"','"storage":["integer"]');
    if(change==="header")body=body.replace('"ordinal":0','"ordinal":1');
    if(change==="duplicate")body=body.replace('"values":[','"values":[],"values":[');
    if(change==="delimiter")body=body.replace('],"snapshotSha256"',',],"snapshotSha256"');
    const bytes=Buffer.from(body);f.manifest.tables[0]!.chunks[0]!.sha256=digest(bytes);
    expect(()=>verifyOpaqueFullDataPreservationChunk(bytes,verifyFullDataPreservationManifest(f.manifestBytes()),"history",0)).toThrow();
  });
  it("bounds statement windows without dropping oversized individual opaque rows",()=>{
    expect(preservationRowByteWindows([Buffer.alloc(2),Buffer.alloc(2),Buffer.alloc(8)],2,4)).toEqual([{start:0,end:2},{start:2,end:3}]);
    expect(()=>preservationRowByteWindows([],0,4)).toThrow();
  });
});
type RecordRow = Record<string, unknown>;
function database() {
  const calls: string[] = [];
  let state = { operations: [] as RecordRow[], tables: [] as RecordRow[], chunks: [] as RecordRow[], rows: [] as RecordRow[] };
  let rollbackState = state;
  let fail: string | null = null;
  let uncertainCommit = false;
  let beforeQuery: ((text: string) => Promise<void>) | undefined;
  const client: PostgresClient = {
    async query(text, values = []) {
      calls.push(text);
      if (beforeQuery) await beforeQuery(text);
      if (text === fail) { fail = null; throw new Error("injected SQL failure"); }
      if (text === "BEGIN") { rollbackState = state; state = Object.fromEntries(Object.entries(state).map(([key, rows]) => [key, rows.map(item => ({ ...item }))])) as typeof state; }
      if (text === "ROLLBACK") state = rollbackState;
      if (text === "COMMIT") {
        rollbackState = state;
        if (uncertainCommit && state.chunks.length > 0) { uncertainCommit = false; throw new Error("lost commit acknowledgement"); }
      }
      const is = (key: keyof typeof fullDataPreservationSql) => text.includes("/* preservation:" + String(key) + " */");
      const result = (rows: RecordRow[] = []) => ({ rows, rowCount: rows.length });
      if (is("targetIdentity")) return result([{ ...target }]);
      if (is("insertOperation")) {
        if (!state.operations.length) state.operations.push({ operation_id: values[0], snapshot_sha256: values[1], manifest_sha256: values[2],
          catalog_fingerprint: values[3], manifest_body: values[4], planned_tables: String(values[5]), planned_chunks: String(values[6]), planned_rows: String(values[7]), completed: false });
      }
      if (is("selectOperation")) return result(state.operations);
      if (is("insertTable")) {
        if (!state.tables.some(item => item.table_name === values[1])) state.tables.push({ operation_id: values[0], table_name: values[1], snapshot_sha256: values[2],
          manifest_sha256: values[3], row_count: String(values[4]), chunk_count: String(values[5]), content_sha256: values[6] });
      }
      if (is("selectTables")) return result(state.tables);
      if (is("selectChunk")) return result(state.chunks.filter(item => item.table_name === values[1] && Number(item.ordinal) === Number(values[2])).map(item=>({...item,chunk_bytes:String((item.chunk_body as Buffer).length),chunk_body:Number(values[3])<(item.chunk_body as Buffer).length?null:item.chunk_body})));
      if (is("selectChunkBodySlice")) return result(state.chunks.filter(item=>item.table_name===values[1]&&Number(item.ordinal)===Number(values[2])).map(item=>({body:(item.chunk_body as Buffer).subarray(Number(values[3])-1,Number(values[3])-1+Number(values[4]))})));
      if (is("selectChunks")) return result(state.chunks.filter(item => item.table_name === values[1]).sort((a,b)=>text.includes("ORDER BY preserved_chunks.ordinal")?Number(a.ordinal)-Number(b.ordinal):String(a.ordinal).localeCompare(String(b.ordinal))));
      if (is("insertRow")) state.rows.push({ operation_id: values[0], table_name: values[1], snapshot_sha256: values[2], manifest_sha256: values[3], row_ordinal: String(values[4]), row_body: values[5], chunk_ordinal: String(values[6]) });
      if (is("insertRows")) for (const [index, ordinal] of (values[4] as number[]).entries()) state.rows.push({ operation_id: values[0], table_name: values[1], snapshot_sha256: values[2], manifest_sha256: values[3], row_ordinal: String(ordinal), row_body: (values[5] as Buffer[])[index], chunk_ordinal: String(values[6]) });
      if (is("insertChunk")) state.chunks.push({ operation_id: values[0], table_name: values[1], snapshot_sha256: values[2], manifest_sha256: values[3],
        ordinal: String(values[4]), file: values[5], start_row: String(values[6]), row_count: String(values[7]), sha256: values[8], chunk_body: values[9] });
      if (is("selectRows")) return result(state.rows.filter(item => item.table_name === values[1] && Number(item.row_ordinal) >= Number(values[2]) && Number(item.row_ordinal) < Number(values[3]))
        .sort((a,b)=>text.includes("ORDER BY preserved_rows.row_ordinal")?Number(a.row_ordinal)-Number(b.row_ordinal):String(a.row_ordinal).localeCompare(String(b.row_ordinal))));
      if (is("countRows")) return result([{ row_count: String(state.rows.filter(item => item.table_name === values[1]).length) }]);
      if (is("verifyChunk")) {
        const chunk = state.chunks.find(item => item.table_name === values[1] && Number(item.ordinal) === Number(values[5]));
        if (!chunk) return result();
        Object.assign(chunk, { verified_manifest_sha256: values[2], verified_chunk_sha256: values[3], verified_row_count: String(values[4]) });
        return result([{ ordinal: chunk.ordinal }]);
      }
      if (is("verifyTable")) {
        const table = state.tables.find(item => item.table_name === values[1]);
        if (!table) return result();
        Object.assign(table, { verified_manifest_sha256: values[2], verified_row_count: String(values[3]), verified_chunk_count: String(values[4]) });
        return result([{ table_name: table.table_name }]);
      }
      if (is("countVerifiedChunks")) return result([{ chunk_count: String(state.chunks.length), row_count: String(state.chunks.reduce((total, chunk) => total + Number(chunk.row_count), 0)),
        all_verified: state.chunks.every(chunk => chunk.verified_manifest_sha256 === values[1] && chunk.verified_chunk_sha256 === chunk.sha256 && chunk.verified_row_count === chunk.row_count) }]);
      if (is("completeOperation")) { state.operations[0]!.completed = true; return result([{ operation_id: values[0] }]); }
      return result();
    },
    release() {},
  };
  const unitOfWork = createPostgresUnitOfWork({ async connect() { return client; } }, { statementTimeoutMs: 2_000, lockTimeoutMs: 500 });
  return { unitOfWork, calls, state: () => state, failOn: (key: keyof typeof fullDataPreservationSql) => { fail = fullDataPreservationSql[key].replaceAll("__SCHEMA__", '"isolated_preservation"'); },
    uncertain: () => { uncertainCommit = true; }, onQuery: (callback: (text: string) => Promise<void>) => { beforeQuery = callback; } };
}

describe("staged preservation segments", () => {
  async function threeChunks(directory: string, source: ReturnType<typeof fixture>) {
    const table = source.manifest.tables[0]!;
    table.rowCount = 3;
    table.contentSha256 = digest((canonical(row) + "\n").repeat(3));
    table.chunks = [];
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      const bytes = Buffer.from(canonical({ ...source.chunk, ordinal, startRow: ordinal }));
      const file = `table-0000-chunk-${String(ordinal).padStart(6, "0")}.json`;
      table.chunks.push({ file, table: table.name, ordinal, startRow: ordinal, rowCount: 1, sha256: digest(bytes) });
      await writeFile(join(directory, file), bytes);
    }
    await writeFile(join(directory, "manifest.json"), source.manifestBytes());
  }
  const segment = (directory: string, db: ReturnType<typeof database>, start = 0, end = 1) => ({
    bundleDirectory: directory, unitOfWork: db.unitOfWork, target, executionBudget: executionBudget(),
    sessionId: "staged-session", selection: { startChunkIndex: start, endChunkIndexExclusive: end }, closeReserveMs: 1000,
  });
  it("imports disjoint selections without rereading prior target bodies or completing", async () => withBundle(async (directory, source) => {
    await threeChunks(directory, source);
    const db = database();
    await importStagedFullDataPreservationSegment(segment(directory, db));
    db.state().rows[0]!.row_body = Buffer.from("tampered outside selection");
    const result = await importStagedFullDataPreservationSegment(segment(directory, db, 1, 3));
    expect(result).toMatchObject({ status: "segment_imported", committedChunks: 2, resumedChunks: 0,
      nextChunkIndex: 3, completed: false, parityComplete: false, grantsBusinessEligibility: false });
    expect(db.state().operations[0]!.completed).toBe(false);
    expect(db.calls.some(sql => sql.includes("preservation:completeOperation") || sql.includes("preservation:verifyTable"))).toBe(false);
    await expect(importStagedFullDataPreservationSegment(segment(directory, db))).rejects.toThrow("durable_row_body_mismatch");
  }));
  it.each([false, true])("reconciles selected receipt bytes and rows, opaque=%s", async opaque => withBundle(async directory => {
    const db = database(), input = segment(directory, db);
    if (opaque) Object.assign(input.executionBudget, { opaqueRowWindows: { maximumRows: 1, maximumBytes: 64 } });
    await importStagedFullDataPreservationSegment(input);
    expect((await importStagedFullDataPreservationSegment(input)).resumedChunks).toBe(1);
    const original = db.state().chunks[0]!.chunk_body;
    db.state().chunks[0]!.chunk_body = Buffer.from("tampered");
    await expect(importStagedFullDataPreservationSegment(input)).rejects.toThrow("body_mismatch");
    db.state().chunks[0]!.chunk_body = original;
    db.state().rows.length = 0;
    await expect(importStagedFullDataPreservationSegment(input)).rejects.toThrow("row_accounting_mismatch");
  }));
  it("propagates unknown COMMIT and reconciles the selected durable receipt on retry", async () => withBundle(async directory => {
    const db = database(); db.uncertain();
    await expect(importStagedFullDataPreservationSegment(segment(directory, db))).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    const result = await importStagedFullDataPreservationSegment(segment(directory, db));
    expect(result).toMatchObject({ committedChunks: 0, resumedChunks: 1, completed: false });
    expect(db.state().rows).toHaveLength(1);
  }));
  it("validates all source chunks even outside the selected interval before SQL", async () => withBundle(async (directory, source) => {
    await threeChunks(directory, source);
    await writeFile(join(directory, source.manifest.tables[0]!.chunks[0]!.file), "{}");
    const db = database();
    await expect(importStagedFullDataPreservationSegment(segment(directory, db, 2, 3))).rejects.toThrow("digest");
    expect(db.calls).toHaveLength(0);
  }));
  it("yields before opening a transaction when transaction and close reserve do not fit", async () => withBundle(async directory => {
    const db = database(), input = segment(directory, db);
    input.executionBudget.deadlineAtMs = Date.now() + 4000;
    expect(await importStagedFullDataPreservationSegment(input)).toMatchObject({ status: "yielded_before_transaction", nextChunkIndex: 0, committedChunks: 0 });
    expect(db.calls).toHaveLength(0);
  }));
  it("rolls back a failed selected chunk without returning acknowledged progress", async () => withBundle(async directory => {
    const db = database(); db.failOn("insertChunk");
    await expect(importStagedFullDataPreservationSegment(segment(directory, db))).rejects.toThrow("injected");
    expect(db.state().rows).toHaveLength(0);
    expect(db.state().chunks).toHaveLength(0);
  }));
  it("rejects transaction admission if chunk reading consumes the close reserve", async () => withBundle(async directory => {
    const db = database(), input = segment(directory, db);
    let now = Date.now(), chunkReads = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(withFullDataPreservationSourceReader({ async read(root, file) {
        const bytes = await readFile(join(root, file));
        if (file.includes("chunk") && ++chunkReads === 2) now = input.executionBudget.deadlineAtMs - 500;
        return bytes;
      } }, () => importStagedFullDataPreservationSegment(input))).rejects.toThrow("transaction_admission_budget");
      expect(db.state().chunks).toHaveLength(0);
      expect(db.calls.filter(sql => sql === "BEGIN")).toHaveLength(1);
    } finally { spy.mockRestore(); }
  }));
  it("yields between acknowledged chunks without revisiting earlier target bodies", async () => withBundle(async (directory, source) => {
    await threeChunks(directory, source);
    const db = database(), input = segment(directory, db, 0, 3);
    let now = Date.now(), commits = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    db.onQuery(async text => { if (text === "COMMIT" && ++commits === 2) now = input.executionBudget.deadlineAtMs - 5500; });
    try {
      expect(await importStagedFullDataPreservationSegment(input)).toMatchObject({
        status: "yielded_before_transaction", committedChunks: 1, nextChunkIndex: 1, completed: false,
      });
      expect(db.state().chunks).toHaveLength(1);
    } finally { spy.mockRestore(); }
  }));
  it.each([-1, 0, 2])("rejects invalid selection end %s before SQL", async end => withBundle(async directory => {
    const db = database();
    await expect(importStagedFullDataPreservationSegment(segment(directory, db, 0, end))).rejects.toThrow("selection");
    expect(db.calls).toHaveLength(0);
  }));
});

describe("atomic opaque-window import and reconciliation",()=>{
  it("commits each original receipt atomically and resumes through bounded byte slices",async()=>withBundle(async directory=>{
    const db=database(), budget={...executionBudget(),opaqueRowWindows:{maximumRows:1,maximumBytes:64}};
    const first=await importFullDataPreservationBundle({bundleDirectory:directory,unitOfWork:db.unitOfWork,target,executionBudget:budget});
    expect(first.committedChunks).toBe(1);
    const resumed=await importFullDataPreservationBundle({bundleDirectory:directory,unitOfWork:db.unitOfWork,target,executionBudget:budget});
    expect(resumed.resumedChunks).toBe(1);expect(db.calls.some(sql=>sql.includes("preservation:selectChunkBodySlice"))).toBe(true);
    expect(db.state().rows).toHaveLength(1);
    db.state().chunks[0]!.chunk_body=Buffer.from("tampered");
    await expect(importFullDataPreservationBundle({bundleDirectory:directory,unitOfWork:db.unitOfWork,target,executionBudget:budget})).rejects.toThrow("body_mismatch");
  }));
  it("rolls back all windowed rows when original receipt insert fails",async()=>withBundle(async directory=>{
    const db=database();db.failOn("insertChunk");
    await expect(importFullDataPreservationBundle({bundleDirectory:directory,unitOfWork:db.unitOfWork,target,executionBudget:{...executionBudget(),opaqueRowWindows:{maximumRows:1,maximumBytes:64}}})).rejects.toThrow("injected");
    expect(db.state().rows).toHaveLength(0);expect(db.state().chunks).toHaveLength(0);
  }));
  it("uses multiple parameterized pages but exactly one chunk receipt commit",async()=>withBundle(async(directory,source)=>{
    const rows=Array.from({length:17},()=>row),bytes=Buffer.from(canonical({...source.chunk,rows}));
    source.manifest.tables[0]!.rowCount=17;source.manifest.tables[0]!.chunks[0]!.rowCount=17;source.manifest.tables[0]!.chunks[0]!.sha256=digest(bytes);
    source.manifest.tables[0]!.contentSha256=digest(rows.map(r=>canonical(r)+"\n").join(""));
    await writeFile(join(directory,"manifest.json"),source.manifestBytes());await writeFile(join(directory,source.manifest.tables[0]!.chunks[0]!.file),bytes);
    const db=database(),budget={...executionBudget(),opaqueRowWindows:{maximumRows:12,maximumBytes:16384}};
    await importFullDataPreservationBundle({bundleDirectory:directory,unitOfWork:db.unitOfWork,target,executionBudget:budget});
    expect(db.calls.filter(sql=>sql.includes("preservation:insertRows"))).toHaveLength(2);
    expect(db.calls.filter(sql=>sql.includes("preservation:insertChunk"))).toHaveLength(1);expect(db.calls.filter(sql=>sql==="COMMIT")).toHaveLength(4);
    expect(db.state().rows).toHaveLength(17);
  }));
  it("orders twelve native chunk proofs numerically rather than by text output aliases",async()=>withBundle(async(directory,source)=>{
    const plans=[];
    for(let ordinal=0;ordinal<12;ordinal++){
      const file="table-0000-chunk-"+String(ordinal).padStart(6,"0")+".json",bytes=Buffer.from(canonical({...source.chunk,ordinal,startRow:ordinal}));
      await writeFile(join(directory,file),bytes);plans.push({file,table:"history",ordinal,startRow:ordinal,rowCount:1,sha256:digest(bytes)});
    }
    source.manifest.tables[0]!.rowCount=12;source.manifest.tables[0]!.chunks=plans;source.manifest.tables[0]!.contentSha256=digest((canonical(row)+"\n").repeat(12));
    await writeFile(join(directory,"manifest.json"),source.manifestBytes());const db=database();
    const result=await importFullDataPreservationBundle({bundleDirectory:directory,unitOfWork:db.unitOfWork,target,executionBudget:{...executionBudget(),opaqueRowWindows:{maximumRows:64,maximumBytes:512*1024}}});
    expect(result.completed).toBe(true);expect(result.totalChunks).toBe(12);
  }));
});
describe("full historical preservation verification", () => {
  it("preserves raw lossless storage representations and exact bytes", async () => withBundle(async (directory, source) => {
    const bundle = await readFullDataPreservationBundle(directory);
    expect(bundle.totalRows).toBe(1);
    expect(bundle.grantsBusinessEligibility).toBe(false);
    const chunk = verifyFullDataPreservationChunk(source.bytes, bundle.manifest, "history", 0);
    expect(chunk.rowBodies[0]).toEqual(Buffer.from(canonical(row)));
    expect(chunk.rows[0]).toEqual(row);
    expect(await readFile(join(directory, "manifest.json"))).toEqual(source.manifestBytes());
  }));

  it("handles a zero-table snapshot without inventing rows or chunks", async () => withBundle(async directory => {
    const bundle = await readFullDataPreservationBundle(directory);
    expect([bundle.totalRows, bundle.totalChunks, bundle.manifest.value.tables.length]).toEqual([0, 0, 0]);
  }, true));

  it("accounts for an empty table using the empty content digest and no chunks", async () => withBundle(async (directory, source) => {
    const table = source.manifest.tables[0]!;
    table.rowCount = 0; table.chunks = []; table.contentSha256 = digest("");
    await writeFile(join(directory, "manifest.json"), source.manifestBytes());
    const bundle = await readFullDataPreservationBundle(directory);
    expect([bundle.totalRows, bundle.totalChunks]).toEqual([0, 0]);
  }));

  it("enforces a total byte bound even for a zero-table bundle", async () => withBundle(async directory => {
    await expect(readFullDataPreservationBundle(directory, { maxTotalBytes: 1 })).rejects.toThrow("limit");
  }, true));

  it("requires every table to be completed and every row to match catalog width", () => {
    const source = fixture(); source.manifest.tables[0]!.completed = false;
    expect(() => verifyFullDataPreservationManifest(source.manifestBytes())).toThrow("incomplete");
    source.manifest.tables[0]!.completed = true;
    const bytes = Buffer.from(canonical({ ...source.chunk, rows: [{ values: row.values.slice(1) }] }));
    source.manifest.tables[0]!.chunks[0]!.sha256 = digest(bytes);
    expect(() => verifyFullDataPreservationChunk(bytes, verifyFullDataPreservationManifest(source.manifestBytes()), "history", 0)).toThrow("width");
  });

  it("preserves a real Python export with UTF16 bytes, generated columns, indexes and multiple chunks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "radar-preservation-exporter-"));
    try {
      const sourcePath = join(directory, "snapshot.sqlite"); const bundlePath = join(directory, "bundle");
      execFileSync("python3", ["-c", [
        "import sqlite3,sys",
        "c=sqlite3.connect(sys.argv[1])",
        "c.execute(\"PRAGMA encoding='UTF-16le'\")",
        "c.execute('CREATE TABLE history(id INTEGER PRIMARY KEY AUTOINCREMENT, value REAL, note TEXT, raw BLOB, doubled INTEGER GENERATED ALWAYS AS (id*2) STORED, FOREIGN KEY(id) REFERENCES history(id) ON DELETE RESTRICT)')",
        "c.execute('CREATE INDEX history_partial ON history(note COLLATE NOCASE) WHERE id > 0')",
        "c.execute(\"INSERT INTO history(id,value,note,raw) VALUES(1,?,CAST(X'00d8' AS TEXT),X'00ff')\", (float('inf'),))",
        "c.execute('INSERT INTO history(id,value,note,raw) VALUES(2,?,?,?)', (float('-inf'),'\\u4e2d\\u6587',bytes([255])))",
        "c.commit();c.close()",
      ].join("\n"), sourcePath], { timeout: 10_000 });
      const sourceBefore = await readFile(sourcePath);
      const exporter = fileURLToPath(new URL("../../../scripts/consistent-sqlite-migration.py", import.meta.url));
      execFileSync("python3", [exporter, "export", "--source", sourcePath, "--target", bundlePath,
        "--operation-id", "python-export-test", "--source-sha256", digest(sourceBefore), "--deadline-seconds", "30",
        "--minimum-free-bytes", "0", "--maximum-chunk-bytes", "16384", "--rows-per-chunk", "1"], { timeout: 35_000 });
      const bundle = await readFullDataPreservationBundle(bundlePath);
      expect(bundle.manifest.value.catalog.pragmas.encoding).toBe("UTF-16le");
      expect(bundle.manifest.value.catalog.sequences).toEqual([{ name: "history", seq: "2" }]);
      expect(bundle.manifest.value.catalog.tables[0]!.foreignKeys).toEqual([{ id: 0, table: "history", onUpdate: "NO ACTION", onDelete: "RESTRICT", match: "NONE", columns: [{ sequence: 0, from: "id", to: "id" }] }]);
      expect([bundle.totalRows, bundle.totalChunks]).toEqual([2, 2]);
      const table = bundle.manifest.value.tables[0]!;
      const first = verifyFullDataPreservationChunk(await readFile(join(bundlePath, table.chunks[0]!.file)), bundle.manifest, table.name, 0);
      expect(first.rows[0]!.values[1]).toEqual({ storage: "real", value: "inf" });
      expect(first.rows[0]!.values[2]).toEqual({ storage: "text", encoding: "base64", value: "ANg=" });
      expect(first.rows[0]!.values[4]).toEqual({ storage: "integer", value: "2" });
      const second = verifyFullDataPreservationChunk(await readFile(join(bundlePath, table.chunks[1]!.file)), bundle.manifest, table.name, 1);
      expect(second.rows[0]!.values[1]).toEqual({ storage: "real", value: "-inf" });
      expect(second.rows[0]!.values[2]).toEqual({ storage: "text", encoding: "base64", value: Buffer.from("\u4e2d\u6587", "utf16le").toString("base64") });
      const db = database();
      const imported = await importFullDataPreservationBundle({ bundleDirectory: bundlePath, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target });
      expect(imported.committedChunks).toBe(2);
      expect(db.state().rows.map(item => item.row_ordinal)).toEqual(["0", "1"]);
      expect(await readFile(sourcePath)).toEqual(sourceBefore);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ["incomplete", (f: ReturnType<typeof fixture>) => { f.manifest.completed = false; }],
    ["duplicate table", (f: ReturnType<typeof fixture>) => { f.manifest.tables.push(f.manifest.tables[0]!); }],
    ["path traversal", (f: ReturnType<typeof fixture>) => { f.manifest.tables[0]!.chunks[0]!.file = "../chunk.json"; }],
    ["duplicate path", (f: ReturnType<typeof fixture>) => { f.manifest.tables[0]!.chunks.push({ ...f.manifest.tables[0]!.chunks[0]!, ordinal: 1, startRow: 1 }); f.manifest.tables[0]!.rowCount = 2; }],
    ["ordinal gap", (f: ReturnType<typeof fixture>) => { f.manifest.tables[0]!.chunks[0]!.ordinal = 1; }],
    ["row gap", (f: ReturnType<typeof fixture>) => { f.manifest.tables[0]!.chunks[0]!.startRow = 1; }],
    ["count mismatch", (f: ReturnType<typeof fixture>) => { f.manifest.tables[0]!.rowCount = 2; }],
    ["unsafe count", (f: ReturnType<typeof fixture>) => { f.manifest.tables[0]!.rowCount = Number.MAX_SAFE_INTEGER + 1; }],
    ["missing table", (f: ReturnType<typeof fixture>) => { f.manifest.tables = []; }],
    ["invalid digest", (f: ReturnType<typeof fixture>) => { f.manifest.snapshotSha256 = "z".repeat(64); }],
  ])("rejects %s", (_name, mutate) => {
    const source = fixture(); mutate(source);
    expect(() => verifyFullDataPreservationManifest(source.manifestBytes())).toThrow();
  });

  it("rejects duplicate JSON keys, malformed UTF8 and oversized manifests", () => {
    const source = fixture();
    expect(() => verifyFullDataPreservationManifest(Buffer.from(source.manifestBytes().toString().replace('"version":1', '"version":1,"version":1')))).toThrow("duplicate");
    expect(() => verifyFullDataPreservationManifest(Buffer.from([0xff]))).toThrow();
    expect(() => verifyFullDataPreservationManifest(source.manifestBytes(), { maxManifestBytes: 1 })).toThrow("limit");
  });

  it("checks catalog fingerprint independently", () => {
    const source = fixture(); source.manifest.catalog.pragmas.user_version = 1;
    expect(() => verifyFullDataPreservationManifest(source.manifestBytes())).toThrow("catalog");
  });

  it.each(["object type", "index origin", "database encoding"])("rejects an array-valued %s with a recomputed catalog fingerprint", discriminator => {
    const source = fixture();
    const manifest = JSON.parse(source.manifestBytes().toString()) as { catalog: {
      objects: Record<string, unknown>[]; tables: { indexes: Record<string, unknown>[] }[];
      pragmas: Record<string, unknown>;
    }; catalogFingerprint: string };
    if (discriminator === "object type") manifest.catalog.objects.push({ type: ["view"], name: "malformed", tbl_name: "malformed", sql: "CREATE VIEW malformed AS SELECT 1" });
    if (discriminator === "index origin") manifest.catalog.tables[0]!.indexes.push({ name: "malformed", unique: false, origin: ["c"], partial: false, sql: null, columns: [] });
    if (discriminator === "database encoding") manifest.catalog.pragmas.encoding = ["UTF-8"];
    manifest.catalogFingerprint = digest(canonical(manifest.catalog));
    expect(() => verifyFullDataPreservationManifest(Buffer.from(canonical(manifest)))).toThrow(/invalid_catalog_object_type|invalid_index_flags|invalid_database_encoding/);
  });

  it("rejects an array-valued storage class with recomputed chunk and content digests", () => {
    const source = fixture();
    const changedRow = { values: [{ storage: ["blob"], value: "AP8=" }, ...row.values.slice(1)] };
    const bytes = Buffer.from(canonical({ ...source.chunk, rows: [changedRow] }));
    source.manifest.tables[0]!.chunks[0]!.sha256 = digest(bytes);
    source.manifest.tables[0]!.contentSha256 = digest(canonical(changedRow) + "\n");
    expect(() => verifyFullDataPreservationChunk(bytes, verifyFullDataPreservationManifest(source.manifestBytes()), "history", 0)).toThrow("invalid_storage_class");
  });

  it.each(["operationId", "snapshotSha256", "table", "ordinal", "startRow"])("rejects changed chunk %s even with a matching byte digest", field => {
    const source = fixture(); const changed = { ...source.chunk, [field]: typeof source.chunk[field as keyof typeof source.chunk] === "number" ? 3 : "changed" };
    const bytes = Buffer.from(canonical(changed)); source.manifest.tables[0]!.chunks[0]!.sha256 = digest(bytes);
    expect(() => verifyFullDataPreservationChunk(bytes, verifyFullDataPreservationManifest(source.manifestBytes()), "history", 0)).toThrow();
  });

  it.each([
    { storage: "integer", value: "9223372036854775808" }, { storage: "integer", value: "1.5" },
    { storage: "real", value: "1.2" }, { storage: "blob", value: "%%%", encoding: "base64" },
    { storage: "text", value: "YQ", encoding: "base64" }, { storage: "null", value: "discarded" },
  ])("rejects invalid storage cell %j", cell => {
    const source = fixture(); const changed = { ...source.chunk, rows: [{ values: [cell, ...row.values.slice(1)] }] };
    const bytes = Buffer.from(canonical(changed)); source.manifest.tables[0]!.chunks[0]!.sha256 = digest(bytes);
    expect(() => verifyFullDataPreservationChunk(bytes, verifyFullDataPreservationManifest(source.manifestBytes()), "history", 0)).toThrow();
  });

  it("rejects filesystem tampering before any PG connection", async () => withBundle(async (directory, source) => {
    await writeFile(join(directory, source.manifest.tables[0]!.chunks[0]!.file), Buffer.concat([source.bytes, Buffer.from(" ")]));
    const db = database();
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target })).rejects.toThrow("digest");
    expect(db.calls).toEqual([]);
  }));

  it("rejects missing chunks and symbolic links", async () => withBundle(async (directory, source) => {
    const file = join(directory, source.manifest.tables[0]!.chunks[0]!.file);
    await rm(file); await expect(readFullDataPreservationBundle(directory)).rejects.toThrow();
    await writeFile(join(directory, "other.json"), source.bytes);
    await symlink(join(directory, "other.json"), file);
    await expect(readFullDataPreservationBundle(directory)).rejects.toThrow();
  }));

  it("rejects a changed table content digest after chunk bytes verify", async () => withBundle(async (directory, source) => {
    source.manifest.tables[0]!.contentSha256 = "b".repeat(64);
    await writeFile(join(directory, "manifest.json"), source.manifestBytes());
    await expect(readFullDataPreservationBundle(directory)).rejects.toThrow("content");
  }));
});

describe("resumable PostgreSQL preservation", () => {
  it("commits chunk rows and receipts atomically, then resumes without duplicate rows", async () => withBundle(async directory => {
    const db = database();
    const first = await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target });
    expect(first.committedChunks).toBe(1);
    expect(first.grantsBusinessEligibility).toBe(false);
    expect(db.state().rows).toHaveLength(1);
    expect(db.state().operations[0]!.completed).toBe(true);
    expect(db.calls.filter(text => text === "COMMIT")).toHaveLength(4);
    const second = await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target });
    expect(second.resumedChunks).toBe(1);
    expect(db.state().rows).toHaveLength(1);
    expect(db.calls.some(text => text.includes("pg_advisory_xact_lock"))).toBe(true);
  }));

  it("rolls back rows when receipt insertion fails and retries cleanly", async () => withBundle(async directory => {
    const db = database(); db.failOn("insertChunk");
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target })).rejects.toThrow("injected");
    expect(db.state().rows).toHaveLength(0); expect(db.state().chunks).toHaveLength(0);
    expect(db.calls.at(-1)).toBe("ROLLBACK");
    await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target });
    expect(db.state().rows).toHaveLength(1);
  }));

  it("propagates an uncertain commit and reconciles the durable receipt on retry", async () => withBundle(async directory => {
    const db = database(); db.uncertain();
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target })).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    const result = await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target });
    expect(result.resumedChunks).toBe(1); expect(db.state().rows).toHaveLength(1);
  }));

  it("rejects changed manifest lineage on retry", async () => withBundle(async (directory, source) => {
    const db = database(); await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target });
    await writeFile(join(directory, "manifest.json"), Buffer.concat([source.manifestBytes(), Buffer.from("\n")]));
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target })).rejects.toThrow("lineage");
  }));

  it("rejects changed chunk receipts and missing durable rows", async () => withBundle(async directory => {
    const db = database(); await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target });
    const receipt = db.state().chunks[0]!; const original = receipt.sha256; receipt.sha256 = "f".repeat(64);
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target })).rejects.toThrow("receipt");
    db.state().chunks[0]!.sha256 = original; db.state().rows.length = 0;
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target })).rejects.toThrow("row");
  }));

  it("revalidates chunk files after preparation commits", async () => withBundle(async (directory, source) => {
    const db = database(); let commits = 0;
    db.onQuery(async text => { if (text === "COMMIT" && ++commits === 1) await writeFile(join(directory, source.manifest.tables[0]!.chunks[0]!.file), "{}"); });
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target })).rejects.toThrow("digest");
    expect(db.state().rows).toHaveLength(0);
  }));

  it("checks the target identity before any ledger mutation", async () => withBundle(async directory => {
    const db = database();
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target: { ...target, database: "wrong" } })).rejects.toThrow("target");
    expect(db.state().operations).toHaveLength(0);
  }));

  it.each(["extra chunk", "missing chunk", "changed row body", "extra table"])("does not complete after final validation detects %s", async corruption => withBundle(async directory => {
    const db = database(); let corrupted = false;
    db.onQuery(async text => {
      if (!corrupted && corruption === "changed row body" && text.includes("/* preservation:selectRows */") && db.state().chunks.length > 0) {
        corrupted = true; db.state().rows[0]!.row_body = Buffer.from("tampered");
      }
      if (!corrupted && corruption !== "extra table" && corruption !== "changed row body" && text.includes("/* preservation:selectChunks */")) {
        corrupted = true;
        if (corruption === "extra chunk") db.state().chunks.push({ ...db.state().chunks[0]!, ordinal: "1" });
        if (corruption === "missing chunk") db.state().chunks.length = 0;
      }
      if (!corrupted && corruption === "extra table" && text.includes("/* preservation:selectTables */") && db.state().chunks.length > 0) {
        corrupted = true; db.state().tables.push({ ...db.state().tables[0]!, table_name: "unplanned" });
      }
    });
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target })).rejects.toThrow();
    expect(db.state().operations[0]!.completed).toBe(false);
    expect(db.calls.some(text => text.includes("/* preservation:completeOperation */"))).toBe(false);
  }));

  it("completes a zero-table operation only after final accounting", async () => withBundle(async directory => {
    const db = database(); const result = await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, executionBudget: executionBudget(), target });
    expect([result.totalRows, result.committedChunks, result.resumedChunks]).toEqual([0, 0, 0]);
    expect(db.state().operations[0]!.completed).toBe(true);
    expect(db.calls.filter(text => text === "COMMIT")).toHaveLength(2);
  }, true));

  it("exports explicit schema SQL without applying it or interpolating source identifiers", () => {
    const ddl = createFullDataPreservationSchemaSql("isolated_preservation").join("\n");
    expect(ddl).toContain("BYTEA"); expect(ddl).toContain("FOREIGN KEY");
    expect(ddl).not.toContain("CREATE SCHEMA");
    expect(() => createFullDataPreservationSchemaSql('public"; DROP TABLE x;')).toThrow();
    expect(() => createFullDataPreservationSchemaSql("public")).toThrow();
  });

  it("rejects an expired deadline before connecting", async () => withBundle(async directory => {
    const db = database();
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, target,
      executionBudget: { ...executionBudget(), deadlineAtMs: Date.now() - 1 } })).rejects.toThrow("execution_deadline");
    expect(db.calls).toEqual([]);
  }));

  it("rolls back an exhausted SQL budget and resumes from durable chunk proof", async () => withBundle(async directory => {
    const db = database();
    db.failOn("verifyTable");
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, target, executionBudget: executionBudget() })).rejects.toThrow("injected");
    expect(db.state().chunks[0]!.verified_manifest_sha256).toBe(db.state().operations[0]!.manifest_sha256);
    expect(db.state().operations[0]!.completed).toBe(false);
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, target,
      executionBudget: { ...executionBudget(), maximumQueriesPerTransaction: 1 } })).rejects.toThrow("query_budget");
    const resumed = await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, target, executionBudget: executionBudget() });
    expect(resumed.resumedChunks).toBe(1);
    const lastBegin = db.calls.lastIndexOf("BEGIN");
    expect(db.calls.slice(lastBegin).some(text => text.includes("preservation:selectRows") || text.includes("preservation:selectChunks"))).toBe(false);
  }));

  it("aborts a transaction that exceeds its wall-clock bound", async () => withBundle(async directory => {
    const db = database();
    db.onQuery(async text => { if (text.includes("preservation:targetIdentity")) await new Promise(resolve => setTimeout(resolve, 15)); });
    await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork: db.unitOfWork, target,
      executionBudget: { ...executionBudget(), maximumTransactionMs: 5 } })).rejects.toThrow("transaction_deadline");
    expect(db.state().operations).toHaveLength(0);
    expect(db.calls.at(-1)).toBe("ROLLBACK");
  }));
});

const acceptanceUrl = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
describe.skipIf(!acceptanceUrl)("real PG SQL/constraints in TEMP tables with savepoint UOW adapter and outer rollback; not durable commit integration", () => {
  it("executes ledger SQL, deferred FKs, rollback and receipt replay without permanent objects", async () => withBundle(async directory => {
    const url = new URL(acceptanceUrl!);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.port !== "5433" || url.pathname !== "/address_radar_acceptance_test" || url.search !== "" || url.hash !== "" || decodeURIComponent(url.username) !== "address_radar_acceptance") {
      throw new Error("Only the existing local 5433 acceptance database/role is allowed");
    }
    const { Client } = createRequire(import.meta.url)("pg") as typeof import("pg");
    const client = new Client({ connectionString: acceptanceUrl!, connectionTimeoutMillis: 2000, options: "-c statement_timeout=5000 -c lock_timeout=1000" });
    await client.connect();
    let savepoint = 0; let injectReceiptFailure = true;
    const unitOfWork: FullDataPreservationUnitOfWork = { async run(operation) {
      const point = "preservation_uow_" + ++savepoint;
      await client.query("SAVEPOINT " + point);
      try {
        const value = await operation({ async query(text, values = []) {
          if (injectReceiptFailure && text.includes("preservation:insertChunk")) { injectReceiptFailure = false; throw new Error("receipt rollback probe"); }
          if (text.includes("preservation:targetIdentity")) {
            const result = await client.query(text.replace("n.nspname = $1", "n.oid = pg_my_temp_schema()"));
            expect(result.rows[0]?.database).toBe("address_radar_acceptance_test");
            expect(result.rows[0]?.role).toBe("address_radar_acceptance");
            return { rows: result.rows.map(item => ({ ...item, schema: target.schema })), rowCount: result.rowCount };
          }
          const result = await client.query(text.replaceAll('"isolated_preservation".', '"pg_temp".'), [...values]);
          return { rows: result.rows, rowCount: result.rowCount };
        } });
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query("RELEASE SAVEPOINT " + point);
        return value;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT " + point);
        await client.query("RELEASE SAVEPOINT " + point);
        throw error;
      }
    } };
    const tempTarget = { ...target, database: "address_radar_acceptance_test", role: "address_radar_acceptance" };
    try {
      await client.query("BEGIN");
      for (const ddl of createFullDataPreservationSchemaSql(target.schema)) await client.query(ddl
        .replace('CREATE TABLE "isolated_preservation".', "CREATE TEMP TABLE ")
        .replaceAll('"isolated_preservation".', '"pg_temp".') + " ON COMMIT DROP");
      await expect(importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork, target: tempTarget, executionBudget: executionBudget() })).rejects.toThrow("receipt rollback probe");
      expect((await client.query("SELECT count(*)::integer AS count FROM pg_temp.full_data_preservation_rows")).rows[0]?.count).toBe(0);
      const first = await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork, target: tempTarget, executionBudget: executionBudget() });
      const replay = await importFullDataPreservationBundle({ bundleDirectory: directory, unitOfWork, target: tempTarget, executionBudget: executionBudget() });
      expect([first.committedChunks, replay.resumedChunks]).toEqual([1, 1]);
      await client.query("SAVEPOINT orphan_probe");
      const operation = (await client.query("SELECT * FROM pg_temp.full_data_preservation_operations")).rows[0]!;
      await client.query(fullDataPreservationSql.insertRow.replaceAll("__SCHEMA__", '"pg_temp"'),
        [operation.operation_id, "history", operation.snapshot_sha256, operation.manifest_sha256, 999, Buffer.from("{}"), 99]);
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK TO SAVEPOINT orphan_probe");
    } finally {
      try {
        await client.query("ROLLBACK");
        expect((await client.query("SELECT to_regclass('pg_temp.full_data_preservation_operations') AS relation")).rows[0]?.relation).toBeNull();
      } finally { await client.end(); }
    }
  }), 15_000);
});

describe("validation-only preservation CLI", () => {
  it("defaults to a dry run and reports that no activation or database writes occurred", async () => withBundle(async directory => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runFullDataPreservationValidationCli(["--bundle", directory]);
      const report = JSON.parse(String(output.mock.calls[0]![0]));
      expect(report).toMatchObject({ mode: "dry-run", preservationVerified: true, databaseWrites: false, sourceWrites: false,
        businessActivation: false, grantsBusinessEligibility: false, productionMigrationReady: false });
    } finally { output.mockRestore(); }
  }));

  it.each([
    { args: ["--apply"], message: "Apply is unavailable" },
    { args: ["--bundle"], message: "requires a directory" },
    { args: ["--target", "production"], message: "Unknown or duplicate" },
    { args: ["--bundle", "x", "--bundle", "y"], message: "Unknown or duplicate" },
  ])("refuses unsafe or ambiguous arguments $args", async ({ args, message }) => {
    await expect(runFullDataPreservationValidationCli(args)).rejects.toThrow(message);
  });
});
