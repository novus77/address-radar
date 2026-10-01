import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  openAddressRadarRepository,
  type AutomationJobStore,
  type AddressRadarRepository,
} from "@address-radar/database";
import type { AutomationJob } from "@address-radar/domain";
import { createTokenSignalService } from "@address-radar/signal-engine";

import type { AutomationExecutionResult, AutomationHandler } from "./scheduler.js";

const SCAN_ID = "signal-projection-v1";
const SCAN_BATCH_SIZE = 1_000;
const PROJECTION_WINDOW_MS = 60 * 60_000;

const stableId = (prefix: string, value: string): string =>
  `${prefix}:${createHash("sha256").update(value).digest("hex")}`;

interface ProjectionRequest {
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly desiredRevision: number;
  readonly appliedRevision: number;
}

interface ProjectionPayload {
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly revision: number;
}

function initialize(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS signal_projection_requests (
      token_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      desired_revision INTEGER NOT NULL,
      applied_revision INTEGER NOT NULL DEFAULT 0,
      requested_at INTEGER NOT NULL,
      applied_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS signal_projection_requests_pending
      ON signal_projection_requests(desired_revision, applied_revision, requested_at);
    CREATE TABLE IF NOT EXISTS signal_projection_scan_state (
      scan_id TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function parsePayload(payload: string): ProjectionPayload {
  const value = JSON.parse(payload) as Partial<ProjectionPayload>;
  if (typeof value.tokenId !== "string" || typeof value.chain !== "string"
    || typeof value.tokenAddress !== "string" || !Number.isSafeInteger(value.revision)) {
    throw new Error("Invalid signal projection payload");
  }
  return value as ProjectionPayload;
}

function pendingRequests(database: DatabaseSync, limit: number): readonly ProjectionRequest[] {
  return database.prepare(`
    SELECT token_id AS tokenId, chain, token_address AS tokenAddress,
      desired_revision AS desiredRevision, applied_revision AS appliedRevision
    FROM signal_projection_requests
    WHERE desired_revision > applied_revision
    ORDER BY requested_at, token_id
    LIMIT ?
  `).all(limit) as unknown as readonly ProjectionRequest[];
}

function enqueueRequest(jobs: AutomationJobStore, request: ProjectionRequest, now: number): void {
  const idempotencyKey = `signal-projection:${request.tokenId}:${request.desiredRevision}`;
  jobs.enqueue({
    jobId: stableId("signal-projection", idempotencyKey),
    idempotencyKey,
    lane: "repair",
    jobType: "signal_projection",
    subjectKey: request.tokenId,
    priority: 8,
    cursor: null,
    nextAttemptAt: now,
    payload: JSON.stringify({
      tokenId: request.tokenId,
      chain: request.chain,
      tokenAddress: request.tokenAddress,
      revision: request.desiredRevision,
    }),
    createdAt: now,
  });
}

export function createSignalProjectionReconciler(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly now?: () => number;
}) {
  initialize(input.database);
  const now = input.now ?? Date.now;
  return Object.freeze({
    runOnce(): { readonly scanned: number; readonly changed: number; readonly enqueued: number } {
      const at = now();
      const state = input.database.prepare(
        "SELECT cursor FROM signal_projection_scan_state WHERE scan_id = ?",
      ).get(SCAN_ID) as { cursor: string } | undefined;
      const cursor = state?.cursor ?? "";
      const rows = input.database.prepare(`
        SELECT e.chain, e.token_address AS tokenAddress,
          e.chain || ':' || e.token_address AS tokenId,
          COUNT(DISTINCT e.event_id) AS evidenceCount,
          SUM(COALESCE((SELECT SUM(h.revision) FROM trader_execution_heads h
            WHERE h.event_id=e.event_id AND h.projection_state='applied'),0)) AS executionRevisionTotal,
          MAX(e.occurred_at) AS evidenceAt,
          MAX(COALESCE((
            SELECT MAX(a.as_of) FROM trader_ability_snapshots a
            WHERE a.entity_id = e.entity_id
          ), 0)) AS abilityAt,
          MAX(COALESCE((
            SELECT MAX(c.evaluated_at) FROM candidate_admission_snapshots c
            WHERE c.trader_id = e.entity_id
          ), 0)) AS admissionAt,
          MAX(COALESCE((
            SELECT t.updated_at FROM trader_entities t
            WHERE t.entity_id = e.entity_id
          ), 0)) AS entityAt
        FROM address_signal_evidence e
        WHERE e.chain || ':' || e.token_address > ?
        GROUP BY e.chain, e.token_address
        ORDER BY tokenId
        LIMIT ?
      `).all(cursor, SCAN_BATCH_SIZE) as unknown as Array<{
        chain: string;
        tokenAddress: string;
        tokenId: string;
        evidenceCount: number;
        executionRevisionTotal: number;
        evidenceAt: number;
        abilityAt: number;
        admissionAt: number;
        entityAt: number;
      }>;
      const upsert = input.database.prepare(`
        INSERT INTO signal_projection_requests(
          token_id, chain, token_address, source_fingerprint,
          desired_revision, applied_revision, requested_at, applied_at, last_error
        ) VALUES (?, ?, ?, ?, 1, 0, ?, NULL, NULL)
        ON CONFLICT(token_id) DO UPDATE SET
          chain = excluded.chain,
          token_address = excluded.token_address,
          source_fingerprint = excluded.source_fingerprint,
          desired_revision = signal_projection_requests.desired_revision + 1,
          requested_at = excluded.requested_at,
          last_error = NULL
        WHERE signal_projection_requests.source_fingerprint != excluded.source_fingerprint
      `);
      let changed = 0;
      for (const row of rows) {
        const fingerprint = [row.evidenceCount, row.evidenceAt, row.abilityAt, row.admissionAt, row.entityAt,
          ...(row.executionRevisionTotal > 0 ? [`execution:${row.executionRevisionTotal}`] : [])].join(":");
        changed += Number(upsert.run(row.tokenId, row.chain, row.tokenAddress, fingerprint, at).changes);
      }
      const exhausted = rows.length < SCAN_BATCH_SIZE;
      const nextCursor = exhausted ? "" : rows.at(-1)!.tokenId;
      input.database.prepare(`
        INSERT INTO signal_projection_scan_state(scan_id, cursor, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scan_id) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at
      `).run(SCAN_ID, nextCursor, at);
      const pending = pendingRequests(input.database, SCAN_BATCH_SIZE);
      for (const request of pending) enqueueRequest(input.jobs, request, at);
      return Object.freeze({ scanned: rows.length, changed, enqueued: pending.length });
    },
  });
}

export function createSignalProjectionWorker(input: {
  readonly database: DatabaseSync;
  readonly repository: AddressRadarRepository;
  readonly threshold: number;
  readonly minimumTotalBuyUsd: number;
  readonly now?: () => number;
}): AutomationHandler {
  initialize(input.database);
  const now = input.now ?? Date.now;
  const service = createTokenSignalService({
    repository: input.repository,
    threshold: input.threshold,
    minimumTotalBuyUsd: input.minimumTotalBuyUsd,
    strategyVersion: "address-signal-projection-v1",
    now,
  });
  return Object.freeze({
    jobType: "signal_projection",
    async execute(job: AutomationJob): Promise<AutomationExecutionResult> {
      const payload = parsePayload(job.payload);
      const request = input.database.prepare(`
        SELECT desired_revision AS desiredRevision, applied_revision AS appliedRevision
        FROM signal_projection_requests WHERE token_id = ?
      `).get(payload.tokenId) as { desiredRevision: number; appliedRevision: number } | undefined;
      if (!request || request.appliedRevision >= payload.revision) {
        return { status: "completed", diagnostic: "signal projection already applied" };
      }
      const at = now();
      const evidence = input.repository.addressSignalEvidenceForToken(
        payload.chain,
        payload.tokenAddress,
        at - PROJECTION_WINDOW_MS,
      );
      const result = service.evaluate(payload.chain, payload.tokenAddress, evidence);
      input.database.prepare(`
        UPDATE signal_projection_requests
        SET applied_revision = MAX(applied_revision, ?), applied_at = ?, last_error = NULL
        WHERE token_id = ?
      `).run(payload.revision, at, payload.tokenId);
      return {
        status: "completed",
        diagnostic: `signal projection ${result.decision.action} with ${evidence.length} evidence rows`,
      };
    },
  });
}

export function openSignalProjectionRepository(databasePath: string): AddressRadarRepository {
  return openAddressRadarRepository(databasePath);
}
