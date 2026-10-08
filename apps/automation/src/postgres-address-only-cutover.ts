import { createMigrationCutoverCoordinator, migrationCutoverCanonicalJson, migrationCutoverDigest,
  type CutoverCommand, type WriterFenceBundle, type WriterFencePolicy,
  type CutoverTransitionStore } from "../../../packages/database/src/migration-cutover-coordinator.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import { applyReviewedPostgresCohortImportPlanInTransaction,
  type PostgresCohortImportPlan, type PostgresCohortTransactionApplyOptions } from "./postgres-cohort-import.js";

export interface AddressOnlyFirstWriteOptions {
  readonly expected: WriterFencePolicy;
  readonly store: CutoverTransitionStore;
  readonly clock: () => string;
  readonly command: CutoverCommand;
  readonly bundle: WriterFenceBundle;
  readonly plan: PostgresCohortImportPlan;
  /** Explicit target-generation timestamp in epoch milliseconds, never a source-history clock.
   * Registering this boundary does not authorize service activation or signal delivery.
   */
  readonly activatedAt: number;
  readonly capability: PostgresCohortTransactionApplyOptions["capability"];
  readonly budget: PostgresCohortTransactionApplyOptions["budget"];
  readonly assertAuthorized: PostgresCohortTransactionApplyOptions["assertAuthorized"];
  /** Trusted native port: measure provider and delivery guards in this transaction and throw on drift.
   * A successful return must not be implemented as a caller-supplied readiness boolean.
   */
  readonly verifyGuardsInTransaction: (transaction: PostgresTransaction,
    guards: WriterFencePolicy["guards"]) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Commit ownership, signature verification, fencing and first-write markers remain in the coordinator.
 * This adapter cannot activate services and never catches an uncertain commit for automatic replay.
 */
export async function executeAddressOnlyFirstPostgresWrite(options: AddressOnlyFirstWriteOptions) {
  const copy = <T>(value: T): T => JSON.parse(migrationCutoverCanonicalJson(value)) as T;
  const expected = copy(options.expected), command = copy(options.command), capability = copy(options.capability);
  const bundle = copy(options.bundle), budget = copy(options.budget), plan = options.plan;
  const activatedAt = options.activatedAt;
  const target = expected.binding.target;
  if (expected.version !== 2 || command.version !== 2 || command.action !== "first-postgres-write"
    || typeof command.writeId !== "string" || !command.writeId
    || plan.kind !== "cohort_projection" || !("kind" in plan.source) || plan.source.kind !== "address_only_registry"
    || plan.importId !== expected.binding.cohortId || plan.generationId !== expected.binding.generation
    || plan.generationId !== target.generation || plan.profiles.length === 0 || plan.quarantine.length !== 0
    || !Number.isSafeInteger(activatedAt) || activatedAt < 0
    || typeof target.schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(target.schema)
    || target.schema.startsWith("pg_") || ["public", "information_schema"].includes(target.schema)
    || capability.kind !== "approved_cutover" || capability.purpose !== "cohort_projection"
    || capability.planSha256 !== plan.planSha256
    || capability.target.generation !== target.generation || capability.target.database !== target.database
    || capability.target.schema !== target.schema || capability.target.schemaFingerprint !== target.schemaSha256
    || capability.target.serverAddress !== target.serverAddress || capability.target.serverPort !== target.serverPort
    || !Number.isSafeInteger(capability.expiresAtMs)
    || capability.expiresAtMs > Date.parse(command.authorization.expiresAt)
    || typeof options.verifyGuardsInTransaction !== "function" || typeof options.assertAuthorized !== "function") {
    throw new Error("address_only_cutover_binding_refused");
  }
  const coordinator = createMigrationCutoverCoordinator({ expected, store: options.store, clock: options.clock });
  return coordinator.execute(command, bundle, {
    ...(options.signal ? { signal: options.signal } : {}),
    async write(transaction, writeId) {
      if (writeId !== command.writeId) throw new Error("address_only_cutover_write_id_mismatch");
      const startedAt = Date.now(), generationQueries = 2;
      for (const [limit, maximum] of [[budget.maximumQueriesPerTransaction, 100_000],
        [budget.maximumTotalQueries, 10_000_000]]) {
        if (!Number.isSafeInteger(limit) || limit! <= generationQueries || limit! > maximum!) {
          throw new Error("address_only_cutover_query_budget_exceeded");
        }
      }
      if (!Number.isSafeInteger(budget.maximumTransactionMs) || budget.maximumTransactionMs <= 0
        || budget.maximumTransactionMs > 60_000 || !Number.isSafeInteger(budget.deadlineAtMs)
        || budget.deadlineAtMs <= 0) throw new Error("address_only_cutover_execution_budget");
      const deadlineAtMs = Math.min(budget.deadlineAtMs, Date.parse(command.deadline),
        Date.parse(command.authorization.expiresAt));
      const check = () => {
        const now = Date.now();
        if (!(now < deadlineAtMs)) throw new Error("address_only_cutover_deadline_exceeded");
        if (!(now < capability.expiresAtMs)) throw new Error("address_only_cutover_capability_expired");
        if (!(now - startedAt < budget.maximumTransactionMs)) throw new Error("address_only_cutover_transaction_deadline");
        return now;
      };
      // Reserve registration SQL locally; the original parent port still enforces its global budget.
      const extraSQL: PostgresTransaction["query"] = async (sql, values) => {
        check();
        const result = await transaction.query(sql, values);
        check();
        return result;
      };
      check();
      await options.verifyGuardsInTransaction(transaction, copy(expected.guards));
      check();
      // The importer repeats this check; generation registration must also be denied before any write.
      await options.assertAuthorized({ capability, planSha256: plan.planSha256,
        generationId: plan.generationId, approvalRef: plan.approvalRef });
      const generations = `"${target.schema}"."forward_strategy_generations"`;
      await extraSQL(`INSERT INTO ${generations}(generation_id,activated_at) VALUES($1,$2)
        ON CONFLICT(generation_id) DO NOTHING`, [plan.generationId, activatedAt]);
      const generation = (await extraSQL(
        `SELECT generation_id,activated_at FROM ${generations} WHERE generation_id=$1 FOR UPDATE`,
        [plan.generationId])).rows;
      if (generation.length !== 1 || generation[0]!.generation_id !== plan.generationId
        || (generation[0]!.activated_at !== activatedAt && generation[0]!.activated_at !== String(activatedAt))) {
        throw new Error("address_only_cutover_generation_conflict");
      }
      const importStartedAt = check();
      const imported = await applyReviewedPostgresCohortImportPlanInTransaction(plan, {
        transaction, capability, budget: { ...budget,
          maximumQueriesPerTransaction: budget.maximumQueriesPerTransaction - generationQueries,
          maximumTotalQueries: budget.maximumTotalQueries - generationQueries,
          maximumTransactionMs: budget.maximumTransactionMs - (importStartedAt - startedAt),
          // Keep the original elapsed-time boundary even while the importer authenticates its capability.
          deadlineAtMs: Math.min(deadlineAtMs, startedAt + budget.maximumTransactionMs),
        }, assertAuthorized: options.assertAuthorized,
      });
      check();
      if (imported.commitState !== "pending_parent_commit" || imported.quarantinedProfiles !== 0
        || imported.stagedProfiles + imported.checkedExistingProfiles !== plan.profiles.length) {
        throw new Error("address_only_cutover_incomplete_import");
      }
      await options.verifyGuardsInTransaction(transaction, copy(expected.guards));
      const elapsedMs = check() - startedAt;
      const accounting = { ...imported, queries: imported.queries + generationQueries, elapsedMs };
      return { writeId, receiptSha256: migrationCutoverDigest({ importId: plan.importId,
        generationId: plan.generationId, activatedAt, planSha256: plan.planSha256, source: plan.source, imported: accounting }, 2),
      providerGuardSha256: migrationCutoverDigest(expected.guards.filter(guard => guard.kind === "provider")),
      deliveryGuardSha256: migrationCutoverDigest(expected.guards.filter(guard => guard.kind === "delivery")) };
    },
  });
}
