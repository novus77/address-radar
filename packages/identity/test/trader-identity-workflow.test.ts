import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import {
  createIdentityResolutionService,
  createManualResolutionService,
  openMonitoringRegistry,
} from "@address-radar/identity";

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

describe("automatic identity resolution", () => {
  it("atomically closes and admits a candidate when a wallet resolves", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "address-automatic-identity-")), "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-automatic", handle: "Automatic", firstSeenAt: 1, lastSeenAt: 2 });
    repository.upsertTraderEntity({ entityId: "entity-automatic", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 2 });
    repository.linkAccountToEntity({ entityId: "entity-automatic", accountId: "account-automatic", confidence: "high", source: "milestone_discovery", observedAt: 2 });
    repository.enqueueIdentityResolution({ handle: "Automatic", accountId: "account-automatic", priority: 90, reason: "market_cap_500k_10x", observedAt: 2 });

    const service = createIdentityResolutionService({
      repository,
      now: () => 3,
      client: {
        byHandle: async () => ({
          kind: "resolved" as const,
          accountId: "account-automatic",
          handle: "Automatic",
          wallets: [{ chainFamily: "evm" as const, address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" }],
          asOf: 3,
        }),
      },
    });

    await service.resolve("Automatic");

    expect(repository.pendingIdentityResolutions(4, 10)).toEqual([]);
    expect(repository.traderEntity("entity-automatic")?.lifecycle).toBe("probation");
    repository.close();

    const registry = openMonitoringRegistry(databasePath);
    expect(registry.version()).toBe(1);
    expect(registry.wallets("evm")).toEqual([{
      address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      accountId: "account-automatic",
      entityId: "entity-automatic",
      lifecycle: "probation",
    }]);
    registry.close();
  });
});

describe("accepted identity conflict", () => {
  it("atomically closes and admits the candidate into monitoring", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "address-conflict-identity-")), "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-candidate", handle: "Candidate", firstSeenAt: 1, lastSeenAt: 2 });
    repository.upsertFomoAccount({ accountId: "account-owner", handle: "Owner", firstSeenAt: 1, lastSeenAt: 2 });
    repository.upsertTraderEntity({ entityId: "entity-candidate", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 2 });
    repository.linkAccountToEntity({ entityId: "entity-candidate", accountId: "account-candidate", confidence: "high", source: "milestone_discovery", observedAt: 2 });
    repository.attachWallet({ accountId: "account-owner", chainFamily: "solana", address: "11111111111111111111111111111111", confidence: "confirmed", source: "existing", observedAt: 2 });
    repository.enqueueIdentityResolution({ handle: "Candidate", accountId: "account-candidate", priority: 90, reason: "market_cap_500k_10x", observedAt: 2 });
    repository.createIdentityConflict({
      conflictId: "conflict-accepted",
      handle: "Candidate",
      accountId: "account-candidate",
      chainFamily: "solana",
      address: "11111111111111111111111111111111",
      conflictingAccountId: "account-owner",
      status: "pending",
      payload: { source: "test" },
      createdAt: 2,
      resolvedAt: null,
      resolution: null,
    });

    repository.resolveIdentityConflict({
      conflictId: "conflict-accepted",
      decision: "accepted",
      resolution: "operator_confirmed",
      occurredAt: 3,
    });

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
