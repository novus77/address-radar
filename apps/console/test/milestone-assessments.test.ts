import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSourceLedgerStore, createTokenFactStore, migrateAddressRadarDatabase, openAddressRadarDatabase } from "@address-radar/database";
import { createAddressConsoleApplication } from "../src/application.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

it("separates live confirmation, historical gaps, source limits and verified milestones", () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-milestone-states-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "radar.db");
  const database = openAddressRadarDatabase(path); migrateAddressRadarDatabase(database);
  const now = Date.now();
  const ledger = createSourceLedgerStore(database); const facts = createTokenFactStore(database);
  for (const address of ["live", "historical", "unavailable", "confirmed", "stale"]) {
    const tokenId = `base:${address}`;
    ledger.saveTokenObservation({ tokenId, chain: "base", tokenAddress: address, observedAt: now - 1_000, marketStatus: "resolved", marketCapUsd: 10_000 });
    facts.ensure(tokenId, "market_identity", "test", now);
    facts.transition({ tokenId, factType: "market_identity", status: "available", primarySource: "test", observedAt: now - 1_000, freshUntil: address === "stale" ? now - 1 : now + 60_000, strategyVersion: "test", updatedAt: now });
  }
  ledger.enqueueRecoveryJob({ jobId: "historical", jobType: "historical_research", chain: "base", subjectKey: "base:historical", priority: 60, cursor: null, nextAttemptAt: now, createdAt: now });
  facts.ensure("base:unavailable", "milestone_crossings", "test", now);
  facts.transition({ tokenId: "base:unavailable", factType: "milestone_crossings", status: "terminal_unavailable", terminalReason: "provider_coverage_unavailable", strategyVersion: "test", updatedAt: now });
  database.prepare(`INSERT INTO token_milestone_crossings(milestone_id,token_id,market_cap_usd,crossed_at,precision,source,source_event_ids,strategy_version)
    VALUES('proof','base:confirmed',100000,?,'exact','test','[]','test')`).run(now - 2_000);
  database.close();
  const app = createAddressConsoleApplication(path); cleanups.push(() => app.close());
  const response = app.handle("GET", "/api/v2/discovery/milestone-assessments");
  expect(response.status).toBe(200);
  const body = response.body as { items: Array<{ tokenId: string; state: string; diagnosticZh: string }>; scope: string };
  expect(body.scope).toBe("latest_observed_tokens");
  expect(body.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ tokenId: "base:live", state: "waiting_confirmation" }),
    expect.objectContaining({ tokenId: "base:historical", state: "historical_missing" }),
    expect.objectContaining({ tokenId: "base:unavailable", state: "source_unavailable" }),
    expect.objectContaining({ tokenId: "base:confirmed", state: "milestone_confirmed" }),
    expect.objectContaining({ tokenId: "base:stale", state: "unverified" }),
  ]));
  expect(body.items.find(item => item.tokenId === "base:historical")?.diagnosticZh).toContain("不代表历史未达标");
});
