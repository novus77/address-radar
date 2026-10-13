import { describe, expect, it } from "vitest";
import type { PostgresBusinessRuntime } from "../../../packages/database/src/postgres-business-driver.js";
import { selectPostgresWalletProfiles, preparePostgresWalletCapture, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { createPostgresServiceFactAdapters } from "../src/postgres-service-fact-adapters.js";

const asOf = 100000;
const profile: PostgresWalletProfile = {
  wallet: { address: "11111111111111111111111111111111", accountId: "account", entityId: "entity", lifecycle: "candidate" },
  fact: { entityId: "entity", channel: "wallet", subjectId: "11111111111111111111111111111111", walletFamily: "solana",
    associationConfidence: "high", associationSource: "fomolens_manual", ownerCount: 1, walletConfidence: "high",
    walletSource: "fomolens_manual", identityEvidenceRef: "seed:identity", ownershipEvidenceRef: "seed:wallet", monitoringEnabled: true, suspended: false },
  profileEnabled: true, profileSuspended: false, monitoringPolicy: "realtime", bindingState: "owned", versionId: "version",
};
async function load(policy: unknown, scope = "address_only_registry", payloadScope = scope) {
  const row = { entity_id: "entity", wallet_family: "solana", subject_key: JSON.stringify(["wallet", "solana", profile.wallet.address]),
    proof_scope: scope, imported_at: 90000, observed_at: 90000, import_revoked_at: null, enabled: true, suspended: false,
    profile_known_at: 90000, channel_known_at: 90000, channel_version_id: "version", profile_version_id: "version", import_id: "import",
    owner_entity_id: "entity", conflict_at: null, channel_payload: JSON.stringify(profile.fact),
    profile_payload: JSON.stringify({ ...profile, monitoringPolicy: policy, provenanceScope: payloadScope }) };
  const runtime = { probe: async () => ({ generation: "generation", service: "wallet-monitor" }),
    run: async (fn: (tx: unknown) => unknown) => fn({ query: async () => ({ rows: [row], rowCount: 1 }) }) } as unknown as PostgresBusinessRuntime;
  const ports = await createPostgresServiceFactAdapters({ runtime, generationId: "generation", maximumProfiles: 10, now: () => asOf,
    sources: { leaseMs: 5000, maximumProfileAgeMs: 60000, maximumFactAgeMs: 60000, maximumSafetyAgeMs: 10000,
      providerTimeoutMs: 1000, maximumResponseBytes: 1000, maximumFactPayloadBytes: 20000 } });
  return ports.profiles.load({ generationId: "generation", chainFamily: "solana", asOf, limit: 10, signal: new AbortController().signal });
}
describe("address-only runtime continuity", () => {
  it.each(["periodic", "lightweight", "off"] as const)("does not upgrade %s to realtime monitoring", policy => {
    expect(selectPostgresWalletProfiles([{ ...profile, monitoringPolicy: policy }], "solana")).toEqual([]);
  });
  it("loads the address-only proof scope and preserves its explicit policy", async () => {
    const result = await load("realtime"); expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected ready profiles");
    expect(result.profiles[0]?.monitoringPolicy).toBe("realtime");
    expect(selectPostgresWalletProfiles(result.profiles, "solana")).toHaveLength(1);
  });
  it.each([undefined, "unknown"])("fails closed for a missing or unknown address-only policy", async policy => {
    expect((await load(policy)).status).toBe("deferred");
  });
  it("rejects mismatched provenance and unrecognized import scope", async () => {
    expect((await load("realtime", "address_only_registry", "legacy_registry_linkage")).status).toBe("deferred");
    expect((await load("realtime", "unreviewed")).status).toBe("deferred");
  });
  it("keeps the original legacy realtime profile contract", async () => {
    expect((await load(undefined, "legacy_registry_linkage")).status).toBe("ready");
  });
  it("retains policy at the durable capture boundary", () => {
    const result = preparePostgresWalletCapture({ generationId: "generation", collectorId: "solana", sessionId: "session",
      chainFamily: "solana", receivedAt: asOf, profile, executionTrust: "unverified",
      event: { eventId: "event", chain: "solana", walletAddress: profile.wallet.address, tokenAddress: "Token", side: "buy",
        occurredAt: 90000, amountUsd: null, priceUsd: null, marketCapUsd: null, sourceReference: "solana:signature" } });
    expect(result.payload.profile?.monitoringPolicy).toBe("realtime");
  });
});
