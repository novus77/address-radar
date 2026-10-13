import { performance } from "node:perf_hooks";
import { createPostgresMigrationRuntime, type PostgresMigrationRuntimeOptions } from "../../../packages/database/src/postgres-migration-runtime.js";
import { applyReviewedPostgresCohortImportPlanInTransaction, type PostgresCohortImportPlan,
  type PostgresCohortTransactionApplyOptions } from "./postgres-cohort-import.js";
import { addressOnlyCohortDigest, validateAddressOnlyStartupManifest, verifyAddressOnlyCommittedStartup,
  type AddressOnlyStartupManifest } from "./postgres-address-only-startup.js";

export interface AddressOnlyMigrationOptions {
  /** A fresh dedicated pool is claimed by the native runtime, never an arbitrary or joined UOW. */
  readonly migrationRuntime: Omit<PostgresMigrationRuntimeOptions, "target" | "capability" | "clock">;
  readonly target: PostgresMigrationRuntimeOptions["target"];
  readonly plan: PostgresCohortImportPlan;
  readonly manifest: AddressOnlyStartupManifest;
  readonly capability: PostgresCohortTransactionApplyOptions["capability"];
  readonly budget: PostgresCohortTransactionApplyOptions["budget"];
  readonly assertAuthorized: PostgresCohortTransactionApplyOptions["assertAuthorized"];
  /** Native measurements under the retained source lock, before and after import SQL. */
  readonly measureSourceFence: () => Promise<{
    readonly backupSha256: string; readonly fenceSha256: string;
    readonly gatewayDeliveryEnabled: false; readonly fomoEnabled: false;
    readonly fullHistoricalMiningEnabled: false;
  }>;
  readonly releaseSha256: string;
  readonly onRuntimeClaimed?: () => void;
  readonly signal?: AbortSignal;
}
export class AddressOnlyMigrationCleanupError extends Error {
  constructor(readonly commitState: "committed" | "unknown", readonly committedReceipt: unknown,
    readonly operationError: unknown, readonly cleanupError: unknown) {
    super("address_only_migration:cleanup_failed", { cause: operationError ?? cleanupError });
    this.name = "AddressOnlyMigrationCleanupError";
  }
}
const demand:
 (value: unknown, reason: string) => asserts value = (value, reason) => {
  if (!value) throw new Error(`address_only_migration:${reason}`);
};

/** One commit-awaiting native migration runtime owns this operation. No retry or source restoration
 * occurs here: uncertain commit reconciliation belongs to the retained-lock native parent.
 */
