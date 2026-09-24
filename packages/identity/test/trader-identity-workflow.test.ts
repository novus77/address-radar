import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import {
  createIdentityResolutionService,
  createManualResolutionService,
  openMonitoringRegistry,
} from "@address-radar/identity";

describe("trader identity workflow", () => {
  const ability = (entityId: string, asOf = 3) => ({
    snapshotId: `ability-${entityId}-${asOf}`, entityId, window: "30d" as const, asOf,
    strategyVersion: "address-v1", rawQuality: 0.9, adjustedQuality: 0.8,
    sampleConfidence: 0.85, coverageConfidence: 1, metrics: {}, components: {},
    styles: { HIGH_MULTIPLE: 0.9 }, createdAt: asOf,
  });

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

  it("synchronizes signal eligibility from confirmed identity, ability, and lifecycle", () => {
    const repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "account", handle: "Eligible", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity", lifecycle: "probation", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "entity", accountId: "account", confidence: "confirmed", source: "fomoscan", observedAt: 1 });
    repository.saveTraderAbilitySnapshot(ability("entity"));

    expect(repository.traderSignalProfile("entity")).toMatchObject({ mapped: true, monitoringEnabled: false });
    repository.updateTraderLifecycle("entity", "active", 4);
    expect(repository.traderSignalProfile("entity")).toMatchObject({ mapped: true, monitoringEnabled: true, fomoMonitoringEnabled: true });
    repository.updateTraderLifecycle("entity", "suspended", 5);
    expect(repository.traderSignalProfile("entity")).toMatchObject({ monitoringEnabled: false });
    repository.close();
  });

  it.each(["low", "medium", "high"] as const)("does not map %s-confidence identities for signals", (confidence) => {
    const repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: confidence, handle: confidence, firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: confidence, lifecycle: "elite", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: confidence, accountId: confidence, confidence, source: "test", observedAt: 1 });
    repository.saveTraderAbilitySnapshot(ability(confidence));
    expect(repository.traderSignalProfile(confidence)).toMatchObject({ mapped: false, monitoringEnabled: false });
    repository.close();
  });

  it("creates a manually trusted wallet identity without requiring a Fomo handle", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "address-manual-wallet-")), "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    const service = createManualResolutionService({ repository, now: () => 10 });

    expect(service.createManualTrader({
      entityId: "manual-wallet-trader",
      displayName: "手动重点一号",
      observedAt: 10,
      wallets: [{ family: "evm", address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" }],
      abilities: ["early_multiplier"],
    })).toEqual({ entityId: "manual-wallet-trader", lifecycle: "observing" });

    expect(repository.traderEntity("manual-wallet-trader")).toMatchObject({
      lifecycle: "probation",
      manual: true,
    });
    repository.close();

    const registry = openMonitoringRegistry(databasePath);
    expect(registry.wallets("evm")).toEqual([{
      address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      accountId: "manual-wallet-trader",
      entityId: "manual-wallet-trader",
      lifecycle: "probation",
    }]);
    registry.close();

    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT source_key FROM trader_sources WHERE entity_id = ?").all("manual-wallet-trader"))
      .toEqual([{ source_key: "manual" }]);
    expect(database.prepare("SELECT ability_key FROM trader_abilities WHERE entity_id = ?").all("manual-wallet-trader"))
      .toEqual([{ ability_key: "early_multiplier" }]);
    database.close();
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
