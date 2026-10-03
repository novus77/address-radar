import { createHash, randomUUID } from "node:crypto";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_CAPTURE_INBOX_SCHEMA_SQL = `
CREATE TABLE capture_event_identities (
  source_namespace text NOT NULL, source_event_id text NOT NULL,
  first_received_at bigint NOT NULL, original_fingerprint text,
  revision_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (source_namespace, source_event_id)
);
CREATE TABLE capture_event_revisions (
  source_namespace text NOT NULL, source_event_id text NOT NULL,
  semantic_fingerprint text NOT NULL, revision_number integer NOT NULL,
  fingerprint_basis text NOT NULL CHECK (fingerprint_basis IN ('semantic', 'opaque')),
  semantic_payload text, first_received_at bigint NOT NULL,
  processing_state text NOT NULL CHECK (processing_state IN ('pending', 'revision_pending')),
  PRIMARY KEY (source_namespace, source_event_id, semantic_fingerprint),
  UNIQUE (source_namespace, source_event_id, revision_number),
  FOREIGN KEY (source_namespace, source_event_id)
    REFERENCES capture_event_identities(source_namespace, source_event_id)
);
CREATE TABLE capture_raw_payloads (
  payload_id text PRIMARY KEY, source_namespace text NOT NULL, source_event_id text NOT NULL,
  semantic_fingerprint text NOT NULL, collector_id text NOT NULL, session_id text NOT NULL,
  received_at bigint NOT NULL, received_day bigint NOT NULL,
  scrubbed_payload text NOT NULL, payload_hash text NOT NULL,
  FOREIGN KEY (source_namespace, source_event_id, semantic_fingerprint)
    REFERENCES capture_event_revisions(source_namespace, source_event_id, semantic_fingerprint)
);
CREATE INDEX capture_raw_payloads_received ON capture_raw_payloads(received_at, payload_id);
CREATE INDEX capture_event_revisions_pending ON capture_event_revisions(processing_state, first_received_at);
`;

export interface PostgresCaptureEnvelope {
  readonly sourceNamespace: string;
  readonly sourceEventId: string;
  readonly collectorId: string;
  readonly sessionId: string;
  readonly receivedAt: number;
  // The source adapter must remove credentials before crossing this boundary.
  readonly scrubbedPayload: string;
  // Only source business fields, never reception/session metadata. Null preserves unparsed input.
  readonly semanticPayload: string | null;
}

export interface PostgresCaptureLimits {
  readonly maximumPayloadBytes: number;
}

export interface StagedCaptureResult {
  readonly status: "inserted" | "duplicate" | "revision_pending";
  readonly semanticFingerprint: string;
  readonly fingerprintBasis: "semantic" | "opaque";
  readonly revisionNumber: number;
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Capture semantic payload nesting exceeds limit");
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error("Capture semantic numeric value requires a lossless string representation");
  }
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item, depth + 1)]));
  }
  return value;
}

export function createPostgresCaptureRepository(transaction: PostgresTransaction, limits: PostgresCaptureLimits) {
  if (!Number.isSafeInteger(limits.maximumPayloadBytes) || limits.maximumPayloadBytes <= 0) {
    throw new Error("Capture payload limit must be a positive safe integer");
  }
  return Object.freeze({
    async append(input: PostgresCaptureEnvelope): Promise<StagedCaptureResult> {
      for (const id of [input.sourceNamespace, input.sourceEventId, input.collectorId, input.sessionId]) {
        if (!id.trim() || id.length > 512) throw new Error("Capture identity must be nonempty and bounded");
      }
      if (!Number.isSafeInteger(input.receivedAt) || input.receivedAt < 0) throw new Error("Capture reception time is invalid");
      if (Buffer.byteLength(input.scrubbedPayload, "utf8") > limits.maximumPayloadBytes
        || (input.semanticPayload !== null && Buffer.byteLength(input.semanticPayload, "utf8") > limits.maximumPayloadBytes)) {
        throw new Error("Capture payload exceeds configured limit");
      }
      let semantic: string | null = null;
      if (input.semanticPayload !== null) {
        const parsed: unknown = JSON.parse(input.semanticPayload);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Capture semantic payload must be an object");
        semantic = JSON.stringify(canonical(parsed));
      }
      const fingerprintBasis = semantic === null ? "opaque" as const : "semantic" as const;
      const semanticFingerprint = digest(`${fingerprintBasis}:${semantic ?? input.scrubbedPayload}`);
      const key = [input.sourceNamespace, input.sourceEventId];
      await transaction.query(`INSERT INTO capture_event_identities(source_namespace, source_event_id, first_received_at)
        VALUES ($1, $2, $3) ON CONFLICT (source_namespace, source_event_id) DO NOTHING`, [...key, input.receivedAt]);
      const identity = await transaction.query(`SELECT original_fingerprint, revision_count FROM capture_event_identities
        WHERE source_namespace=$1 AND source_event_id=$2 FOR UPDATE`, key);
      const row = identity.rows[0];
      if (!row) throw new Error("Capture identity was not persisted");
      const existing = await transaction.query(`SELECT revision_number, fingerprint_basis FROM capture_event_revisions
        WHERE source_namespace=$1 AND source_event_id=$2 AND semantic_fingerprint=$3`, [...key, semanticFingerprint]);
      if (existing.rows[0]) return Object.freeze({ status: "duplicate", semanticFingerprint,
        fingerprintBasis, revisionNumber: Number(existing.rows[0].revision_number) });
      const revisionNumber = Number(row.revision_count) + 1;
      const status = row.original_fingerprint === null ? "inserted" as const : "revision_pending" as const;
      await transaction.query(`INSERT INTO capture_event_revisions(source_namespace, source_event_id, semantic_fingerprint,
        revision_number, fingerprint_basis, semantic_payload, first_received_at, processing_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [...key, semanticFingerprint, revisionNumber, fingerprintBasis,
        semantic, input.receivedAt, status === "inserted" ? "pending" : "revision_pending"]);
      await transaction.query(`INSERT INTO capture_raw_payloads(payload_id, source_namespace, source_event_id,
        semantic_fingerprint, collector_id, session_id, received_at, received_day, scrubbed_payload, payload_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), ...key, semanticFingerprint, input.collectorId,
        input.sessionId, input.receivedAt, Math.floor(input.receivedAt / 86_400_000), input.scrubbedPayload,
        digest(input.scrubbedPayload)]);
      await transaction.query(`UPDATE capture_event_identities SET original_fingerprint=COALESCE(original_fingerprint,$3),
        revision_count=$4 WHERE source_namespace=$1 AND source_event_id=$2`, [...key, semanticFingerprint, revisionNumber]);
      // This is a staged result, not a transport acknowledgement. Await the outer transaction commit.
      return Object.freeze({ status, semanticFingerprint, fingerprintBasis, revisionNumber });
    },
  });
}
