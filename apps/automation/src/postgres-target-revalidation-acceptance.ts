import { createPostgresForwardTargetAuthorizationRepository, readPostgresFreshForwardTargetAuthorization, refreshPostgresForwardTargetIdentity,
  type LegacyForwardTargetSnapshot, type PostgresTransaction } from "@address-radar/database";
import type { ForwardTargetChannelFact, ForwardTargetPrincipal } from "@address-radar/domain";
import { readPostgresForwardTargetAuthorization } from "./forward-target-authorization.js";
import { createForwardTargetIdentityRefreshWorker } from "./forward-target-identity-refresh.js";
interface Runtime { run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T>; probe(): Promise<unknown>; }
const proof = (condition: unknown, reason: string) => { if (!condition) throw new Error(reason); };
const inventory = async (transaction: PostgresTransaction) => (await transaction.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r' ORDER BY relname")).rows.map(row => String(row.relname));
export async function verifyPostgresTargetRevalidationAcceptance(runtime: Runtime, options: { now: number; setup: (transaction: PostgresTransaction, now: number) => Promise<string> }) {
  await runtime.probe();
  let clock = options.now, backend = 0, owned: string[] = [], cleanupVerified = false;
  const principal: ForwardTargetPrincipal = { actorId: "identity-refresh-fixture", authorizationEvidenceRef: "identity-refresh-fixture-permission", permissions: ["target_registry_write","radar_authorization_write"] };
  const fomo: ForwardTargetChannelFact = { entityId: "refresh-fomo", channel: "fomo", subjectId: "refresh-account", walletFamily: null,
    associationConfidence: "confirmed", associationSource: "acceptance_fixture", ownerCount: 1, walletConfidence: null, walletSource: null,
    identityEvidenceRef: "refresh-identity", ownershipEvidenceRef: "refresh-ownership", monitoringEnabled: true, suspended: false };
  const wallet: ForwardTargetChannelFact = { ...fomo, entityId: "refresh-wallet", channel: "wallet", subjectId: `0x${"ab".repeat(20)}`, walletFamily: "evm", walletConfidence: "confirmed", walletSource: "acceptance_fixture" };
  let fomoFact = fomo, missing = false, unavailable = false, fingerprint = "initial-source", observedAt = clock;
  const assertSession = async (transaction: PostgresTransaction) => { proof(Number((await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid) === backend,"Acceptance session changed"); };
  try {
    const generationId = await runtime.run(async transaction => {
      proof((await inventory(transaction)).length === 0,"Dedicated empty temporary namespace required");
      backend = Number((await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      const generation = await options.setup(transaction,clock);
      const repository = createPostgresForwardTargetAuthorizationRepository(transaction,principal);
      for (const fact of [fomo,wallet]) await repository.recordChannel({ ...fact,versionId: `seed:${fact.entityId}`,effectiveAt: clock,knownAt: clock });
      await repository.recordManual({ authorizationId: "refresh-manual-grant",entityId: fomo.entityId,action: "grant",basisRef: "approved-fixture",effectiveAt: clock,knownAt: clock });
      owned = await inventory(transaction); proof(owned.every(name => /^[a-z_][a-z0-9_]*$/.test(name)),"Invalid temporary inventory"); return generation;
    });
    const source = { read(input: { entityId: string; capturedAt: number }): LegacyForwardTargetSnapshot | null {
      if (input.entityId === fomo.entityId) { if (unavailable) throw new Error("fixture-source-unavailable"); if (missing) return null; }
      return { fact: input.entityId === fomo.entityId ? fomoFact : wallet, sourceObservedAt: observedAt,capturedAt: input.capturedAt,
        sourceFingerprint: `${fingerprint}:${input.entityId}`,proofScope: "legacy_registry_linkage" };
    } };
    const run: Runtime["run"] = operation => runtime.run(async transaction => { await assertSession(transaction); return operation(transaction); });
    const worker = createForwardTargetIdentityRefreshWorker({ run,source,generationId,principal,readAuthorization: readPostgresForwardTargetAuthorization,now: () => clock,perChannelLimit: 1 });
    const fresh = (fact: ForwardTargetChannelFact) => run(transaction => readPostgresFreshForwardTargetAuthorization(transaction,{ ...fact,generationId,asOf: clock },readPostgresForwardTargetAuthorization));
    const tick = () => worker.tick({ fomo: null,wallet: null });
    proof(!(await fresh(fomo)).radarEligible,"Missing refresh receipt allowed a cached grant");
    const initial = await tick(); proof(initial.processed === 2 && initial.verified === 2,"Both target channels did not obtain execution slots");
    proof((await fresh(fomo)).radarEligible && (await fresh(wallet)).monitoringEligible && !(await fresh(wallet)).radarEligible,"FOMO-only and wallet-only qualification changed");
    const beforeAtomic = await run(transaction => createPostgresForwardTargetAuthorizationRepository(transaction).readChannel({ ...fomo,asOf: clock }));
    clock += 1; observedAt = clock; fingerprint = "disabled"; fomoFact = { ...fomo,monitoringEnabled: false };
    let injected = false;
    try {
      await run(transaction => refreshPostgresForwardTargetIdentity({ query: async (sql,values) => {
        if (/INSERT/i.test(sql) && sql.includes("forward_target_identity_refresh_receipts")) { injected = true; throw new Error("Injected refresh receipt failure"); }
        return transaction.query(sql,values);
      } },{ query: { ...fomo,generationId,asOf: clock },source: { status: "available",snapshot: source.read({ entityId: fomo.entityId,capturedAt: clock })! },principal,readAuthorization: readPostgresForwardTargetAuthorization }));
      throw new Error("Expected refresh failure was not thrown");
    } catch (error) { proof(injected && error instanceof Error && error.message === "Injected refresh receipt failure","Unexpected atomic refresh failure"); }
    const afterAtomic = await run(transaction => createPostgresForwardTargetAuthorizationRepository(transaction).readChannel({ ...fomo,asOf: clock }));
    proof(beforeAtomic?.versionId === afterAtomic?.versionId,"Failed receipt partially committed identity change");
    await tick(); proof(!(await fresh(fomo)).radarEligible && (await fresh(wallet)).monitoringEligible,"Disabled FOMO target leaked eligibility or paused wallet channel");
    clock += 1; observedAt = clock; fingerprint = "restored"; fomoFact = fomo; await tick(); proof((await fresh(fomo)).radarEligible,"Valid source recovery did not restore qualification");
    clock += 1; missing = true; const absent = await tick(); proof(absent.sourceMissing === 1 && !(await fresh(fomo)).radarEligible && (await fresh(fomo)).reasonCode === "identity_source_missing","Missing source reused stale eligibility");
    clock += 1; missing = false; unavailable = true; const failed = await tick(); proof(failed.sourceUnavailable === 1 && !(await fresh(fomo)).radarEligible,"Unavailable source reused stale eligibility");
    clock += 1; unavailable = false; await tick(); proof((await fresh(fomo)).radarEligible,"Source retry did not recover");
    clock += 1; proof((await fresh(fomo)).reasonCode === "identity_refresh_required","Old assessment clock was accepted as current"); await tick();
    await run(transaction => createPostgresForwardTargetAuthorizationRepository(transaction,principal).recordManual({ authorizationId: "refresh-manual-revoke",entityId: fomo.entityId,action: "revoke",basisRef: "fixture-revocation",effectiveAt: clock,knownAt: clock }));
    proof((await fresh(fomo)).reasonCode === "authorization_changed_since_refresh","Revocation did not fence an earlier receipt"); await tick(); proof(!(await fresh(fomo)).radarEligible && (await fresh(fomo)).monitoringEligible,"Manual revocation incorrectly stopped monitoring");
    clock += 1; observedAt = clock; fingerprint = "ownership-ambiguous"; fomoFact = { ...fomo,ownerCount: 2 }; await tick(); proof(!(await fresh(fomo)).monitoringEligible,"Ambiguous ownership remained monitorable");
  } finally {
    if (owned.length) await runtime.run(async transaction => {
      await assertSession(transaction); const actual = await inventory(transaction);
      proof(actual.length === owned.length && actual.every(name => owned.includes(name)),"Temporary ownership inventory changed");
      await transaction.query(`DROP TABLE ${owned.map(name => `pg_temp."${name}"`).join(",")} CASCADE`);
      cleanupVerified = (await inventory(transaction)).length === 0; proof(cleanupVerified,"Temporary cleanup failed");
    });
  }
  return { status: "passed",fixtureScope: "synthetic_target_revalidation_temp_session",independentChannelsVerified: true,
    sourceFailureClosedVerified: true,monitoringToggleVerified: true,revocationFenceVerified: true,assessmentClockFenceVerified: true,
    identityReceiptAtomicityVerified: true,ownershipAmbiguityVerified: true,cleanupVerified,businessActivation: false,liveSourceCoverageVerified: false,gatewayDeliveryEnabled: false } as const;
}
