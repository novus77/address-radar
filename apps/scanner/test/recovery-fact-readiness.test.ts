import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createTokenFactStore, migrateAddressRadarDatabase } from "@address-radar/database";
import { verifyRecoveryFactReadiness } from "../src/recovery-fact-readiness.js";

const HOUR = 3_600_000;
function setup() {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  const facts = createTokenFactStore(database);
  facts.ensure("solana:MintAbC", "price_history", "test", 1);
  facts.transition({ tokenId: "solana:MintAbC", factType: "price_history", status: "available",
    precision: "derived", primarySource: "test", observedAt: 1, strategyVersion: "test", updatedAt: 1 });
  return { database, facts };
}

describe("recovery canonical postconditions", () => {
  it("does not substitute available metadata for actual requested price coverage", () => {
    const { database, facts } = setup();
    const input = { database, facts, factType: "price_history" as const, tokenId: "solana:MintAbC",
      asOf: HOUR * 5, priceRange: { fromAt: HOUR, toAt: HOUR * 4 } };
    expect(verifyRecoveryFactReadiness(input).status).toBe("deferred");
    database.prepare("INSERT INTO market_observations VALUES ('solana','MintAbC',?,1,'test')").run(HOUR);
    database.prepare("INSERT INTO market_observations VALUES ('solana','MintAbC',?,5,'test')").run(HOUR * 4);
    expect(verifyRecoveryFactReadiness(input).status).toBe("deferred");
    database.prepare("INSERT INTO market_observations VALUES ('solana','MintAbC',?,2,'test')").run(HOUR * 2);
    database.prepare("INSERT INTO market_observations VALUES ('solana','MintAbC',?,3,'test')").run(HOUR * 3);
    expect(verifyRecoveryFactReadiness(input)).toEqual({ status: "satisfied", producedCount: 1 });
    expect(verifyRecoveryFactReadiness({ ...input, tokenId: "solana:Mintabc" }).status).toBe("deferred");
    expect(verifyRecoveryFactReadiness({ ...input, priceRange: { fromAt: HOUR, toAt: HOUR * 10 } }).status).toBe("deferred");
    database.close();
  });

  it("keeps future and phantom milestones pending until a real crossing exists", () => {
    const { database, facts } = setup();
    facts.ensure("base:0xabc", "milestone_crossings", "test", 1);
    facts.transition({ tokenId: "base:0xabc", factType: "milestone_crossings", status: "partial",
      precision: "estimated", primarySource: "test", observedAt: 1, strategyVersion: "test", updatedAt: 1 });
    const input = { database, facts, factType: "milestone_crossings" as const, tokenId: "base:0xabc", asOf: 200 };
    expect(verifyRecoveryFactReadiness(input).status).toBe("deferred");
    database.prepare("INSERT INTO token_milestone_crossings VALUES ('m','base:0xabc',100000,300,'exact','test','[]','test')").run();
    expect(verifyRecoveryFactReadiness(input).status).toBe("deferred");
    database.prepare("UPDATE token_milestone_crossings SET crossed_at=100 WHERE milestone_id='m'").run();
    expect(verifyRecoveryFactReadiness(input).status).toBe("satisfied");
    expect(verifyRecoveryFactReadiness({ ...input, tokenId: "eth:0xabc" }).status).toBe("deferred");
    database.close();
  });

  it("requires a real pre-crossing buy for early trades", () => {
    const { database, facts } = setup();
    const input = { database, facts, factType: "early_trades" as const, tokenId: "base:0xabc", asOf: 200 };
    database.prepare("INSERT INTO trader_entities VALUES ('trader','candidate',0,0,1,1)").run();
    database.prepare("INSERT INTO token_milestone_crossings VALUES ('m','base:0xabc',100000,100,'exact','test','[]','test')").run();
    expect(verifyRecoveryFactReadiness(input).status).toBe("deferred");
    database.prepare(`INSERT INTO canonical_trader_events(canonical_event_id,entity_id,chain,token_address,side,amount_usd,occurred_at,source_status,updated_at)
      VALUES ('buy','trader','base','0xabc','buy',100,150,'FOMO_ONLY',150)`).run();
    expect(verifyRecoveryFactReadiness(input).status).toBe("deferred");
    database.prepare("UPDATE canonical_trader_events SET occurred_at=50 WHERE canonical_event_id='buy'").run();
    expect(verifyRecoveryFactReadiness(input).status).toBe("satisfied");
    database.close();
  });
});
