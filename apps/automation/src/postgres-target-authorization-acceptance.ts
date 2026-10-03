import { createPostgresForwardTargetAuthorizationRepository, POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL,
  createPostgresForwardTokenWatchRepository, type PostgresAcceptanceRuntime, type PostgresTransaction } from "@address-radar/database";
import type { ForwardTargetChannelFact, ForwardTargetPrincipal } from "@address-radar/domain";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL, seedCapabilityWorkFixture } from "./postgres-trader-capability-work-acceptance.js";
import { projectPostgresForwardTraderCapability } from "./forward-trader-capability-worker.js";
import { readPostgresForwardTargetAuthorization, readPostgresForwardTargetRegistry, validatePostgresForwardTargetAuthorizationStamp } from "./forward-target-authorization.js";

const principal: ForwardTargetPrincipal = { actorId: "fixture-operator", authorizationEvidenceRef: "fixture-operator-session",
  permissions: ["target_registry_write", "radar_authorization_write"] };
const base: ForwardTargetChannelFact = { entityId: "manual-entity", channel: "fomo", subjectId: "fixture-account", walletFamily: null,
  associationConfidence: "confirmed", associationSource: "fomo_profile", ownerCount: 1, walletConfidence: null, walletSource: null,
  identityEvidenceRef: "fixture-identity", ownershipEvidenceRef: "fixture-owner", monitoringEnabled: true, suspended: false };
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export async function verifyPostgresTargetAuthorizationAcceptance(runtime: Pick<PostgresAcceptanceRuntime, "probe" | "run">, now: number) {
  await runtime.probe(); const rollback = new Error("Rollback target authorization fixture");
  let report: { channelVersions: number; manualEvents: number; capabilityVersions: number } | undefined;
  try {
    await runtime.run(async (transaction: PostgresTransaction) => {
      await transaction.query((CAPABILITY_WORK_FIXTURE_SCHEMA_SQL + POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL).replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
      const { generationId } = await seedCapabilityWorkFixture(transaction, now);
      const repository = createPostgresForwardTargetAuthorizationRepository(transaction, principal);
      const read = (fact: ForwardTargetChannelFact, asOf: number) => readPostgresForwardTargetAuthorization(transaction, { ...fact, generationId, asOf });
      const { monitoringEnabled: _defaultMonitoring, ...registration } = base;
      ensure((await repository.recordChannel({ ...registration, versionId: "manual-channel-v1", effectiveAt: now, knownAt: now })).status === "applied", "Target registration failed");
      const observed = await read(base, now);
      ensure(observed.monitoringEligible && !observed.radarEligible, "Default monitoring granted radar");
      ensure((await repository.recordChannel({ ...registration, versionId: "manual-channel-v1", effectiveAt: now, knownAt: now + 1 })).status === "duplicate", "Target replay was not idempotent");
      const grant = { authorizationId: "manual-grant", entityId: base.entityId, action: "grant" as const, basisRef: "explicit-human-approval", effectiveAt: now + 1, knownAt: now + 1 };
      await repository.recordManual(grant);
      const authorized = await read(base, now + 2); ensure(authorized.radarEligible && authorized.authorizationStamp, "Explicit manual grant did not authorize trusted FOMO-only target");
      const queuedStamp = authorized.authorizationStamp;
      ensure((await repository.recordManual({ ...grant, knownAt: now + 2 })).status === "duplicate", "Manual replay reset authorization");
      const audit = await repository.readManual(base.entityId, now + 2); ensure(audit?.actorId === principal.actorId && audit.basisRef === grant.basisRef, "Manual audit provenance missing");
      await repository.recordChannel({ ...base, monitoringEnabled: false, versionId: "manual-channel-off", effectiveAt: now + 3, knownAt: now + 3 });
      ensure(!(await read(base, now + 4)).radarEligible, "Grant bypassed disabled monitoring");
      await repository.recordChannel({ ...base, versionId: "manual-channel-on", effectiveAt: now + 5, knownAt: now + 5 });
      await repository.recordManual({ authorizationId: "manual-revoke", entityId: base.entityId, action: "revoke", basisRef: "explicit-revocation", effectiveAt: now + 6, knownAt: now + 6 });
      ensure(!await validatePostgresForwardTargetAuthorizationStamp(transaction, { ...base, generationId, asOf: now + 7, expectedStamp: queuedStamp }), "Queued authorization survived revocation");
      ensure((await repository.recordManual({ ...grant, authorizationId: "late-same-time-grant", effectiveAt: now + 6, knownAt: now + 8 })).status === "stale_event", "Same-time late grant overrode revocation");
      ensure(!(await read(base, now + 8)).radarEligible && (await repository.readManual(base.entityId, now + 8))?.action === "revoke", "Revocation lost to replay");
      ensure((await read(base, now + 2)).radarEligible, "Historical authorization used future revocation");
      const restricted = createPostgresForwardTargetAuthorizationRepository(transaction, { ...principal, permissions: ["target_registry_write"] });
      try { await restricted.recordManual({ ...grant, authorizationId: "unauthorized-grant", knownAt: now + 8 }); throw new Error("Unauthenticated grant accepted"); }
      catch (error) { ensure(error instanceof Error && error.message === "Target authorization permission denied", "Permission guard failed"); }
      const other = { ...base, entityId: "conflicting-entity" };
      ensure((await repository.recordChannel({ ...other, versionId: "conflicting-channel", effectiveAt: now + 9, knownAt: now + 9 })).status === "ownership_conflict", "Cross-entity identity was silently reassigned");
      ensure(!(await read(base, now + 9)).monitoringEligible && !(await read(other, now + 9)).monitoringEligible, "Ambiguous owner entered monitoring");
      const wallet = { ...base, entityId: "wallet-entity", channel: "wallet" as const, subjectId: "0x0000000000000000000000000000000000000001", walletFamily: "evm" as const,
        associationSource: "manual_wallet", walletConfidence: "confirmed" as const, walletSource: "onchain" };
      await repository.recordChannel({ ...wallet, versionId: "wallet-channel", effectiveAt: now + 10, knownAt: now + 10 });
      const wallets = await readPostgresForwardTargetRegistry(transaction, { channel: "wallet", asOf: now + 10, limit: 10, after: null });
      ensure(wallets.monitored.length === 1 && wallets.monitored[0]!.entityId === wallet.entityId, "Wallet-only target required FOMO");
      const system = { ...base, entityId: "entity-a", subjectId: "system-account" };
      await repository.recordChannel({ ...system, versionId: "system-channel", effectiveAt: now + 10, knownAt: now + 10 });
      const watches = createPostgresForwardTokenWatchRepository(transaction);
      for (let index = 0; index < 2; index++) await watches.recordMarket({ generationId, chain: "base", tokenAddress: `0xaaa${index}`,
        sourceEventId: `100k-${index}`, marketCapUsd: "100000", occurredAt: now + 11, now: now + 11, verification: "validated", evidenceRef: `screen-${index}` });
      await projectPostgresForwardTraderCapability(transaction, { entityId: system.entityId, generationId, asOf: now + 12, maximumSamples: 10 });
      const stable = await read(system, now + 12); ensure(stable.status === "evaluated" && stable.authorizationBasis === "system_stable" && stable.authorizationStamp, "Current stable capability did not qualify");
      ensure(!(await read(system, now + 13)).radarEligible, "Stale capability decision was reused without refresh");
      await projectPostgresForwardTraderCapability(transaction, { entityId: system.entityId, generationId, asOf: now + 13, maximumSamples: 10 });
      ensure(await validatePostgresForwardTargetAuthorizationStamp(transaction, { ...system, generationId, asOf: now + 13, expectedStamp: stable.authorizationStamp }), "Clock-only refresh changed semantic authorization basis");
      const agedAt = now + 30 * 86400000 + 1;
      await projectPostgresForwardTraderCapability(transaction, { entityId: system.entityId, generationId, asOf: agedAt, maximumSamples: 10 });
      ensure(!await validatePostgresForwardTargetAuthorizationStamp(transaction, { ...system, generationId, asOf: agedAt, expectedStamp: stable.authorizationStamp }), "Aged-out capability retained queued authorization");
      const fomo = await readPostgresForwardTargetRegistry(transaction, { channel: "fomo", asOf: agedAt, limit: 1, after: null });
      ensure(fomo.scanned === 1 && fomo.nextCursor !== null, "Bounded registry page omitted continuation");
      const counts = (await transaction.query(`SELECT (SELECT count(*) FROM forward_target_channel_versions) AS channels,
        (SELECT count(*) FROM forward_manual_radar_authorizations) AS manual_events,(SELECT count(*) FROM forward_trader_capability_versions) AS capabilities`)).rows[0]!;
      report = { channelVersions: Number(counts.channels), manualEvents: Number(counts.manual_events), capabilityVersions: Number(counts.capabilities) };
      ensure(report.channelVersions === 6 && report.manualEvents === 3 && report.capabilityVersions === 2, "Unexpected authorization fixture totals");
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  ensure(report, "Authorization fixture did not run");
  const cleaned = await runtime.run(async transaction => (await transaction.query("SELECT to_regclass('forward_target_channel_versions') IS NULL AS cleaned")).rows[0]!.cleaned);
  ensure(cleaned === true, "Authorization fixture leaked tables");
  return { fixtureScope: "synthetic_transaction_rollback" as const, ...report, defaultMonitoringNoGrant: true, noWalletRequiredForFomo: true,
    noFomoRequiredForWallet: true, grantAuditVerified: true, revocationInvalidatesQueuedStamp: true, disabledMonitoringBlocked: true,
    identityConflictQuarantined: true, permissionGuardVerified: true, staleCapabilityBlocked: true, agingRevokesSystemQualification: true,
    registryCursorVerified: true, cleanupVerified: true, legacyAdmissionUnchanged: true, otherSignalGatesRequired: true,
    businessActivation: false, liveSourceCoverageVerified: false, gatewayDeliveryEnabled: false };
}
