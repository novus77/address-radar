import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertProtectedPostgresPath, type ServiceEnvironment } from "../packages/database/src/postgres-service-dispatch.js";
import type { AddressOnlyStartupManifest } from "../apps/automation/src/postgres-address-only-startup.js";

export interface AddressOnlyStartupEvidence {
  readonly protocol: "address-only-native-startup-evidence-v1";
  readonly operationId: string;
  readonly importId: string;
  readonly generationId: string;
  readonly releaseSha256: string;
  readonly backupSha256: string;
  readonly fenceSha256: string;
  readonly deploymentSha256: string;
  readonly safetyEnvironmentSha256: string;
  readonly measuredAt: number;
  readonly sourceEpoch: readonly {
    readonly path: string; readonly device: string; readonly inode: string; readonly size: string;
    readonly uid: string; readonly gid: string; readonly mode: string; readonly mtimeNs: string; readonly ctimeNs: string;
  }[];
  readonly sourceSealed: true;

  readonly importCommitted: true;
  readonly gatewayDeliveryEnabled: false;
  readonly fomoEnabled: false;
  readonly fullHistoricalMiningEnabled: false;
}
const source = "/var/lib/address-radar/address-radar.db";
export function addressOnlySafetyEnvironmentDigest(env: ServiceEnvironment): string {
  const names = ["ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED", "ADDRESS_RADAR_FOMO_BROWSER_ENABLED",
    "ADDRESS_RADAR_FOMO_CAPTURE_ENABLED", "ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED"];
  if (names.some(name => env[name] !== "false")) throw new Error("ADDRESS_ONLY_ACTUAL_SAFETY_ENVIRONMENT_REQUIRED");
  return createHash("sha256").update(JSON.stringify(names.map(name => [name,env[name]]))).digest("hex");
}
export async function verifyAddressOnlySourceEpoch(evidence: AddressOnlyStartupEvidence): Promise<void> {
  const parent = await lstat("/var/lib/address-radar", { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0n || (parent.mode & 0o022n) !== 0n)
    throw new Error("ADDRESS_ONLY_SOURCE_FENCE_REVOKED");
  for (const row of evidence.sourceEpoch) {
    const s = await lstat(row.path,{bigint:true});
    const actual = {device:s.dev,inode:s.ino,size:s.size,uid:s.uid,gid:s.gid,mode:s.mode&0o777n,mtimeNs:s.mtimeNs,ctimeNs:s.ctimeNs};
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || Object.entries(actual).some(([k,v]) => String(v) !== row[k as keyof typeof row]))
      throw new Error("ADDRESS_ONLY_SOURCE_FENCE_REVOKED");
  }
  for (const path of [source+"-wal",source+"-shm"]) {
    if (evidence.sourceEpoch.some(row=>row.path===path)) continue;
    try { await lstat(path); throw new Error("ADDRESS_ONLY_SOURCE_FENCE_REVOKED"); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
const keys =
 ["protocol", "operationId", "importId", "generationId", "releaseSha256", "backupSha256",
  "fenceSha256", "deploymentSha256", "safetyEnvironmentSha256", "measuredAt", "sourceEpoch", "sourceSealed", "importCommitted", "gatewayDeliveryEnabled", "fomoEnabled", "fullHistoricalMiningEnabled"];
export function validateAddressOnlyStartupEvidence(value: unknown, manifest: AddressOnlyStartupManifest): AddressOnlyStartupEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_REQUIRED");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !descriptors[k] || !("value" in descriptors[k]!)))
    throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_FIELDS");
  const record = value as Record<string, unknown>;
  if (record.protocol !== "address-only-native-startup-evidence-v1" || record.sourceSealed !== true || record.importCommitted !== true
    || record.gatewayDeliveryEnabled !== false || record.fomoEnabled !== false || record.fullHistoricalMiningEnabled !== false
    || ["operationId", "importId", "generationId", "releaseSha256", "backupSha256", "fenceSha256"].some(k =>
      record[k] !== manifest[k as keyof AddressOnlyStartupManifest])) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_BINDING");
  if (![record.deploymentSha256,record.safetyEnvironmentSha256].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))
    || !Number.isSafeInteger(record.measuredAt) || (record.measuredAt as number) < manifest.activatedAt
    || (record.measuredAt as number) > Date.now() || !Array.isArray(record.sourceEpoch)
    || record.sourceEpoch.length < 1 || record.sourceEpoch.length > 3) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_EPOCH");
  const paths = new Set<string>();
  for (const row of record.sourceEpoch as Record<string,unknown>[]) {
    if (!row || Object.keys(row).sort().join(",") !== ["path","device","inode","size","uid","gid","mode","mtimeNs","ctimeNs"].sort().join(",")
      || typeof row.path !== "string" || ![source,source+"-wal",source+"-shm"].includes(row.path) || paths.has(row.path)
      || Object.entries(row).some(([k,v]) => k !== "path" && (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)))
      || row.uid !== "0" || row.gid !== "0" || row.mode !== "256") throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_EPOCH");
    paths.add(row.path);
  }
  if (!paths.has(source)) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_EPOCH");
  return Object.freeze({ ...record, sourceEpoch: Object.freeze(record.sourceEpoch.map(row => Object.freeze({ ...row }))) }) as unknown as AddressOnlyStartupEvidence;

}

/** The native controller publishes this measured receipt separately from deployment expectations.
 * It contains no credentials or addresses; the root-owned immutable file may be service-readable.
 */
export async function readAddressOnlyStartupEvidence(env: ServiceEnvironment, manifest: AddressOnlyStartupManifest,
  signal?: AbortSignal): Promise<AddressOnlyStartupEvidence> {
  signal?.throwIfAborted();
  const path = env.ADDRESS_RADAR_POSTGRES_ADDRESS_ONLY_EVIDENCE_FILE;
  const expected = env.ADDRESS_RADAR_POSTGRES_ADDRESS_ONLY_EVIDENCE_SHA256;
  if (!path || !/^[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_PIN_REQUIRED");
  await assertProtectedPostgresPath(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stamp = (s: import("node:fs").BigIntStats) => [s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(":");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || before.size < 1n || before.size > 65536n
      || (before.mode & 0o222n) !== 0n) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_UNSAFE");
    const bytes = Buffer.alloc(Number(before.size) + 1); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted(); const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) break; offset += result.bytesRead;
    }
    if (offset !== Number(before.size) || stamp(before) !== stamp(await handle.stat({ bigint: true }))
      || stamp(before) !== stamp(await lstat(path, { bigint: true }))) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_CHANGED");
    const raw = bytes.subarray(0,offset);
    if (createHash("sha256").update(raw).digest("hex") !== expected) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_DIGEST");
    await assertProtectedPostgresPath(path); signal?.throwIfAborted();
    const evidence = validateAddressOnlyStartupEvidence(JSON.parse(raw.toString("utf8")), manifest);
    if (evidence.deploymentSha256 !== env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256
      || evidence.safetyEnvironmentSha256 !== addressOnlySafetyEnvironmentDigest(env)) throw new Error("ADDRESS_ONLY_NATIVE_EVIDENCE_ENVIRONMENT");
    await verifyAddressOnlySourceEpoch(evidence); signal?.throwIfAborted();
    return evidence;

  } finally { await handle.close(); }
}
