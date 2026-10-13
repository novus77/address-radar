import { createHash } from "node:crypto";

/** The caller supplies a dedicated transaction and native query timeout; no pool or DDL is created here. */
export interface PhysicalCatalogPort {
  run<T>(work: (tx: { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>): Promise<T>;
}
export interface PhysicalManifest {
  readonly format: 1;
  readonly schemaVersion: 3;
  readonly planFingerprint: string;
  readonly serverVersion: string;
  readonly objects: readonly Record<string, unknown>[];
}
interface ReadOptions {
  readonly port: PhysicalCatalogPort;
  readonly schema: string;
  readonly maximumTables: number;
  readonly maximumBytes: number;
}
export interface PhysicalReferenceApproval {
  readonly planFingerprint: string;
  readonly manifestSha256: string;
  /** Independently authenticate isolated reference provenance and its complete code-owned v3 plan. */
  verifyReference(input: { manifestSha256: string; planFingerprint: string }): Promise<boolean>;
}
const demand = (value: unknown, code: string): void => { if (!value) throw new Error(code); };
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const CATALOG_SQL = `SELECT /* physical-v3-catalog */ jsonb_build_object(
 'table',t.relname,'kind',t.relkind,'persistence',t.relpersistence,
 'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
   'notNull',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid,false),
   'identity',a.attidentity,'generated',a.attgenerated,
   'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE
     CASE WHEN cn.nspname=$1 THEN '@self' ELSE cn.nspname END||'.'||co.collname END)
   ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
   LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
   LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
   WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
 'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid,false),
   'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred)
   ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=t.oid),'[]'::jsonb),
 'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object(
   'name',ic.relname,'definition',pg_catalog.pg_get_indexdef(i.indexrelid,0,false),
   'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive)
   ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i
   JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=t.oid),'[]'::jsonb)
 ) AS object FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
 WHERE n.nspname=$1 AND t.relkind IN ('r','p','v','m','f','S')
 ORDER BY t.relname COLLATE "C" LIMIT $2`;

async function readCatalog(options: ReadOptions): Promise<{ serverVersion: string; objects: Record<string, unknown>[] }> {
  demand(/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema) && !options.schema.startsWith("pg_"), "invalid_schema");
  demand(Number.isSafeInteger(options.maximumTables) && options.maximumTables > 0 && options.maximumTables <= 4096
    && Number.isSafeInteger(options.maximumBytes) && options.maximumBytes > 0 && options.maximumBytes <= 134217728, "invalid_bounds");
  return options.port.run(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    // Catalog functions take precedence; explicit pg_temp last prevents implicit temporary relation shadowing.
    await tx.query("SELECT pg_catalog.set_config('search_path',$1,true)", [`pg_catalog,"${options.schema}",pg_temp`]);
    const environment = (await tx.query(`SELECT /* physical-v3-environment */
      pg_catalog.current_setting('server_version_num') AS server_version,
      EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1) AS schema_exists`, [options.schema])).rows;
    demand(environment.length === 1 && environment[0]?.schema_exists === true
      && typeof environment[0]?.server_version === "string", "invalid_catalog_environment");
    const rows = (await tx.query(CATALOG_SQL, [options.schema, options.maximumTables + 1])).rows;
    demand(rows.length > 0 && rows.length <= options.maximumTables, "catalog_table_bound");
    demand(Buffer.byteLength(JSON.stringify(rows)) <= options.maximumBytes, "catalog_byte_bound");
    const names = new Set<string>();
    const objects = rows.map(row => {
      demand(row.object !== null && typeof row.object === "object" && !Array.isArray(row.object), "invalid_catalog_object");
      const object = row.object as Record<string, unknown>;
      demand(typeof object.table === "string" && !names.has(object.table) && object.kind === "r" && object.persistence === "p", "unsupported_catalog_relation");
      names.add(object.table as string);
      demand(Array.isArray(object.columns) && object.columns.length > 0 && Array.isArray(object.constraints) && Array.isArray(object.indexes), "invalid_catalog_shape");
      for (const constraint of object.constraints as Record<string, unknown>[]) demand(constraint.validated === true, "unvalidated_constraint");
      for (const index of object.indexes as Record<string, unknown>[]) demand(index.valid === true && index.ready === true && index.live === true, "invalid_index");
      return canonical(object) as Record<string, unknown>;
    });
    demand(objects.some(object => !["business_schema_identity", "business_schema_ledger"].includes(object.table as string)), "ledger_only_catalog");
    objects.sort((a, b) => (a.table as string) < (b.table as string) ? -1 : 1);
    return { serverVersion: environment[0]!.server_version as string, objects };
  });
}
/** Candidate export only. This function does not certify that the reference schema is trustworthy. */
export async function exportPostgresV3PhysicalReference(options: ReadOptions & { readonly planFingerprint: string }): Promise<PhysicalManifest> {
  demand(/^[a-f0-9]{64}$/.test(options.planFingerprint), "invalid_plan_fingerprint");
  const catalog = await readCatalog(options);
  return { format: 1, schemaVersion: 3, planFingerprint: options.planFingerprint, serverVersion: catalog.serverVersion, objects: catalog.objects };
}
export async function acceptPostgresV3PhysicalSchema(options: ReadOptions & {
  readonly manifest: PhysicalManifest;
  readonly approval: PhysicalReferenceApproval;
}): Promise<{ status: "physical_schema_accepted"; schemaVersion: 3; manifestSha256: string; businessActivation: false }> {
  const { manifest, approval } = options;
  demand(Buffer.byteLength(JSON.stringify(manifest)) <= options.maximumBytes, "manifest_byte_bound");
  const manifestSha256 = sha(manifest);
  demand(manifest.format === 1 && manifest.schemaVersion === 3
    && /^[a-f0-9]{64}$/.test(approval.planFingerprint) && manifest.planFingerprint === approval.planFingerprint
    && manifestSha256 === approval.manifestSha256, "manifest_binding_mismatch");
  demand(await approval.verifyReference({ manifestSha256, planFingerprint: approval.planFingerprint }), "reference_not_trusted");
  const actual = await readCatalog(options);
  demand(actual.serverVersion === manifest.serverVersion, "postgres_version_mismatch");
  demand(JSON.stringify(actual.objects) === JSON.stringify(manifest.objects), "physical_schema_drift");
  return { status: "physical_schema_accepted", schemaVersion: 3, manifestSha256, businessActivation: false };
}
