import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { openMonitoringRegistry } from "@address-radar/identity";
import { createWalletAnalysisReviewService, openWalletAnalysisStore } from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("wallet-only acceptance links the confirmed wallet directly and enters monitoring without a Fomo account", () => {
  const fixture = createFixture("wallet-only");
  const review = createWalletAnalysisReviewService({ store: fixture.store, repository: fixture.repository });

  assert.deepEqual(review.accept({
    analysisId: "analysis-1",
    entityId: "entity-1",
    reviewedAt: 2_000,
  }), { status: "accepted", entityId: "entity-1" });

  const database = new DatabaseSync(fixture.path);
  assert.equal(count(database, "fomo_accounts"), 0);
  assert.equal(count(database, "entity_wallet_identities"), 1);
  assert.equal(status(database, "analysis-1"), "accepted");
  assert.equal(version(database), 1);
  database.close();

  const registry = openMonitoringRegistry(fixture.path);
  assert.deepEqual(registry.wallets("solana").map((wallet) => ({
    address: wallet.address,
    accountId: wallet.accountId,
    entityId: wallet.entityId,
  })), [{ address: "wallet-1", accountId: "entity-1", entityId: "entity-1" }]);
  registry.close();
  fixture.close();
});

test("a late registry failure rolls back every acceptance write", () => {
  const fixture = createFixture("rollback");
  const database = new DatabaseSync(fixture.path);
  database.exec(`
    CREATE TRIGGER fail_registry_update
    BEFORE UPDATE ON monitoring_registry_state
    BEGIN
      SELECT RAISE(ABORT, 'injected late failure');
    END;
  `);
  database.close();
  const review = createWalletAnalysisReviewService({ store: fixture.store, repository: fixture.repository });

  assert.throws(() => review.accept({
    analysisId: "analysis-1",
    entityId: "entity-1",
    reviewedAt: 2_000,
  }), /injected late failure/);

  const check = new DatabaseSync(fixture.path);
  assert.equal(count(check, "trader_entities"), 0);
  assert.equal(count(check, "entity_wallet_identities"), 0);
  assert.equal(count(check, "operator_audit_log"), 0);
  assert.equal(status(check, "analysis-1"), "review_required");
  assert.equal(version(check), 0);
  check.close();
  fixture.close();
});

test("accepted retry returns the persisted entity and rejects conflicting request fields", () => {
  const fixture = createFixture("accepted-retry");
  const review = createWalletAnalysisReviewService({ store: fixture.store, repository: fixture.repository });
  review.accept({ analysisId: "analysis-1", entityId: "entity-1", reviewedAt: 2_000 });
  assert.deepEqual(review.accept({ analysisId: "analysis-1", entityId: "entity-1", reviewedAt: 2_001 }), { status: "accepted", entityId: "entity-1" });
  assert.throws(() => review.accept({ analysisId: "analysis-1", entityId: "arbitrary", reviewedAt: 2_002 }), /does not match persisted admission/);
  fixture.close();
});

test("review admission rejects linking one Fomo account to a second entity", () => {
  const fixture = createFixture("account-owner");
  fixture.repository.upsertFomoAccount({ accountId: "account", handle: "trader", firstSeenAt: 1, lastSeenAt: 1 });
  fixture.repository.ensureTraderEntity({ entityId: "existing", lifecycle: "candidate", manual: true, locked: false, createdAt: 1, updatedAt: 1 });
  fixture.repository.linkAccountToEntity({ accountId: "account", entityId: "existing", confidence: "confirmed", source: "test", observedAt: 1 });
  const review = createWalletAnalysisReviewService({ store: fixture.store, repository: fixture.repository });
  const result = review.accept({ analysisId: "analysis-1", entityId: "requested", accountId: "account", handle: "trader", reviewedAt: 2_000 });
  assert.equal(result.status, "conflict");
  assert.equal(fixture.repository.entityForAccount("account"), "existing");
  assert.equal(fixture.repository.traderEntity("requested"), null);
  fixture.close();
});

test("two SQLite connections expose deterministic busy then one terminal review decision", () => {
  const fixture = createFixture("connection-race");
  const contender = openAddressRadarRepository(fixture.path);
  const lock = new DatabaseSync(fixture.path);
  lock.exec("BEGIN IMMEDIATE");
  assert.throws(() => contender.reviewWalletAnalysisDecision({ decision: "reject", analysisId: "analysis-1", reviewedAt: 2_000 }), /busy|locked/i);
  lock.exec("ROLLBACK");
  assert.equal(fixture.repository.reviewWalletAnalysisDecision({ decision: "accept", analysisId: "analysis-1", entityId: "entity-1", reviewedAt: 2_001 }).status, "accepted");
  assert.throws(() => contender.reviewWalletAnalysisDecision({ decision: "reject", analysisId: "analysis-1", reviewedAt: 2_002 }), /finalized as accepted/);
  const check = new DatabaseSync(fixture.path);
  assert.equal(count(check, "entity_wallet_identities"), 1);
  assert.equal(version(check), 1);
  check.close();
  lock.close();
  contender.close();
  fixture.close();
}, 15_000);

function createFixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `address-radar-${name}-`));
  directories.push(directory);
  const path = join(directory, "database.sqlite");
  const repository = openAddressRadarRepository(path);
  const store = openWalletAnalysisStore(path);
  store.enqueue({
    analysisId: "analysis-1",
    chainFamily: "solana",
    address: "wallet-1",
    requestedSamples: 10,
    createdAt: 1_000,
  });
  const database = new DatabaseSync(path);
  database.prepare("UPDATE wallet_analysis_jobs SET status = 'review_required' WHERE analysis_id = ?").run("analysis-1");
  database.close();
  return {
    path,
    repository,
    store,
    close() {
      store.close();
      repository.close();
    },
  };
}

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}
function status(database: DatabaseSync, analysisId: string): string {
  return String((database.prepare("SELECT status FROM wallet_analysis_jobs WHERE analysis_id = ?").get(analysisId) as { status: string }).status);
}
function version(database: DatabaseSync): number {
  return Number((database.prepare("SELECT version FROM monitoring_registry_state WHERE singleton = 1").get() as { version: number }).version);
}
