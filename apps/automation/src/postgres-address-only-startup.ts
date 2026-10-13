import { createHash } from "node:crypto";
import type { PostgresBusinessIdentity, PostgresBusinessRuntime } from "../../../packages/database/src/postgres-business-driver.js";
import { migrationCutoverCanonicalJson } from "../../../packages/database/src/migration-cutover-coordinator.js";

export interface AddressOnlyStartupManifest {
  readonly protocol: "address-only-v1";
  readonly operationId: string;
  readonly importId: string;
  readonly generationId: string;
  readonly activatedAt: number;
  readonly planSha256: string;
  readonly seedSha256: string;
  readonly cohortSha256: string;
  readonly walletCount: number;
  readonly entityCount: number;
  readonly releaseSha256: string;
  readonly backupSha256: string;
  readonly fenceSha256: string;
  readonly target: {
    readonly database: string; readonly schema: string; readonly schemaFingerprint: string;
    readonly systemIdentifier: string; readonly serverAddress: "127.0.0.1"; readonly serverPort: 5432;
  };
  readonly gatewayDeliveryEnabled: false;
  readonly fomoEnabled: false;
  readonly fullHistoricalMiningEnabled: false;
}
const maximumBytes = 4 * 1024 * 1024;
const hashPattern = /^[a-fA-F0-9]{64}$/;
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 512 && !/[\x00-\x1f]/.test(value);
function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`address_only_startup:${code}`);
}
function exactObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireThat(Reflect.ownKeys(value).length === keys.length && keys.every(key => descriptors[key] && "value" in descriptors[key]!), "exact_fields_required");
}
function decimal(value: unknown): string {
  if (typeof value === "number") requireThat(Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0), "invalid_epoch");
  requireThat(typeof value === "string" || typeof value === "number" || typeof value === "bigint", "invalid_epoch");
  const text = String(value);
  requireThat(/^(0|[1-9][0-9]{0,15})$/.test(text) && BigInt(text) <= BigInt(Number.MAX_SAFE_INTEGER), "invalid_epoch");
  return text;
}
export function validateAddressOnlyStartupManifest(value: unknown): AddressOnlyStartupManifest {
  exactObject(value, ["protocol", "operationId", "importId", "generationId", "activatedAt", "planSha256", "seedSha256", "cohortSha256", "walletCount", "entityCount", "releaseSha256", "backupSha256", "fenceSha256", "target", "gatewayDeliveryEnabled", "fomoEnabled", "fullHistoricalMiningEnabled"]);
  requireThat(value.protocol === "address-only-v1", "protocol");
  for (const key of ["operationId", "importId", "generationId"]) requireThat(identifier(value[key]), "label");
  for (const key of ["planSha256", "seedSha256", "cohortSha256", "releaseSha256", "backupSha256", "fenceSha256"]) requireThat(typeof value[key] === "string" && hashPattern.test(value[key]), "hash");
  requireThat(typeof value.activatedAt === "number", "activated_at"); decimal(value.activatedAt);
  requireThat(typeof value.walletCount === "number" && Number.isSafeInteger(value.walletCount) && value.walletCount > 0 && value.walletCount <= 1000, "wallet_count");
  requireThat(typeof value.entityCount === "number" && Number.isSafeInteger(value.entityCount) && value.entityCount > 0 && value.entityCount <= value.walletCount, "entity_count");
  for (const key of ["gatewayDeliveryEnabled", "fomoEnabled", "fullHistoricalMiningEnabled"]) requireThat(value[key] === false, "disabled_flags_required");
  exactObject(value.target, ["database", "schema", "schemaFingerprint", "systemIdentifier", "serverAddress", "serverPort"]);
  const target = value.target;
  requireThat(identifier(target.database), "database");
  requireThat(typeof target.schema === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(target.schema) && !target.schema.startsWith("pg_") && !["public", "pg", "information_schema"].includes(target.schema), "schema");
  requireThat(typeof target.schemaFingerprint === "string" && hashPattern.test(target.schemaFingerprint), "schema_fingerprint");
  requireThat(typeof target.systemIdentifier === "string" && /^[1-9][0-9]{0,19}$/.test(target.systemIdentifier) && BigInt(target.systemIdentifier) <= 18446744073709551615n, "system_identifier");
  requireThat(target.serverAddress === "127.0.0.1" && target.serverPort === 5432, "endpoint");
  // Snapshot caller-owned expectations before awaiting the database.
  return Object.freeze({ ...value, target: Object.freeze({ ...target }) }) as unknown as AddressOnlyStartupManifest;
}

