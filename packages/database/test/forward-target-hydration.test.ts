import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyForwardTargetSnapshotReader, migrateAddressRadarDatabase, openAddressRadarDatabase } from "@address-radar/database";
import { forwardTargetIdentityTrusted } from "@address-radar/domain";

const directories: string[] = [];
const walletAddress = `0x${"ab".repeat(20)}`;
afterEach(() => { for (const path of directories.splice(0)) rmSync(path,{ recursive: true,force: true }); });
const fixture = (confidence = "confirmed",source = "manual") => {
  const directory = mkdtempSync(join(tmpdir(),"radar-identity-proof-")); directories.push(directory);
  const path = join(directory,"identity.sqlite"),database = openAddressRadarDatabase(path); migrateAddressRadarDatabase(database);
  database.prepare("INSERT INTO trader_entities VALUES('entity','probation',1,0,1,1)").run();
  database.prepare("INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES('account','Trader',1,1)").run();
  database.prepare("INSERT INTO entity_accounts VALUES('entity','account',?,?,1,1)").run(confidence,source);
  database.prepare("INSERT INTO trader_profiles VALUES('entity','Trader','important','ordinary note',1,1,1,1,1)").run();
  return { database,reader: createLegacyForwardTargetSnapshotReader(path),key: { entityId: "entity",channel: "fomo" as const,subjectId: "account",walletFamily: null,capturedAt: 100 } };
};
describe("read-only legacy forward target proofs", () => {
  it("hydrates confirmed FOMO without a wallet and does not write source rows", () => {
    const { database,reader,key } = fixture();
    try { const before = database.prepare("SELECT total_changes() AS n").get(); const result = reader.read(key)!;
      expect(forwardTargetIdentityTrusted(result.fact)).toBe(true); expect(result.fact.walletConfidence).toBeNull();
      expect(result.proofScope).toBe("legacy_registry_linkage"); expect(reader.read({ ...key,capturedAt: 101 })?.sourceFingerprint).toBe(result.sourceFingerprint);
      expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    } finally { database.close(); }
  });
  it("does not trust high confidence without a trusted wallet", () => {
    const { database,reader,key } = fixture("high","fomo_stream");
    try { expect(forwardTargetIdentityTrusted(reader.read(key)!.fact)).toBe(false); } finally { database.close(); }
  });
  it("reuses the high-confidence fomolens manual wallet exception", () => {
    const { database,reader,key } = fixture("high","fomo_stream");
    try { database.prepare("INSERT INTO wallet_identities VALUES('account','evm',?,'high','fomolens_manual',1,1)").run(walletAddress);
      expect(forwardTargetIdentityTrusted(reader.read(key)!.fact)).toBe(true);
    } finally { database.close(); }
  });
  it("does not manufacture a FOMO target from a wallet placeholder", () => {
    const { database,reader,key } = fixture("confirmed","manual_wallet");
    try { expect(forwardTargetIdentityTrusted(reader.read(key)!.fact)).toBe(false); } finally { database.close(); }
  });
  it("hydrates a wallet-only direct owner with normalized EVM identity", () => {
    const { database,reader,key } = fixture();
    try { database.prepare("INSERT INTO entity_wallet_identities VALUES('entity','evm',?,'confirmed','manual',1,1)").run(walletAddress);
      const result = reader.read({ ...key,channel: "wallet",subjectId: `0x${"AB".repeat(20)}`,walletFamily: "evm" })!;
      expect(result.fact.subjectId).toBe(walletAddress); expect(forwardTargetIdentityTrusted(result.fact)).toBe(true);
    } finally { database.close(); }
  });
  it("keeps ownership ambiguity and disabled monitoring visible", () => {
    const { database,reader,key } = fixture();
    try { database.prepare("INSERT INTO trader_entities VALUES('other','probation',1,0,1,1)").run();
      database.prepare("INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES('other-account','OtherTrader',1,1)").run();
      database.prepare("INSERT INTO entity_accounts VALUES('other','other-account','confirmed','manual',1,1)").run();
      database.prepare("INSERT INTO wallet_identities VALUES('other-account','evm',?,'confirmed','manual',1,1)").run(walletAddress);
      database.prepare("INSERT INTO entity_wallet_identities VALUES('entity','evm',?,'confirmed','manual',1,1)").run(walletAddress);
      database.prepare("UPDATE trader_profiles SET monitoring_enabled=0,updated_at=2 WHERE entity_id='entity'").run();
      const result = reader.read({ ...key,channel: "wallet",subjectId: walletAddress,walletFamily: "evm" })!; expect(result.fact.ownerCount).toBe(2); expect(result.fact.monitoringEnabled).toBe(false);
      expect(forwardTargetIdentityTrusted(result.fact)).toBe(false);
    } finally { database.close(); }
  });
  it("requires existing subjects and rejects a future source clock", () => {
    const { database,reader,key } = fixture();
    try { expect(reader.read({ ...key,subjectId: "missing" })).toBeNull();
      database.prepare("UPDATE trader_profiles SET updated_at=101 WHERE entity_id='entity'").run();
      expect(() => reader.read(key)).toThrow("source clock is in the future");
    } finally { database.close(); }
  });
});
