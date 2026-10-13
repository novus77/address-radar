import { describe, expect, it, vi } from "vitest";
import type { PostgresBusinessIdentity } from "../../../packages/database/src/postgres-business-driver.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import { addressOnlyCohortDigest, validateAddressOnlyStartupManifest, verifyAddressOnlyCommittedStartup } from "../src/postgres-address-only-startup.js";

const hash = "a".repeat(64);
const cohort = [{ subject_key: "evm:abc", entity_id: "entity:1", wallet_family: "evm", profile_payload: "{}", import_id: "import:1", observed_at: "123" }];
function fixture() {
  const manifest = { protocol: "address-only-v1" as const, operationId: "op:1", importId: "import:1", generationId: "gen:1", activatedAt: 123,
    planSha256: hash, seedSha256: hash, cohortSha256: addressOnlyCohortDigest(cohort), walletCount: 1, entityCount: 1,
    releaseSha256: hash, backupSha256: hash, fenceSha256: hash,
    target: { database: "radar", schema: "business", schemaFingerprint: hash, systemIdentifier: "123456", serverAddress: "127.0.0.1" as const, serverPort: 5432 as const },
    gatewayDeliveryEnabled: false as const, fomoEnabled: false as const, fullHistoricalMiningEnabled: false as const };
  const identity: PostgresBusinessIdentity = { ...manifest.target, username: "reader", generation: "gen:1", service: "wallet", schemaVersion: 1 };
  const rows: Record<string, unknown>[][] = [[{ database: "radar", server_address: "127.0.0.1", server_port: 5432, system_identifier: "123456" }],
    [{ generation_id: "gen:1", activated_at: "123" }], [{ import_id: "import:1", generation_id: "gen:1", source_fingerprint: hash, proof_scope: "address_only_registry", revoked_at: null }], cohort.map(row => ({ ...row }))];
  const related = { valid: true }; const sql: string[] = []; let runs = 0;
  const runtime = { async run<T>(operation: (tx: PostgresTransaction) => Promise<T>): Promise<T> { runs++; return operation({ async query(text) {
    sql.push(text);
    if (/SET TRANSACTION/.test(text)) throw new Error("SET TRANSACTION must be called before any query");
    return { rows: [{ snapshot: { cluster: rows[0], generations: rows[1], ledger: rows[2], cohort: rows[3], related_valid: related.valid } }], rowCount: 1 };
  } }); } };
  return { manifest, identity, rows, sql, related, get runs() { return runs; }, options: { manifest, identity, runtime, releaseSha256: hash, backupSha256: hash, fenceSha256: hash, disabledFlags: { gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false }, deadline: new Date(Date.now() + 60_000).toISOString() } };
}
describe("address-only committed startup (mock unit evidence, not native proof)", () => {
  it("verifies one read UOW without authorizing writes", async () => {
    const f = fixture(); const result = await verifyAddressOnlyCommittedStartup(f.options);
    expect(result).toMatchObject({ protocol: "address-only-v1", walletCount: 1, entityCount: 1, generationId: "gen:1", importId: "import:1", writeAuthorized: false, activationEnabled: false });
    expect(f.runs).toBe(1); expect(f.sql).toHaveLength(1); expect(f.sql[0]).not.toContain("SET TRANSACTION");
    expect(f.sql.at(-1)).toContain('"business"."wallet_service_profile_cohort"');
    expect(f.sql.at(-1)).toContain("octet_length"); expect(f.sql.at(-1)).toContain("CASE WHEN"); expect(f.sql.at(-1)).toContain("LIMIT 1001");
  });
  it("normalizes PostgreSQL inet text before building the JSON cluster snapshot", async () => {
    const f = fixture();
    f.options.runtime.run = async operation => operation({ query: async text => {
      f.sql.push(text);
      // PostgreSQL inet::text carries /32; host(inet) returns the address used by runtime identity.
      const address = text.includes("pg_catalog.host(inet_server_addr()) AS server_address")
        ? "127.0.0.1" : "127.0.0.1/32";
      return { rows: [{ snapshot: { cluster: [{ ...f.rows[0]![0], server_address: address }],
        generations: f.rows[1], ledger: f.rows[2], cohort: f.rows[3], related_valid: true } }], rowCount: 1 };
    } });
    await expect(verifyAddressOnlyCommittedStartup(f.options)).resolves.toMatchObject({ walletCount: 1 });
    expect(f.sql[0]).toContain("pg_catalog.host(inet_server_addr()) AS server_address");
    expect(f.sql[0]).not.toContain("inet_server_addr()::text");
    expect(f.sql[0]).toContain("system_identifier::text AS system_identifier");
  });
  it("still rejects a non-normalized cluster address rather than weakening identity equality", async () => {
    const f = fixture(); f.rows[0]![0]!.server_address = "127.0.0.1/32";
    await expect(verifyAddressOnlyCommittedStartup(f.options)).rejects.toThrow("cluster_mismatch");
  });
  for (const kind of ["count", "digest", "extra", "generation", "revoked", "cluster", "rowImport", "entities"] as const) it(`rejects ${kind}`, async () => {
    const f = fixture();
    if (kind === "count") f.manifest.walletCount = 2;
    if (kind === "digest") f.manifest.cohortSha256 = hash;
    if (kind === "extra") f.rows[3]!.push({ ...cohort[0], subject_key: "evm:extra" });
    if (kind === "generation") f.rows[1]![0]!.activated_at = "124";
    if (kind === "revoked") f.rows[2]![0]!.revoked_at = "124";
    if (kind === "cluster") f.rows[0]![0]!.system_identifier = "987";
    if (kind === "rowImport") f.rows[3]![0]!.import_id = "other";
    if (kind === "entities") { f.manifest.walletCount = 2; f.manifest.entityCount = 2; f.rows[3]!.push({ ...cohort[0], subject_key: "evm:other" }); }
    await expect(verifyAddressOnlyCommittedStartup(f.options)).rejects.toThrow();
  });
  it("rejects release, expiry, abort and flags before starting", async () => {
    for (const kind of ["release", "backup", "fence", "actualFlags", "expiry", "abort", "flags"]) {
      const f = fixture(); const controller = new AbortController();
      if (kind === "backup") f.options.backupSha256 = "b".repeat(64);
      if (kind === "fence") f.options.fenceSha256 = "b".repeat(64);
      if (kind === "actualFlags") f.options.disabledFlags.fomoEnabled = true;
      if (kind === "release") f.options.releaseSha256 = "b".repeat(64);
      if (kind === "expiry") f.options.deadline = "2000-01-01T00:00:00.000Z";
      if (kind === "abort") controller.abort();
      if (kind === "flags") Object.assign(f.manifest, { fomoEnabled: true });
      await expect(verifyAddressOnlyCommittedStartup({ ...f.options, signal: controller.signal })).rejects.toThrow(); expect(f.runs).toBe(0);
    }
  });
  it("requires trusted measurements even when the manifest asserts safe values", async () => {
    const f = fixture(); Object.assign(f.options, { backupSha256: undefined });
    await expect(verifyAddressOnlyCommittedStartup(f.options)).rejects.toThrow(); expect(f.runs).toBe(0);
  });
  it("checks all related tables in the same snapshot and rejects broken relationships", async () => {
    const f = fixture(); f.related.valid = false;
    await expect(verifyAddressOnlyCommittedStartup(f.options)).rejects.toThrow("related_state");
    for (const name of ["wallet_service_profile_versions", "forward_target_channel_versions", "forward_target_identity_bindings", "forward_target_channel_heads"])
      expect(f.sql[0]).toContain(`"business"."${name}"`);
  });
  it("accepts actual domain identifiers instead of restrictive labels", async () => {
    const f = fixture(); f.rows[3]![0]!.subject_key = "wallet / 钱包 #1"; f.rows[3]![0]!.entity_id = "entity / 客户 #1";
    f.manifest.cohortSha256 = addressOnlyCohortDigest(f.rows[3]!);
    await expect(verifyAddressOnlyCommittedStartup(f.options)).resolves.toMatchObject({ walletCount: 1 });
  });
  it("rejects a server-suppressed oversized snapshot", async () => {
    const f = fixture(); f.options.runtime.run = async operation => operation({ query: async () => ({ rows: [{ snapshot: null }], rowCount: 1 }) });
    await expect(verifyAddressOnlyCommittedStartup(f.options)).rejects.toThrow("snapshot_bound");
  });
  it("pins relationship checks and both server-side byte gates (SQL contract, not native proof)", async () => {
    const f = fixture(); await verifyAddressOnlyCommittedStartup(f.options);
    for (const fragment of ["p.import_id=c.import_id", "p.version_id=c.profile_payload::jsonb->>'versionId'",
      "p.enabled=", "p.suspended=", "v.version_id=p.version_id", "v.payload::jsonb=",
      "b.created_by_version=p.version_id", "b.conflict_at IS NULL", "b.conflict_by_version IS NULL",
      "h.version_id=p.version_id", "h.head_generation=1", "count(*)=$4 FROM profiles",
      "CASE WHEN octet_length(profile_payload) <= $3", "CASE WHEN octet_length(body::text) <= $3"])
      expect(f.sql[0]).toContain(fragment);
    expect(f.sql[0]).toContain('WHERE generation_id=$1 ORDER BY subject_key COLLATE "C" LIMIT 1001');
  });
  it("rejects each enabled actual integration flag before runtime starts", async () => {
    for (const key of ["gatewayDeliveryEnabled", "fomoEnabled", "fullHistoricalMiningEnabled"] as const) {
      const f = fixture(); f.options.disabledFlags[key] = true;
      await expect(verifyAddressOnlyCommittedStartup(f.options)).rejects.toThrow("actual_disabled_flags_required"); expect(f.runs).toBe(0);
    }
  });
  it("bounds actual identifiers in UTF-8 bytes and rejects controls", () => {
    expect(() => addressOnlyCohortDigest([{ ...cohort[0], entity_id: "界".repeat(170) }])).not.toThrow();
    for (const entity_id of ["界".repeat(171), "bad\\n".replace("\\n", "\n"), "   "])
      expect(() => addressOnlyCohortDigest([{ ...cohort[0], entity_id }])).toThrow();
  });
  it("rejects abort while the snapshot query is pending", async () => {
    const f = fixture(); const controller = new AbortController();
    f.options.runtime.run = async operation => operation({ query: () => new Promise(() => {}) });
    const pending = verifyAddressOnlyCommittedStartup({ ...f.options, signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
  it("rejects deadline expiry while the snapshot query is pending", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.options.deadline = new Date(Date.now() + 10).toISOString();
      f.options.runtime.run = async operation => operation({ query: () => new Promise(() => {}) });
      const pending = expect(verifyAddressOnlyCommittedStartup(f.options)).rejects.toThrow("expired");
      await vi.advanceTimersByTimeAsync(11); await pending;
    } finally { vi.useRealTimers(); }
  });
  it("rejects unsafe schemas, unknown fields and excessive counts", () => {
    for (const patch of [{ target: { ...fixture().manifest.target, schema: "public" } }, { extra: true }, { walletCount: 1001 }])
      expect(() => validateAddressOnlyStartupManifest({ ...fixture().manifest, ...patch })).toThrow();
  });
  it("normalizes decimal timestamps and bounds digest bytes and rows", () => {
    expect(addressOnlyCohortDigest([{ ...cohort[0], observed_at: 123 }])).toBe(addressOnlyCohortDigest(cohort));
    expect(() => addressOnlyCohortDigest(Array.from({ length: 1001 }, () => cohort[0]!))).toThrow();
    expect(() => addressOnlyCohortDigest([{ ...cohort[0], profile_payload: "x".repeat(4 * 1024 * 1024) }])).toThrow();
  });
});
