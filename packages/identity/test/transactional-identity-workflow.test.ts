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

const databasePath = (name: string): string =>
  join(mkdtempSync(join(tmpdir(), `${name}-`)), "address.sqlite");

describe("transactional identity completion", () => {
  it("transfers an accepted conflict to one owner and one monitoring entry", () => {
    const path = databasePath("identity-conflict-transfer");
    const repository = openAddressRadarRepository(path);
    repository.upsertFomoAccount({ accountId: "old-account", handle: "OldOwner", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertFomoAccount({ accountId: "new-account", handle: "NewOwner", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "old-entity", lifecycle: "probation", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.upsertTraderEntity({ entityId: "new-entity", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "old-entity", accountId: "old-account", confidence: "confirmed", source: "existing", observedAt: 1 });
    repository.linkAccountToEntity({ entityId: "new-entity", accountId: "new-account", confidence: "high", source: "candidate", observedAt: 1 });
    repository.attachWallet({ accountId: "old-account", chainFamily: "solana", address: "11111111111111111111111111111111", confidence: "confirmed", source: "existing", observedAt: 1 });
    repository.completeIdentityAdmission("old-account", 1);
    repository.enqueueIdentityResolution({ handle: "NewOwner", accountId: "new-account", priority: 90, reason: "manual_resolution", observedAt: 2 });
    repository.createIdentityConflict({
      conflictId: "ownership-transfer",
      handle: "NewOwner",
      accountId: "new-account",
      chainFamily: "solana",
      address: "11111111111111111111111111111111",
      conflictingAccountId: "old-account",
      status: "pending",
      payload: {},
      createdAt: 2,
      resolvedAt: null,
      resolution: null,
    });

    repository.resolveIdentityConflict({
      conflictId: "ownership-transfer",
      decision: "accepted",
      resolution: "operator_confirmed_transfer",
      occurredAt: 3,
    });

    expect(repository.walletOwner("solana", "11111111111111111111111111111111")).toBe("new-account");
    expect(repository.account("old-account")?.wallets).toEqual([]);
    expect(repository.pendingIdentityResolutions(4, 10)).toEqual([]);
    expect(repository.traderEntity("new-entity")?.lifecycle).toBe("probation");
    repository.close();

    const registry = openMonitoringRegistry(path);
    expect(registry.wallets("solana")).toEqual([{
      address: "11111111111111111111111111111111",
      accountId: "new-account",
      entityId: "new-entity",
      lifecycle: "probation",
    }]);
    expect(registry.version()).toBe(2);
    registry.close();
  });

  it("rolls back every automatic-resolution write when queue ownership mismatches", async () => {
    const path = databasePath("automatic-resolution-rollback");
    const repository = openAddressRadarRepository(path);
    repository.upsertFomoAccount({ accountId: "queued-account", handle: "Atomic", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "queued-entity", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "queued-entity", accountId: "queued-account", confidence: "high", source: "candidate", observedAt: 1 });
    repository.enqueueIdentityResolution({ handle: "Atomic", accountId: "queued-account", priority: 90, reason: "manual_resolution", observedAt: 1 });
    const service = createIdentityResolutionService({
      repository,
      now: () => 2,
      client: {
        byHandle: async () => ({
          kind: "resolved" as const,
          accountId: "different-account",
          handle: "ResolvedDifferentAccount",
          wallets: [{ chainFamily: "evm" as const, address: "0x1111111111111111111111111111111111111111" }],
          asOf: 2,
        }),
      },
    });

    await expect(service.resolve("Atomic")).rejects.toThrow(/account/i);

    expect(repository.account("different-account")).toBeNull();
    expect(repository.identityResolution("Atomic")).toBeNull();
    expect(repository.pendingIdentityResolutions(3, 10)).toEqual([
      expect.objectContaining({ handle: "atomic", accountId: "queued-account", status: "pending" }),
    ]);
    expect(repository.traderEntity("queued-entity")?.lifecycle).toBe("candidate");
    repository.close();

    const registry = openMonitoringRegistry(path);
    expect(registry.version()).toBe(0);
    expect(registry.wallets("evm")).toEqual([]);
    registry.close();
  });

  it("rejects a mismatched handle and account without changing queue or registry", () => {
    const path = databasePath("identity-association-mismatch");
    const repository = openAddressRadarRepository(path);
    repository.upsertFomoAccount({ accountId: "account-a", handle: "Alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertFomoAccount({ accountId: "account-b", handle: "Beta", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity-b", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "entity-b", accountId: "account-b", confidence: "high", source: "candidate", observedAt: 1 });
    repository.attachWallet({ accountId: "account-b", chainFamily: "solana", address: "11111111111111111111111111111111", confidence: "high", source: "test", observedAt: 1 });
    repository.enqueueIdentityResolution({ handle: "Alpha", accountId: "account-a", priority: 80, reason: "manual_resolution", observedAt: 1 });

    expect(() => repository.completeIdentityResolution("Alpha", "account-b", 2)).toThrow(/account/i);

    expect(repository.pendingIdentityResolutions(3, 10)).toEqual([
      expect.objectContaining({ handle: "alpha", accountId: "account-a", status: "pending" }),
    ]);
    expect(repository.traderEntity("entity-b")?.lifecycle).toBe("candidate");
    repository.close();

    const registry = openMonitoringRegistry(path);
    expect(registry.version()).toBe(0);
    registry.close();
  });

  it("treats retrying a completed association as an idempotent no-op", () => {
    const path = databasePath("identity-completion-retry");
    const repository = openAddressRadarRepository(path);
    repository.upsertFomoAccount({ accountId: "account", handle: "Retry", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "entity", accountId: "account", confidence: "high", source: "candidate", observedAt: 1 });
    repository.attachWallet({ accountId: "account", chainFamily: "solana", address: "11111111111111111111111111111111", confidence: "high", source: "test", observedAt: 1 });
    repository.enqueueIdentityResolution({ handle: "Retry", accountId: "account", priority: 80, reason: "manual_resolution", observedAt: 1 });

    expect(repository.completeIdentityResolution("Retry", "account", 2)).toBe("entity");
    expect(repository.completeIdentityResolution("Retry", "account", 3)).toBe("entity");
    repository.close();

    const registry = openMonitoringRegistry(path);
    expect(registry.version()).toBe(1);
    registry.close();
  });

  it("rolls back earlier batch items when a later item is invalid", () => {
    const path = databasePath("manual-batch-rollback");
    const repository = openAddressRadarRepository(path);
    for (const [accountId, handle] of [["account-1", "First"], ["account-2", "Second"]] as const) {
      repository.upsertFomoAccount({ accountId, handle, firstSeenAt: 1, lastSeenAt: 1 });
      repository.upsertTraderEntity({ entityId: `entity-${accountId}`, lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      repository.linkAccountToEntity({ entityId: `entity-${accountId}`, accountId, confidence: "high", source: "candidate", observedAt: 1 });
      repository.enqueueIdentityResolution({ handle, accountId, priority: 80, reason: "manual_resolution", observedAt: 1 });
    }
    const service = createManualResolutionService({ repository, now: () => 2 });
    service.createBatch({ batchId: "batch", maxSize: 2 });

    expect(() => service.importMappings({
      importId: "failed-import",
      batchId: "batch",
      importedAt: 3,
      items: [
        { handle: "First", observedAt: 3, source: "fomolens_manual", wallets: [{ family: "solana", address: "11111111111111111111111111111111" }] },
        { handle: "Second", observedAt: 3, source: "fomolens_manual", wallets: [{ family: "evm", address: "invalid" }] },
      ],
    })).toThrow(/EVM/i);

    expect(repository.account("account-1")?.wallets).toEqual([]);
    expect(repository.identityResolutionBatch("batch")?.status).toBe("exported");
    expect(repository.identityResolutionQueue(10)).toEqual([
      expect.objectContaining({ handle: "first", status: "exported" }),
      expect.objectContaining({ handle: "second", status: "exported" }),
    ]);
    repository.close();

    const database = new DatabaseSync(path);
    expect(database.prepare("SELECT COUNT(*) AS count FROM wallet_mapping_observations").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM operator_audit_log WHERE action = 'identity.batch_import'").get()).toEqual({ count: 0 });
    database.close();
  });
});