export async function executeDedicatedAddressOnlyMigration(input: AddressOnlyMigrationOptions) {
  const manifest = validateAddressOnlyStartupManifest(input.manifest), plan = input.plan;
  const target = Object.freeze({ ...input.target });
  const capability = structuredClone(input.capability), budget = structuredClone(input.budget);
  demand(plan.kind === "cohort_projection" && "kind" in plan.source && plan.source.kind === "address_only_registry"
    && plan.source.seedSha256 === manifest.seedSha256 && plan.planSha256 === manifest.planSha256
    && plan.generationId === manifest.generationId && plan.importId === manifest.importId
    && plan.profiles.length === manifest.walletCount && plan.quarantine.length === 0
    && new Set(plan.profiles.map(p => p.entityId)).size === manifest.entityCount
    && plan.grantsBusinessEligibility === false, "plan_binding");
  demand(target.database === manifest.target.database && target.schema === manifest.target.schema
    && target.schemaFingerprint === manifest.target.schemaFingerprint && target.systemIdentifier === manifest.target.systemIdentifier
    && target.serverAddress === manifest.target.serverAddress && target.serverPort === manifest.target.serverPort
    && target.generation === manifest.generationId && input.releaseSha256 === manifest.releaseSha256,
  "target_binding");
  demand(capability.kind === "approved_cutover" && capability.purpose === "cohort_projection"
    && capability.planSha256 === plan.planSha256 && capability.authorizationRef === plan.approvalRef
    && Object.keys(target).filter(k => k !== "systemIdentifier").every(k =>
      target[k as keyof typeof target] === capability.target[k as keyof typeof capability.target]), "capability_binding");
  demand(Number.isSafeInteger(budget.maximumTransactionMs) && budget.maximumTransactionMs > 0
    && budget.maximumTransactionMs <= 60000 && Number.isSafeInteger(budget.deadlineAtMs)
    && Number.isSafeInteger(capability.expiresAtMs)
    && [budget.maximumQueriesPerTransaction, budget.maximumTotalQueries].every(v => Number.isSafeInteger(v) && v > 4),
  "budget_binding");
  const started = performance.now();
  const deadlineAtMs = Math.min(budget.deadlineAtMs, capability.expiresAtMs, Date.now() + budget.maximumTransactionMs);
  const check = () => {
    input.signal?.throwIfAborted();
    demand(Date.now() < deadlineAtMs && performance.now() - started < budget.maximumTransactionMs, "deadline");
  };
  check();
  const projected = plan.profiles.map(p => ({ subject_key: p.subjectKey, entity_id: p.entityId,
    wallet_family: p.profile.fact.walletFamily, profile_payload: p.profilePayload,
    import_id: plan.importId, observed_at: p.observedAt }));
  demand(addressOnlyCohortDigest(projected, check) === manifest.cohortSha256, "projected_digest");
  const measure = async () => {
    check(); const measured = await input.measureSourceFence(); check();
    demand(measured.backupSha256 === manifest.backupSha256 && measured.fenceSha256 === manifest.fenceSha256
      && measured.gatewayDeliveryEnabled === false && measured.fomoEnabled === false
      && measured.fullHistoricalMiningEnabled === false, "source_fence_drift");
    return measured;
  };
  // Native recovery takes the same transaction-scoped operation lock before checking ledger absence.
  const remainingMs = Math.floor(deadlineAtMs - Date.now());
  demand(remainingMs > 0 && remainingMs <= 60000, "deadline");
  const configured = input.migrationRuntime.limits;
  const operationTimeoutMs = Math.min(configured.operationTimeoutMs, remainingMs);
  const statementTimeoutMs = Math.min(configured.statementTimeoutMs, operationTimeoutMs);
  // Own construction prevents an outer transaction from acknowledging our callback before COMMIT.
  // Capability expiry and runtime operation budget cover connection, probes, final authorization and COMMIT.
  const runtime = createPostgresMigrationRuntime({ ...input.migrationRuntime, target, clock: Date.now,
    capability: { mode: "approved_cutover", purpose: "business_import", approvalRef: plan.approvalRef,
      planSha256: plan.planSha256, expiresAtMs: deadlineAtMs },
    limits: { ...configured, operationTimeoutMs, statementTimeoutMs,
      connectionTimeoutMs: Math.min(configured.connectionTimeoutMs, operationTimeoutMs),
      lockTimeoutMs: Math.min(configured.lockTimeoutMs, statementTimeoutMs) },
  });
  let receipt: unknown, operationError: unknown;
  try {
  input.onRuntimeClaimed?.();
  const result = await runtime.run(async transaction => {

    check(); await measure();
    await input.assertAuthorized({ capability, planSha256: plan.planSha256,
      generationId: plan.generationId, approvalRef: plan.approvalRef }); check();
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["address-only-v1:" + manifest.operationId]); check();
    const generations = `"${target.schema}"."forward_strategy_generations"`;
    await transaction.query(`INSERT INTO ${generations}(generation_id,activated_at) VALUES($1,$2)
      ON CONFLICT(generation_id) DO NOTHING`, [plan.generationId, manifest.activatedAt]); check();
    const rows = (await transaction.query(`SELECT generation_id,activated_at FROM ${generations}
      WHERE generation_id=$1 FOR UPDATE`, [plan.generationId])).rows; check();
    demand(rows.length === 1 && rows[0]!.generation_id === plan.generationId
      && String(rows[0]!.activated_at) === String(manifest.activatedAt), "generation_conflict");
    const remaining = Math.floor(Math.min(deadlineAtMs - Date.now(), budget.maximumTransactionMs - (performance.now() - started)));
    demand(remaining > 0, "deadline");
    const imported = await applyReviewedPostgresCohortImportPlanInTransaction(plan, {
      transaction, capability, assertAuthorized: input.assertAuthorized,
      budget: { ...budget, deadlineAtMs, maximumTransactionMs: remaining,
        maximumQueriesPerTransaction: budget.maximumQueriesPerTransaction - 4,
        maximumTotalQueries: budget.maximumTotalQueries - 4 },
    }); check();
    demand(imported.commitState === "pending_parent_commit" && imported.quarantinedProfiles === 0
      && imported.stagedProfiles + imported.checkedExistingProfiles === plan.profiles.length, "incomplete_import");
    const measured = await measure();
    const verified = await verifyAddressOnlyCommittedStartup({ manifest, runtime: {
      run: async operation => operation(transaction),
    }, identity: target, releaseSha256: input.releaseSha256,
    backupSha256: measured.backupSha256, fenceSha256: measured.fenceSha256,
    disabledFlags: measured, deadline: new Date(deadlineAtMs).toISOString(),
    ...(input.signal ? { signal: input.signal } : {}),
    }); check();
    return { imported, verified };
  });
  // Returning from the runtime means physical COMMIT was acknowledged, not just callback success.
  const committed = Object.freeze({ protocol: "address-only-v1" as const, commitState: "committed" as const,
    importId: plan.importId, generationId: plan.generationId, walletCount: manifest.walletCount,
    entityCount: manifest.entityCount, cohortSha256: manifest.cohortSha256,
    verification: result.verified, gatewayDeliveryEnabled: false as const,
    activationEnabled: false as const });
  receipt = committed; return committed;
  } catch (error) { operationError = error; throw error; } finally {
    try { await runtime.close(); } catch (cleanupError) {
      throw new AddressOnlyMigrationCleanupError(receipt ? "committed" : "unknown", receipt, operationError, cleanupError);
    }
  }
}
