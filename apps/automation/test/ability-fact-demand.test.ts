import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateAddressRadarDatabase } from "@address-radar/database";
import { createTraderAbilityWorker } from "../src/trader-ability-worker.js";

describe("live ability coverage demands", () => {
  it("persists a verified partial hit without declaring full-range recovery complete", async () => {
    const db = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(db);
    db.prepare("INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES ('account','test',1,1)").run();
    db.prepare("INSERT INTO trader_entities(entity_id,lifecycle,manual,locked,created_at,updated_at) VALUES ('trader','candidate',0,0,1,1)").run();
    db.prepare(`INSERT INTO trader_events(event_id,account_id,entity_id,chain,token_address,side,amount_usd,price_usd,market_cap_usd,token_age_ms,occurred_at,collected_at,source)
      VALUES ('buy','account','trader','solana','MintAbC','buy',100,1,NULL,NULL,100,100,'onchain_wallet')`).run();
    db.prepare("INSERT INTO market_observations(chain,token_address,observed_at,price_usd,source) VALUES ('solana','MintAbC',200,5,'test')").run();
    const worker = createTraderAbilityWorker({ database: db, now: () => 300 });
    await worker.execute({ payload: JSON.stringify({ traderId: "trader", evaluatedAt: 300 }), cursor: null } as never, new AbortController().signal);
    const rows = db.prepare("SELECT purpose,status,token_id AS tokenId,required_from AS requiredFrom,required_to AS requiredTo FROM consumer_fact_demands ORDER BY purpose").all();
    expect(rows).toEqual([
      { purpose: "complete_range", status: "pending", tokenId: "solana:MintAbC", requiredFrom: 100, requiredTo: 300 },
      { purpose: "positive_hit", status: "satisfied", tokenId: "solana:MintAbC", requiredFrom: 100, requiredTo: 300 },
    ]);
    const proof = JSON.parse((db.prepare("SELECT payload FROM consumer_fact_demands WHERE purpose='positive_hit'").get() as { payload: string }).payload).proof;
    expect(proof).toMatchObject({ from: 100, to: 200, knownAt: 300, maximumMultiple: 5 });
    expect(proof.reference).toContain("test");
    db.close();
  });
});
