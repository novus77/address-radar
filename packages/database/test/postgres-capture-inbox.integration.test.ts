import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createPostgresUnitOfWork, type PostgresPool } from "../src/postgres-unit-of-work.js";
import { createPostgresCaptureRepository, POSTGRES_CAPTURE_INBOX_SCHEMA_SQL, type PostgresCaptureEnvelope } from "../src/postgres-capture-inbox.js";

const testUrl = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
const base: PostgresCaptureEnvelope = { sourceNamespace: "fomo-live", sourceEventId: "event-1", collectorId: "server",
  sessionId: "session-1", receivedAt: 1_000, scrubbedPayload: '{"type":"buy"}', semanticPayload: '{"userId":"u1","amount":"50"}' };
interface TestPool extends PostgresPool { end(): Promise<void> }
async function fixture() {
  const url = new URL(testUrl!);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !decodeURIComponent(url.pathname.slice(1)).endsWith("_test")) throw new Error("Capture tests require a local _test database");
  const driver = createRequire(import.meta.url)("pg") as {
    Pool: new (config: { connectionString: string; max: number; connectionTimeoutMillis: number }) => TestPool;
  };
  const pool = new driver.Pool({ connectionString: testUrl!, max: 1, connectionTimeoutMillis: 2_000 });
  const work = createPostgresUnitOfWork(pool, { statementTimeoutMs: 2_000, lockTimeoutMs: 500 });
  try {
    await work.run(async tx => { await tx.query(POSTGRES_CAPTURE_INBOX_SCHEMA_SQL.replaceAll("CREATE TABLE ", "CREATE TEMP TABLE ")); });
  } catch (error) { await pool.end(); throw error; }
  const append = (input: PostgresCaptureEnvelope) => work.run(tx => createPostgresCaptureRepository(tx, { maximumPayloadBytes: 65_536 }).append(input));
  const counts = () => work.run(async tx => (await tx.query(`SELECT
    (SELECT count(*)::integer FROM capture_event_identities) AS identities,
    (SELECT count(*)::integer FROM capture_event_revisions) AS revisions,
    (SELECT count(*)::integer FROM capture_raw_payloads) AS payloads`)).rows[0]);
  return { pool, work, append, counts };
}

describe.skipIf(!testUrl)("PostgreSQL durable capture", () => {
  it("deduplicates reordered semantic fields across sessions and reception dates", async () => {
    const f = await fixture();
    try {
      expect((await f.append(base)).status).toBe("inserted");
      expect((await f.append({ ...base, sessionId: "session-2", receivedAt: 20 * 86_400_000,
        semanticPayload: '{"amount":"50","userId":"u1"}' })).status).toBe("duplicate");
      expect(await f.counts()).toEqual({ identities: 1, revisions: 1, payloads: 1 });
    } finally { await f.pool.end(); }
  });

  it("preserves a business revision without replacing the original fingerprint", async () => {
    const f = await fixture();
    try {
      const original = await f.append(base);
      const revised = await f.append({ ...base, semanticPayload: '{"userId":"u1","amount":"80"}' });
      expect(revised).toMatchObject({ status: "revision_pending", revisionNumber: 2 });
      expect((await f.append(base)).status).toBe("duplicate");
      const identity = await f.work.run(async tx => (await tx.query("SELECT original_fingerprint FROM capture_event_identities")).rows[0]);
      expect(identity?.original_fingerprint).toBe(original.semanticFingerprint);
      expect(await f.counts()).toEqual({ identities: 1, revisions: 2, payloads: 2 });
    } finally { await f.pool.end(); }
  });

  it("preserves opaque malformed business input without requiring an owner", async () => {
    const f = await fixture();
    try {
      expect(await f.append({ ...base, scrubbedPayload: "unparsed business message", semanticPayload: null }))
        .toMatchObject({ status: "inserted", fingerprintBasis: "opaque" });
      expect(await f.counts()).toEqual({ identities: 1, revisions: 1, payloads: 1 });
    } finally { await f.pool.end(); }
  });

  it("retains replay identity after a raw payload is removed in the test fixture", async () => {
    const f = await fixture();
    try {
      await f.append(base);
      await f.work.run(async tx => { await tx.query("DELETE FROM capture_raw_payloads"); });
      expect((await f.append({ ...base, receivedAt: 20 * 86_400_000 })).status).toBe("duplicate");
      expect(await f.counts()).toEqual({ identities: 1, revisions: 1, payloads: 0 });
    } finally { await f.pool.end(); }
  });

  it("rolls back identity, revision and payload together before acknowledgement", async () => {
    const f = await fixture();
    try {
      await expect(f.work.run(async tx => {
        await createPostgresCaptureRepository(tx, { maximumPayloadBytes: 65_536 }).append(base);
        throw new Error("before commit");
      })).rejects.toThrow("before commit");
      expect(await f.counts()).toEqual({ identities: 0, revisions: 0, payloads: 0 });
      expect((await f.append(base)).status).toBe("inserted");
    } finally { await f.pool.end(); }
  });

  it("does not collapse separate source events belonging to the same position", async () => {
    const f = await fixture();
    try {
      await f.append(base);
      await f.append({ ...base, sourceEventId: "event-2" });
      expect(await f.counts()).toEqual({ identities: 2, revisions: 2, payloads: 2 });
    } finally { await f.pool.end(); }
  });
});
