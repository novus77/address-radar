import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime } from "../src/postgres-acceptance-driver.js";
import { createSyntheticPreservationAcceptanceBundle, verifyPostgresPreservationRoundTrip } from "../src/postgres-preservation-acceptance.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("isolated PostgreSQL preservation staging", () => {
  it("round-trips typed values and verifies commit cleanup plus partial rollback on the same session", async () => {
    const runtime = createPostgresAcceptanceRuntime({
      connectionString: connectionString!, maximumConnections: 1, connectionTimeoutMs: 2000,
      idleTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 500,
    });
    try {
      const report = await verifyPostgresPreservationRoundTrip(runtime, createSyntheticPreservationAcceptanceBundle());
      expect(report).toMatchObject({
        status: "passed", sourceRows: 2, sourceCells: 21, sourceEdges: 1, sourceRoots: 1,
        successCommitDropsTemporaryTables: true, partialFailureRollback: true,
        sameSessionCleanupVerified: true, exactObservedStorageValues: true,
        productionMigrationReady: false, businessActivation: false, gatewayDeliveryEnabled: false,
      });
    } finally { await runtime.close(); }
  });
});
