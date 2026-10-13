import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReviewedPostgresAddressOnlyImportPlan, postgresCohortImportFingerprint } from "../src/postgres-cohort-import.js";

function fixture() {
  const seed = { format: "address-only-seed-v1", capturedAt: "2026-10-07T12:00:00Z",
    rules: { historicalEvidenceImported: false, historicalJobsImported: false, legacyLifecycleIsNotNewCapabilityProof: true,
      gatewayDeliveryEnabled: false, activationAuthorizedByExport: false },
    tables: { fomo_accounts: [{ account_id: "account", handle: "trader" }],
      entity_accounts: [{ account_id: "account", entity_id: "entity", confidence: "high", source: "fomolens_manual" }],
      wallet_identities: [{ account_id: "account", chain_family: "evm", address: "0x" + "aB".repeat(20), confidence: "high", source: "fomolens_manual" }],
      trader_entities: [{ entity_id: "entity", lifecycle: "elite", manual: 1, locked: 0 }],
      trader_profiles: [{ entity_id: "entity", display_name: "Trader", priority: "normal", notes: "Keep", monitoring_enabled: 0,
        fomo_monitoring_enabled: 1, onchain_monitoring_enabled: 0 }],
      trader_monitoring_policy: [{ trader_id: "entity", policy: "off" }] } };
  function plan() {
    const rawSeed = JSON.stringify(seed);
    const review = { importId: "import", approvalRef: "approval", actorId: "actor", actorAuthorizationRef: "auth", generationId: "generation",
      importedAt: Date.parse(seed.capturedAt) + 1000, seedSha256: createHash("sha256").update(rawSeed).digest("hex") };
    return createReviewedPostgresAddressOnlyImportPlan({ rawSeed, review, trustedReviewSha256: postgresCohortImportFingerprint(review) });
  }
  return { seed, plan };
}
describe("address-only reviewed import", () => {
  it("preserves settings and provenance without inheriting ability or requiring a historical crosswalk", () => {
    const p = fixture().plan(), item = p.profiles[0]!;
    expect(p.grantsBusinessEligibility).toBe(false);
    expect(item.profile.wallet.lifecycle).toBe("candidate");
    expect(item.profile.wallet.address).toBe("0x" + "ab".repeat(20));
    expect(item.profile.profileEnabled).toBe(false);
    expect(item.profile.fact.monitoringEnabled).toBe(false);
    const payload = JSON.parse(item.profilePayload);
    expect(payload.provenance.monitoringPolicy.policy).toBe("off");
    expect(payload.provenance.entity.lifecycle).toBe("elite");
    expect(Object.isFrozen(p.profiles)).toBe(true);
  });
  it("preserves suspension", () => {
    const f = fixture(); f.seed.tables.trader_entities[0]!.lifecycle = "suspended";
    expect(f.plan().profiles[0]!.profile.profileSuspended).toBe(true);
  });
  it("rejects duplicate owners and normalized duplicate wallets", () => {
    const f = fixture(); f.seed.tables.entity_accounts.push({ ...f.seed.tables.entity_accounts[0]! });
    expect(f.plan).toThrow(/duplicate/);
    const g = fixture(); g.seed.tables.wallet_identities.push({ ...g.seed.tables.wallet_identities[0]!, address: "0x" + "ab".repeat(20) });
    expect(g.plan).toThrow(/duplicate/);
  });
  it("rejects historical tables and changed export authority", () => {
    const f = fixture(); Object.assign(f.seed.tables, { market_observations: [] });
    expect(f.plan).toThrow(/table_allowlist/);
    const g = fixture(); g.seed.rules.gatewayDeliveryEnabled = true;
    expect(g.plan).toThrow(/seed_authority/);
  });
  it("rejects unverified wallets and orphan settings", () => {
    const f = fixture(); f.seed.tables.wallet_identities[0]!.confidence = "low";
    expect(f.plan).toThrow(/unverified_wallet/);
    const g = fixture(); g.seed.tables.trader_monitoring_policy.length = 0;
    expect(g.plan).toThrow(/incomplete_settings/);
  });
});
