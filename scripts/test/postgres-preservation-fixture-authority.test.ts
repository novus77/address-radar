import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticatePreservationFixtureAuthority, preservationPreparationPins } from "../postgres-preservation-fixture-authority.js";
import { createFullDataPreservationSchemaSql } from "../../packages/database/src/postgres-full-data-import.js";
import type { PreservationRehearsalConfig } from "../rehearse-postgres-full-preservation.js";
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const schema = "radar_rehearsal_0123456789abcdef_history";
  const target = { database: "radar_rehearsal_0123456789abcdef", schema, username: "radar_preserver", generation: "fixture-preservation",
    service: "migration-preservation", serverAddress: "127.0.0.1", serverPort: 5434, systemIdentifier: "7333333333333333333",
    schemaVersion: 1, schemaFingerprint: sha(createFullDataPreservationSchemaSql(schema).join("\n")) };
  const config = { expected: { ...preservationPreparationPins }, target, approvalRef: "synthetic-private-fixture-review", deadlineAtMs: Date.now() + 60000 } as PreservationRehearsalConfig;
  const record = { version: 1, scope: "backup-derived-preservation-rehearsal", target, approvalRef: config.approvalRef,
    expiresAtMs: Date.now() + 120000, password: "a".repeat(64) };
  const bytes = Buffer.from(JSON.stringify(record)); return { config, record, bytes, pin: sha(bytes) };
}
describe("authenticated private preservation fixture adapter, no real PG", () => {
  it("accepts exact external record bytes, source pins and nonce target without granting production", () => {
    const f = fixture(); expect(authenticatePreservationFixtureAuthority(f.bytes, f.pin, f.config).scope).toBe("backup-derived-preservation-rehearsal");
  });
  it.each(["pin", "scope", "target", "expiry", "source", "schema", "unknown", "port"])("rejects %s mismatch before pool construction", change => {
    const f = fixture();
    if (change === "scope") f.record.scope = "approved-cutover";
    if (change === "target") f.config.target = { ...f.config.target, systemIdentifier: "7444444444444444444" };
    if (change === "expiry") f.record.expiresAtMs = Date.now() - 1;
    if (change === "source") f.config.expected = { ...f.config.expected, manifestSha256: "c".repeat(64) };
    if (change === "schema") { f.record.target.schemaFingerprint = "f".repeat(64); f.config.target = { ...f.config.target, schemaFingerprint: "f".repeat(64) }; }
    if (change === "port") { f.record.target.serverPort = 5433; f.config.target = { ...f.config.target, serverPort: 5433 }; }
    if (change === "unknown") Object.assign(f.record, { productionApproval: true });
    const bytes = Buffer.from(JSON.stringify(f.record)), pin = change === "pin" ? "d".repeat(64) : sha(bytes);
    expect(() => authenticatePreservationFixtureAuthority(bytes, pin, f.config)).toThrow("authority_rejected");
  });
});
