import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresTargetAuthorizationAcceptance } from "../src/postgres-target-authorization-acceptance.js";
const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
const suite = connectionString ? describe : describe.skip;
function runtime() { return createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 1,
  connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 1000 }); }
suite("forward target authorization with real PostgreSQL", () => {
  it("separates monitoring, manual authority and fresh stable capability with temporal audit", async () => {
    const database = runtime();
    try {
      for (let attempt = 0; attempt < 2; attempt++) expect(await verifyPostgresTargetAuthorizationAcceptance(database, 1_750_000_000_000 + attempt)).toMatchObject({
        channelVersions: 6, manualEvents: 3, capabilityVersions: 2, revocationInvalidatesQueuedStamp: true,
        identityConflictQuarantined: true, permissionGuardVerified: true, cleanupVerified: true, businessActivation: false });
    } finally { await database.close(); }
  });
  it("rolls back target/audit/outbox state when authorization intent persistence fails", async () => {
    const database = runtime();
    try {
      const interrupted = { probe: () => database.probe(), run: database.run.bind(database) };
      interrupted.run = operation => database.run(transaction => operation({ query: (sql, values) => {
        if (sql.includes("INSERT INTO forward_target_authorization_intents")) throw new Error("Authorization intent interruption");
        return transaction.query(sql, values);
      } }));
      await expect(verifyPostgresTargetAuthorizationAcceptance(interrupted, 1_750_000_000_000)).rejects.toThrow("Authorization intent interruption");
      const tables = await database.run(transaction => transaction.query("SELECT to_regclass('forward_target_channel_versions') AS targets,to_regclass('forward_manual_radar_authorizations') AS authorizations"));
      expect(tables.rows[0]).toEqual({ targets: null, authorizations: null });
    } finally { await database.close(); }
  });
});
