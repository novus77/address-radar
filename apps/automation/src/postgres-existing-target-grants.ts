import { createPostgresBusinessProvisioningPlan,
  type PostgresBusinessProvisioningOptions } from "../../../packages/database/src/postgres-business-provisioning.js";
import { createPostgresServiceSchema, createPostgresServiceSchemaGrantPlan } from "./postgres-service-schema.js";

/** Offline composition only. Login, credential installation and cutover remain separate gates. */
export function createExistingPostgresTargetGrantPlan(
  options: Omit<PostgresBusinessProvisioningOptions, "schemaPlan" | "trustedModules" | "archive">,
) {
  if (!options || Object.keys(options).some(key => ["schemaPlan", "trustedModules", "archive"].includes(key))) {
    throw new Error("Existing-target grants require code-owned schema definitions without archives");
  }
  const definition = createPostgresServiceSchema({ protocolVersion: 2 });
  const provisioning = createPostgresBusinessProvisioningPlan({ ...options,
    schemaPlan: definition.plan, trustedModules: definition.trustedModules });
  const base = provisioning.phases.find(phase => phase.id === "post-schema-grants");
  if (!base || base.connectionDatabase !== options.database || !base.transactional) {
    throw new Error("Existing-target grant phase is missing or bound to another database");
  }
  const supplemental = createPostgresServiceSchemaGrantPlan({ protocolVersion: 2,
    schema: options.schema, migratorRole: options.migratorRole, serviceRoles: options.serviceRoles });
  if (supplemental.schemaFingerprint !== definition.plan.fingerprint) {
    throw new Error("Existing-target schema grant fingerprint mismatch");
  }
  return Object.freeze({ mode: "offline-existing-target-grants" as const,
    productionMigrationReady: false as const, activationAuthorized: false as const,
    requiresIndependentPrivilegeProbe: true as const, requiresExistingRoleLockdown: true as const,
    requiresInstalledSchemaFingerprint: definition.plan.fingerprint,
    schemaVersion: definition.plan.version, database: options.database, schema: options.schema,
    statements: Object.freeze([...new Set([...base.statements, ...supplemental.statements])]),
    resourcePolicyFingerprint: provisioning.resourcePolicyFingerprint });
}
