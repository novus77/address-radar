import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { createManualResolutionService, openMonitoringRegistry } from "@address-radar/identity";

describe("trader identity workflow", () => {
  it("closes the active resolution item and durably registers the resolved candidate for monitoring", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "address-identity-")), "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-candidate", handle: "Multiplier", firstSeenAt: 1, lastSeenAt: 2 });
    repository.upsertTraderEntity({ entityId: "entity-candidate", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 2 });
    repository.linkAccountToEntity({ entityId: "entity-candidate", accountId: "account-candidate", confidence: "high", source: "milestone_discovery", observedAt: 2 });
    repository.enqueueIdentityResolution({ handle: "Multiplier", accountId: "account-candidate", priority: 92, reason: "market_cap_500k_10x", observedAt: 2 });

    const service = createManualResolutionService({ repository, now: () => 3 });
    expect(service.importDirectMappings({
      importId: "import-candidate",
      importedAt: 3,
      items: [{
        handle: "Multiplier",
        observedAt: 3,
        source: "fomolens_manual",
        wallets: [{ family: "solana", address: "11111111111111111111111111111111" }],
      }],
    })).toEqual({ resolved: 1, conflicts: 0, observations: 1 });

    expect(repository.pendingIdentityResolutions(4, 10)).toEqual([]);
    expect(repository.traderEntity("entity-candidate")?.lifecycle).toBe("probation");
    repository.close();

    const registry = openMonitoringRegistry(databasePath);
    expect(registry.version()).toBe(1);
    expect(registry.wallets("solana")).toEqual([{
      address: "11111111111111111111111111111111",
      accountId: "account-candidate",
      entityId: "entity-candidate",
      lifecycle: "probation",
    }]);
    registry.close();
  });
});