/** Canonical ordered cohort array; bounded unit evidence, never an activation grant. */
export function addressOnlyCohortDigest(rows: readonly Record<string, unknown>[], check: () => void = () => {}): string {
  requireThat(rows.length > 0 && rows.length <= 1000, "cohort_row_limit");
  const digest = createHash("sha256"); digest.update("["); let bytes = 2;
  const ordered = [...rows].sort((a, b) => String(a.subject_key) < String(b.subject_key) ? -1 : String(a.subject_key) > String(b.subject_key) ? 1 : 0);
  for (const [index, row] of ordered.entries()) {
    check();
    for (const key of ["subject_key", "entity_id", "import_id"]) requireThat(identifier(row[key]), "cohort_label");
    requireThat(row.wallet_family === "evm" || row.wallet_family === "solana", "wallet_family");
    requireThat(typeof row.profile_payload === "string" && Buffer.byteLength(row.profile_payload) <= maximumBytes, "profile_payload_limit");
    const encoded = migrationCutoverCanonicalJson({ subject_key: row.subject_key, entity_id: row.entity_id, wallet_family: row.wallet_family,
      profile_payload: row.profile_payload, import_id: row.import_id, observed_at: decimal(row.observed_at) });
    bytes += Buffer.byteLength(encoded) + (index ? 1 : 0); requireThat(bytes <= maximumBytes, "cohort_byte_limit");
    if (index) digest.update(","); digest.update(encoded); check();
  }
  return digest.update("]").digest("hex");
}

