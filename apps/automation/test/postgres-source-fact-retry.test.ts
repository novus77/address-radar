import { expect, test, vi } from "vitest";
import { createPostgresSourceFactRetry } from "../src/postgres-source-fact-retry.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";

const fp = "a".repeat(64), signal = new AbortController().signal;
function fixture() {
  let now = 100_000;
  const rows = Array.from({ length: 5 }, (_, i) => ({ sample_id: `sample-${i}`, generation_id: "generation",
    execution_fingerprint: fp, original_fingerprint: fp, revision_state: "original", activated_at: 1000,
    chain: "solana", token_address: "TokenCase", entity_id: "entity", occurred_at: 90_000,
    created_at: 95_000 + i, recorded_at: 95_000 + i, source_recorded: false }));
  const query = vi.fn(async (_sql: string, args: readonly unknown[] = []) => {
    const after = args[3] === null ? null : { createdAt: Number(args[3]), sampleId: String(args[4]) };
    const page = rows.filter(row => !after || row.created_at > after.createdAt
      || row.created_at === after.createdAt && row.sample_id > after.sampleId).slice(0, Number(args[5]));
    return { rows: structuredClone(page), rowCount: page.length };
  });
  const load = vi.fn(async (request: any): Promise<any> => ({ status: "ready", request: {
    sampleId: request.sampleId, executionFingerprint: request.executionFingerprint, signal: request.signal,
    execution: { generationId: "generation", knownAt: 99_000 }, validation: { claims: { expiresAt: 160_000 } },
  } }));
  const receive = vi.fn(async (request: any): Promise<any> => {
    rows.find(row => row.sample_id === request.sampleId)!.source_recorded = true;
    return { status: "published", factId: `source:${request.sampleId}` };
  });
  const run = <T>(operation: (tx: PostgresTransaction) => Promise<T>) => operation({ query });
  const options = { generationId: "generation", activatedAt: 1000, run, authority: { reader: { load }, receiver: { receive } },
    maximumSamples: 2, maximumPayloadBytes: 128_000, maximumRunMs: 1000, now: () => now };
  return { rows, query, load, receive, options, retry: createPostgresSourceFactRetry(options), setNow: (value: number) => { now = value; } };
}

test("scans only bounded committed originals and forwards unchanged reader requests", async () => {
  const f = fixture(), report = await f.retry.pollOnce(signal);
  expect(report).toMatchObject({ status: "polled", scanned: 2, attempted: 2, published: 2, duplicates: 0, failed: 0 });
  expect(f.load.mock.calls.map(([value]) => value.sampleId)).toEqual(["sample-0", "sample-1"]);
  expect(f.receive.mock.calls[0]![0].execution.knownAt).toBe(99_000);
  expect(f.receive.mock.calls[0]![0].validation.claims.expiresAt).toBe(160_000);
  expect(f.query.mock.calls[0]![1]).toEqual(["generation", 100_000, 1000, null, null, 2]);
  const sql = f.query.mock.calls[0]![0];
  for (const guard of ["forward_purchase_samples", "forward_trade_revisions", "original_fingerprint", "pending_review", "created_at", "recorded_at", "COLLATE", "LIMIT"])
    expect(sql).toContain(guard);
  expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE/);
});

test("recovers after restart without re-signing an existing source fact or calling it validated", async () => {
  const f = fixture(); await f.retry.pollOnce(signal);
  f.load.mockClear(); f.receive.mockClear();
  const restarted = createPostgresSourceFactRetry(f.options), report = await restarted.pollOnce(signal);
  expect(report).toMatchObject({ status: "polled", scanned: 2, alreadyRecorded: 2, attempted: 0, published: 0 });
  expect(f.load).not.toHaveBeenCalled(); expect(f.receive).not.toHaveBeenCalled();
  expect(report).not.toHaveProperty("validated");
  await restarted.pollOnce(signal);
  expect(f.load.mock.calls.map(([value]) => value.sampleId)).toEqual(["sample-2", "sample-3"]);
});

test("wraps keyset pagination and revisits earlier deferred samples without unbounded retry state", async () => {
  const f = fixture(); f.load.mockResolvedValue({ status: "deferred", reasonCode: "execution_envelope_unavailable" });
  for (let i = 0; i < 4; i++) await f.retry.pollOnce(signal);
  expect(f.load.mock.calls.map(([value]) => value.sampleId)).toEqual(["sample-0", "sample-1", "sample-2", "sample-3", "sample-4", "sample-0", "sample-1"]);
  expect(f.receive).not.toHaveBeenCalled();
});

test("missing authority defers before scanning and never constructs a validator or publisher", async () => {
  const f = fixture(), retry = createPostgresSourceFactRetry({ ...f.options, authority: undefined });
  expect(await retry.pollOnce(signal)).toMatchObject({ status: "deferred", reasonCode: "source_retry_authority_unavailable", attempted: 0 });
  expect(f.query).not.toHaveBeenCalled(); expect(f.receive).not.toHaveBeenCalled();
});

