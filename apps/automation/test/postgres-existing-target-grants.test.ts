import { expect, test } from "vitest";
import { createExistingPostgresTargetGrantPlan } from "../src/postgres-existing-target-grants.js";
import { POSTGRES_BUSINESS_SERVICES, postgresBusinessResourcePolicyFingerprint } from "../../../packages/database/src/postgres-business-provisioning.js";

function options() {
  const resources = { pools: Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => [service, { instances: 1, maximumConnections: 1 }])),
    serverMaximumConnections: 30, postgresReservedConnections: 3, otherHostConnections: 0,
    migrationConnections: 1, operatorConnections: 1, backupConnections: 1, maximumMeasurementAgeMs: 60000,
    maximumPendingOperations: 0, connectionTimeoutMs: 2000, idleTimeoutMs: 500, statementTimeoutMs: 3000,
    lockTimeoutMs: 500, idleTransactionTimeoutMs: 10000, shutdownTimeoutMs: 2000, workMemKb: 1024 };
  const now = "2026-10-08T00:00:00.000Z";
  return { database: "address_radar", schema: "address_radar_business", generation: "production-v1",
    migratorRole: "address_radar_migrator",
    serviceRoles: Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => [service, "address_radar_" + service.replaceAll("-", "_")])),
    resources, now, capacity: { status: "measured", hostId: "production-host", measurementRef: "capacity/observed",
      resourcePolicyFingerprint: postgresBusinessResourcePolicyFingerprint(resources as never), measuredAt: now,
      validUntil: "2026-10-08T00:01:00.000Z", availableRamBytes: "1073741824", measuredPeakRamBytes: "16777216",
      ramMarginBytes: "16777216", availableDiskBytes: "5368709120", measuredPeakDiskBytes: "16777216",
      measuredPeakWalBytes: "67108864", measuredPeakTempBytes: "16777216", diskMarginBytes: "16777216" } };
}

test("existing-target plan does not create roles, enable login or grant activation", () => {
  const plan = createExistingPostgresTargetGrantPlan(options() as never);
  expect(plan.productionMigrationReady).toBe(false);
  expect(plan.requiresIndependentPrivilegeProbe).toBe(true);
  expect(plan.schemaVersion).toBe(3);
  expect(plan.statements.join("\n")).not.toMatch(/CREATE ROLE|CREATE DATABASE|PASSWORD|\bLOGIN\b/);
  expect(plan.statements.join("\n")).toContain('"migration_cutover_first_write_markers"');
  expect(plan.statements.join("\n")).not.toMatch(/GRANT (INSERT|UPDATE|DELETE).*migration_cutover_first_write_markers/);
});

test("missing or expired capacity is refused", () => {
  expect(() => createExistingPostgresTargetGrantPlan({ ...options(), capacity: undefined } as never)).toThrow();
  expect(() => createExistingPostgresTargetGrantPlan({ ...options(), now: "2026-10-08T01:00:00.000Z" } as never)).toThrow();
});