export async function verifyAddressOnlyCommittedStartup(options: {
  readonly manifest: unknown;
  readonly runtime: Pick<PostgresBusinessRuntime, "run">;
  readonly identity: PostgresBusinessIdentity;
  /** Independently sealed release measurement, not a value read from the manifest. */
  readonly releaseSha256: string;
  /** Independently measured by trusted startup integration; never copied from the manifest. */
  readonly backupSha256: string;
  readonly fenceSha256: string;
  readonly disabledFlags: {
    readonly gatewayDeliveryEnabled: boolean;
    readonly fomoEnabled: boolean;
    readonly fullHistoricalMiningEnabled: boolean;
  };
  readonly deadline: string;
  readonly signal?: AbortSignal;
}) {
  const manifest = validateAddressOnlyStartupManifest(options.manifest);
  const identity = { ...options.identity }; const target = manifest.target;
  const deadline = Date.parse(options.deadline); const signal = options.signal;
  requireThat(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(options.deadline) && Number.isFinite(deadline), "deadline_iso");
  const check = () => { requireThat(!signal?.aborted, "aborted"); requireThat(Date.now() < deadline, "expired"); };
  check();
  for (const key of ["releaseSha256", "backupSha256", "fenceSha256"] as const)
    requireThat(typeof options[key] === "string" && hashPattern.test(options[key]) && options[key].toLowerCase() === manifest[key].toLowerCase(), `${key}_mismatch`);
  requireThat(options.disabledFlags?.gatewayDeliveryEnabled === false && options.disabledFlags?.fomoEnabled === false && options.disabledFlags?.fullHistoricalMiningEnabled === false, "actual_disabled_flags_required");
  requireThat(identity.database === target.database && identity.schema === target.schema && identity.schemaFingerprint === target.schemaFingerprint && identity.serverAddress === target.serverAddress && identity.serverPort === target.serverPort && identity.generation === manifest.generationId, "probed_identity_mismatch");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("address_only_startup:aborted")); signal?.addEventListener("abort", abort, { once: true });
    const arm = () => { const remaining = deadline - Date.now(); if (remaining <= 0) reject(new Error("address_only_startup:expired")); else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647)); }; arm();
  });
  try {
    return await Promise.race([interrupted, options.runtime.run(async tx => {
      check();
      const schema = `"${target.schema}"`;
      // One statement owns the MVCC snapshot even when runtime probes have already run.
      // Payloads are suppressed on the server before the driver can decode them.
      const result = await tx.query(`WITH
        cohort_raw AS MATERIALIZED (
          SELECT subject_key, entity_id, wallet_family, import_id, observed_at,
            CASE WHEN octet_length(profile_payload) <= $3 THEN profile_payload ELSE NULL END AS profile_payload,
            octet_length(profile_payload) AS payload_bytes,
            octet_length(subject_key) <= 512 AND octet_length(entity_id) <= 512
              AND octet_length(import_id) <= 512 AND octet_length(wallet_family) <= 16 AS labels_bounded
          FROM ${schema}."wallet_service_profile_cohort"
          WHERE generation_id=$1 ORDER BY subject_key COLLATE "C" LIMIT 1001
        ),
        cohort AS MATERIALIZED (
          SELECT * FROM cohort_raw WHERE labels_bounded
            AND (SELECT coalesce(sum(payload_bytes),0) <= $3 FROM cohort_raw)
        ),
        profiles AS MATERIALIZED (
          SELECT subject_key, version_id, enabled, suspended, effective_at, known_at, import_id
          FROM ${schema}."wallet_service_profile_versions" WHERE generation_id=$1 LIMIT 1001
        ),
        relationships AS (
          SELECT c.subject_key,
            (SELECT count(*)=1 AND coalesce(bool_and(
              p.import_id=c.import_id AND p.version_id=c.profile_payload::jsonb->>'versionId'
              AND p.version_id ~ '^address-only:[a-f0-9]{64}$'
              AND p.enabled=(c.profile_payload::jsonb->>'profileEnabled')::boolean
              AND p.suspended=(c.profile_payload::jsonb->>'profileSuspended')::boolean
              AND p.effective_at=c.observed_at AND p.known_at=c.observed_at
              AND c.profile_payload::jsonb->>'provenanceScope'='address_only_registry'
              AND c.profile_payload::jsonb->>'bindingState'='owned'
              AND c.profile_payload::jsonb->'wallet'->>'entityId'=c.entity_id
              AND c.profile_payload::jsonb->'fact'->>'entityId'=c.entity_id
              AND c.profile_payload::jsonb->'fact'->>'walletFamily'=c.wallet_family
              AND (SELECT count(*)=1 AND coalesce(bool_and(
                v.version_id=p.version_id AND v.entity_id=c.entity_id
                AND v.effective_at=p.effective_at AND v.known_at=p.known_at
                AND v.payload::jsonb=c.profile_payload::jsonb->'fact'),false)
                FROM (SELECT version_id,entity_id,effective_at,known_at,payload
                  FROM ${schema}."forward_target_channel_versions"
                  WHERE channel='wallet' AND subject_key=c.subject_key LIMIT 2) v)
              AND (SELECT count(*)=1 AND coalesce(bool_and(
                b.owner_entity_id=c.entity_id AND b.created_by_version=p.version_id
                AND b.created_at=p.known_at AND b.conflict_at IS NULL AND b.conflict_by_version IS NULL),false)
                FROM (SELECT owner_entity_id,created_by_version,created_at,conflict_at,conflict_by_version
                  FROM ${schema}."forward_target_identity_bindings"
                  WHERE channel='wallet' AND subject_key=c.subject_key LIMIT 2) b)
              AND (SELECT count(*)=1 AND coalesce(bool_and(
                h.entity_id=c.entity_id AND h.version_id=p.version_id AND h.head_generation=1),false)
                FROM (SELECT entity_id,version_id,head_generation
                  FROM ${schema}."forward_target_channel_heads"
                  WHERE channel='wallet' AND subject_key=c.subject_key LIMIT 2) h)
            ),false) FROM profiles p WHERE p.subject_key=c.subject_key) AS valid
          FROM cohort c
        ),
        state AS (
          SELECT jsonb_build_object(
            'cluster', (SELECT jsonb_agg(x) FROM (
              SELECT current_database() AS database, pg_catalog.host(inet_server_addr()) AS server_address,
                inet_server_port() AS server_port, system_identifier::text AS system_identifier
              FROM pg_catalog.pg_control_system()) x),
            'generations', (SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (
              SELECT generation_id, activated_at::text AS activated_at
              FROM ${schema}."forward_strategy_generations" WHERE generation_id=$1 LIMIT 2) x),
            'ledger', (SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (
              SELECT import_id,generation_id,source_fingerprint,proof_scope,revoked_at
              FROM ${schema}."wallet_service_import_ledger" WHERE import_id=$2 AND generation_id=$1 LIMIT 2) x),
            'cohort', (SELECT coalesce(jsonb_agg(x ORDER BY x.subject_key COLLATE "C"),'[]'::jsonb) FROM (
              SELECT subject_key,entity_id,wallet_family,profile_payload,import_id,observed_at::text AS observed_at FROM cohort) x),
            'related_valid', (SELECT count(*)=$4 AND coalesce(bool_and(valid),false) FROM relationships)
              AND (SELECT count(*)=$4 FROM profiles)
              AND (SELECT count(*)=$4 AND coalesce(bool_and(labels_bounded AND profile_payload IS NOT NULL),false) FROM cohort_raw)
          ) AS body
        ) SELECT CASE WHEN octet_length(body::text) <= $3 THEN body ELSE NULL END AS snapshot FROM state`,
        [manifest.generationId, manifest.importId, maximumBytes, manifest.walletCount]);
      check();
      requireThat(result.rows.length === 1 && result.rows[0]!.snapshot !== null && typeof result.rows[0]!.snapshot === "object", "snapshot_bound");
      const snapshot = result.rows[0]!.snapshot as Record<string, unknown>;
      requireThat(Buffer.byteLength(migrationCutoverCanonicalJson(snapshot)) <= maximumBytes, "snapshot_bound");
      requireThat(Array.isArray(snapshot.cluster) && Array.isArray(snapshot.generations) && Array.isArray(snapshot.ledger) && Array.isArray(snapshot.cohort), "snapshot_shape");
      const cluster = snapshot.cluster as Record<string, unknown>[];
      const generations = snapshot.generations as Record<string, unknown>[];
      const ledger = snapshot.ledger as Record<string, unknown>[];
      const rows = snapshot.cohort as Record<string, unknown>[];
      requireThat(cluster.length === 1 && cluster[0]!.database === target.database && cluster[0]!.server_address === target.serverAddress && cluster[0]!.server_port === target.serverPort && cluster[0]!.system_identifier === target.systemIdentifier, "cluster_mismatch");
      requireThat(generations.length === 1 && generations[0]!.generation_id === manifest.generationId && decimal(generations[0]!.activated_at) === String(manifest.activatedAt), "generation_mismatch");
      requireThat(ledger.length === 1 && ledger[0]!.import_id === manifest.importId && ledger[0]!.generation_id === manifest.generationId && ledger[0]!.source_fingerprint === manifest.planSha256 && ledger[0]!.proof_scope === "address_only_registry" && ledger[0]!.revoked_at === null, "ledger_mismatch");
      requireThat(snapshot.related_valid === true, "related_state");
      requireThat(rows.length === manifest.walletCount && rows.length <= 1000 && rows.every(row => row.import_id === manifest.importId), "cohort_count_or_import");
      requireThat(new Set(rows.map(row => row.subject_key)).size === manifest.walletCount && new Set(rows.map(row => row.entity_id)).size === manifest.entityCount, "cohort_distinct_counts");
      requireThat(addressOnlyCohortDigest(rows, check) === manifest.cohortSha256.toLowerCase(), "cohort_digest"); check();
      return Object.freeze({ protocol: "address-only-v1" as const, walletCount: rows.length, entityCount: manifest.entityCount, generationId: manifest.generationId, importId: manifest.importId, writeAuthorized: false as const, activationEnabled: false as const });
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
