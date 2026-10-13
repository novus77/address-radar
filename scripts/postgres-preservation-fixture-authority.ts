import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createFullDataPreservationSchemaSql } from "../packages/database/src/postgres-full-data-import.js";
import type { PostgresPool } from "../packages/database/src/postgres-unit-of-work.js";
import { readPrivatePreservationFile, type PreservationFixturePorts, type PreservationRehearsalConfig } from "./rehearse-postgres-full-preservation.js";

// Authenticated parent-recorded backup pins. These authorize only isolated rehearsal, never production.
export const preservationPreparationPins = Object.freeze({
  snapshotSha256: "d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7",
  manifestSha256: "d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c",
  catalogFingerprint: "6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5",
  tables: 141, rows: 6023033, chunks: 1548,
});
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function reject(condition: unknown): asserts condition { if (!condition) throw new Error("private_preservation_authority_rejected"); }
interface FixtureAuthority {
  version: 1; scope: "backup-derived-preservation-rehearsal";
  target: PreservationRehearsalConfig["target"]; approvalRef: string; expiresAtMs: number; password: string;
}
/** The record digest must come from Boyle's authenticated private lifecycle handoff, not from this record itself. */
export function authenticatePreservationFixtureAuthority(bytes: Buffer, externallyPinnedSha256: string, config: PreservationRehearsalConfig): FixtureAuthority {
  reject(/^[a-f0-9]{64}$/.test(externallyPinnedSha256) && bytes.length <= 16 * 1024 && sha(bytes) === externallyPinnedSha256);
  const input: unknown = JSON.parse(bytes.toString("utf8"));
  reject(input !== null && typeof input === "object" && !Array.isArray(input));
  const record = input as Record<string, unknown>;
  reject(Object.keys(record).length === 6 && ["version", "scope", "target", "approvalRef", "expiresAtMs", "password"].every(key => Object.hasOwn(record, key)));
  reject(record.version === 1 && record.scope === "backup-derived-preservation-rehearsal" && record.approvalRef === config.approvalRef &&
    typeof record.expiresAtMs === "number" && Number.isSafeInteger(record.expiresAtMs) && record.expiresAtMs >= config.deadlineAtMs && Date.now() < record.expiresAtMs &&
    typeof record.password === "string" && /^[a-f0-9]{64}$/.test(record.password));
  reject(record.target !== null && typeof record.target === "object" && !Array.isArray(record.target));
  const target = record.target as Record<string, unknown>;
  reject(Object.keys(target).length === Object.keys(config.target).length && Object.entries(config.target).every(([key, value]) => target[key] === value));
  const nonce = /^radar_rehearsal_([a-f0-9]{16})(?:_[a-z]+)?$/;
  reject(nonce.exec(config.target.database)?.[1] && nonce.exec(config.target.database)?.[1] === nonce.exec(config.target.schema)?.[1] &&
    config.target.serverAddress === "127.0.0.1" && config.target.serverPort === 5434 &&
    config.target.service === "migration-preservation" && config.target.schemaVersion === 1 &&
    config.target.schemaFingerprint === sha(createFullDataPreservationSchemaSql(config.target.schema).join("\n")));
  reject(Object.entries(preservationPreparationPins).every(([key, value]) => Reflect.get(config.expected, key) === value));
  Object.freeze(record.target);
  return Object.freeze(record) as unknown as FixtureAuthority;
}

export async function createPreservationFixturePorts(config: PreservationRehearsalConfig): Promise<PreservationFixturePorts> {
  const path = process.env.ADDRESS_RADAR_PRIVATE_PRESERVATION_AUTHORITY_PATH;
  const pin = process.env.ADDRESS_RADAR_PRIVATE_PRESERVATION_AUTHORITY_SHA256;
  reject(path && pin);
  const authority = authenticatePreservationFixtureAuthority(await readPrivatePreservationFile(path, 16 * 1024), pin, config);
  const { Pool } = createRequire(new URL("../packages/database/package.json", import.meta.url))("pg") as {
    Pool: new (options: Record<string, unknown>) => PostgresPool & { end(): Promise<void> };
  };
  // Constructing the pool never connects or provisions. Actual runtime verifies role, endpoint and system identity.
  const pool = new Pool({ host: config.target.serverAddress, port: 5434, database: config.target.database,
    user: config.target.username, password: authority.password, max: 1, connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 1000, allowExitOnIdle: true, ssl: false, application_name: "radar-private-preservation-rehearsal" });
  return { pool, assertAuthorized: async request => {
    reject(Date.now() < authority.expiresAtMs && request.capability.mode === "isolated" && request.capability.purpose === "schema_install" &&
      request.capability.approvalRef === authority.approvalRef && request.capability.planSha256 === preservationPreparationPins.manifestSha256 &&
      request.capability.expiresAtMs <= authority.expiresAtMs && Object.entries(authority.target).every(([key, value]) => Reflect.get(request.target, key) === value));
  } };
}

/** Shape/lineage check only; caller must authenticate the historical receipt separately.
 * This authorizes neither cached source validation nor a PostgreSQL target. */
export function validatePreservationResidentCalibration(input: unknown): NonNullable<PreservationFixturePorts["residentChunkAllowance"]> {
  const fail = () => { throw new Error("fixture_calibration_receipt_rejected"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const proof = input as Record<string, unknown>, native = proof.nativeMetrics as Record<string, unknown> | undefined;
  const digest = "1328e4403d467c4aa7f7ef4cee43a85ea59347263caf0250b4f76be36fb6f8b3";
  if (proof.status !== "calibrated" || proof.manifestSha256 !== preservationPreparationPins.manifestSha256 ||
      proof.file !== "table-0044-chunk-000000.json" || proof.bytes !== 16775058 || proof.rows !== 2842 ||
      proof.sha256 !== digest || proof.proofSha256 !== digest || proof.rollbackObserved !== true ||
      proof.maximumRssBytes !== 256 * 1024 ** 2 || typeof proof.measuredPeakRssBytes !== "number" ||
      !Number.isSafeInteger(proof.measuredPeakRssBytes) || proof.measuredPeakRssBytes < 1 || proof.measuredPeakRssBytes > proof.maximumRssBytes ||
      !native || native.physicalSqlStatements !== 162 || native.acknowledgedRollbacks !== 1) return fail();
  return Object.freeze({ manifestSha256: preservationPreparationPins.manifestSha256, chunkSha256: digest, chunkBytes: 16775058,
    measuredPeakRssBytes: proof.measuredPeakRssBytes, maximumRssBytes: proof.maximumRssBytes, rollbackObserved: true });
}