test.each(["generation", "revision", "original", "future", "activation", "order", "overflow", "payload"])("rejects malformed scan page before external work: %s", async kind => {
  const f = fixture();
  if (kind === "generation") f.rows[1]!.generation_id = "other";
  if (kind === "revision") f.rows[1]!.revision_state = "pending_review";
  if (kind === "original") f.rows[1]!.original_fingerprint = "b".repeat(64);
  if (kind === "future") f.rows[1]!.created_at = 100_001;
  if (kind === "activation") f.rows[1]!.activated_at = 1001;
  if (kind === "order") f.rows[1]!.created_at = 90_001;
  if (kind === "overflow") f.query.mockResolvedValue({ rows: f.rows, rowCount: 5 });
  const retry = kind === "payload" ? createPostgresSourceFactRetry({ ...f.options, maximumPayloadBytes: 20 }) : f.retry;
  expect(await retry.pollOnce(signal)).toMatchObject({ status: "deferred", failed: 1 });
  expect(f.load).not.toHaveBeenCalled(); expect(f.receive).not.toHaveBeenCalled();
});

test("receiver defer preserves fail-closed authority semantics and moves only the retry cursor", async () => {
  const f = fixture(); f.receive.mockResolvedValue({ status: "deferred", reasonCode: "source_authority_unavailable" });
  expect(await f.retry.pollOnce(signal)).toMatchObject({ published: 0, deferred: 2, failed: 0 });
  expect(f.rows.every(row => !row.source_recorded)).toBe(true);
  await f.retry.pollOnce(signal); expect(f.load.mock.calls[2]![0].sampleId).toBe("sample-2");
});

test("failed or uncertain publication does not advance the failing sample or expose raw error text", async () => {
  const f = fixture(); f.receive.mockRejectedValueOnce(new Error("https://secret.example/private?api_key=SECRET"));
  const report = await f.retry.pollOnce(signal);
  expect(report).toMatchObject({ failed: 1, published: 0 }); expect(JSON.stringify(report)).not.toMatch(/secret|SECRET|https/);
  await f.retry.pollOnce(signal); expect(f.load.mock.calls[1]![0].sampleId).toBe("sample-0");
});

test("a committed publication whose acknowledgement is lost is recovered from durable source state", async () => {
  const f = fixture(); f.receive.mockImplementationOnce(async (request: any) => {
    f.rows.find(row => row.sample_id === request.sampleId)!.source_recorded = true;
    throw new Error("connection lost after commit");
  });
  expect(await f.retry.pollOnce(signal)).toMatchObject({ failed: 1, published: 0 });
  f.receive.mockClear(); expect(await f.retry.pollOnce(signal)).toMatchObject({ alreadyRecorded: 1, published: 1 });
  expect(f.receive.mock.calls[0]![0].sampleId).toBe("sample-1");
});

test("reader cannot redirect a sample, inflate the payload or renew an expired envelope", async () => {
  const f = fixture(), original = f.load.getMockImplementation()!;
  f.load.mockImplementationOnce(async request => { const result = await original(request); result.request.sampleId = "other"; return result; });
  expect(await f.retry.pollOnce(signal)).toMatchObject({ failed: 1 }); expect(f.receive).not.toHaveBeenCalled();
  f.load.mockImplementationOnce(async request => { const result = await original(request); result.request.validation.claims.expiresAt = 100_000; return result; });
  expect(await f.retry.pollOnce(signal)).toMatchObject({ deferred: 1, published: 1 });
});

test("aborts before publication and holds serialization until a native publication actually settles", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  expect(await f.retry.pollOnce(controller.signal)).toMatchObject({ status: "deferred", attempted: 0 }); expect(f.query).not.toHaveBeenCalled();
  let finish: ((value: any) => void) | undefined;
  f.receive.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const running = f.retry.pollOnce(signal);
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce());
  expect(await f.retry.pollOnce(signal)).toMatchObject({ status: "deferred", reasonCode: "source_retry_busy" });
  f.setNow(101_001); finish!({ status: "published", factId: "source:sample-0" });
  expect(await running).toMatchObject({ status: "deferred", published: 0, failed: 1 });
});

test("rejects regressed clocks without moving the cursor", async () => {
  const f = fixture(); await f.retry.pollOnce(signal); f.setNow(99_999);
  expect(await f.retry.pollOnce(signal)).toMatchObject({ status: "deferred", failed: 1 });
  f.setNow(100_000); await f.retry.pollOnce(signal); expect(f.load.mock.calls[2]![0].sampleId).toBe("sample-2");
});

test("bounds hydrated requests before invoking the receiver", async () => {
  const f = fixture(), original = f.load.getMockImplementation()!;
  f.load.mockImplementationOnce(async request => {
    const result = await original(request); result.request.execution.raw = "x".repeat(128_001); return result;
  });
  expect(await f.retry.pollOnce(signal)).toMatchObject({ status: "deferred", failed: 1 });
  expect(f.receive).not.toHaveBeenCalled();
});

test("does not accept receiver status flags outside the publication contract", async () => {
  const f = fixture(); f.receive.mockResolvedValueOnce({ status: "validated" });
  expect(await f.retry.pollOnce(signal)).toMatchObject({ failed: 1, published: 0 });
  f.load.mockClear(); await f.retry.pollOnce(signal); expect(f.load.mock.calls[0]![0].sampleId).toBe("sample-0");
});

test("native read completion after cancellation cannot start publication", async () => {
  const f = fixture(), controller = new AbortController(), original = f.query.getMockImplementation()!;
  f.query.mockImplementationOnce(async (...args) => { controller.abort(); return original(...args); });
  expect(await f.retry.pollOnce(controller.signal)).toMatchObject({ status: "deferred", published: 0, failed: 1 });
  expect(f.load).not.toHaveBeenCalled(); expect(f.receive).not.toHaveBeenCalled();
});
