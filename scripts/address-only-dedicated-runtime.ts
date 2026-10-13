/** Native controller module surface. Loading this module never connects or selects a backend. */
export { createReviewedPostgresAddressOnlyImportPlan, postgresCohortImportFingerprint } from "../apps/automation/src/postgres-cohort-import.js";
export { executeDedicatedAddressOnlyMigration } from "../apps/automation/src/postgres-address-only-migration.js";
export { addressOnlyCohortDigest, verifyAddressOnlyCommittedStartup } from "../apps/automation/src/postgres-address-only-startup.js";
