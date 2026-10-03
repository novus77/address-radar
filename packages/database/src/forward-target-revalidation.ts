import { createHash } from "node:crypto";
import { canonicalForwardTargetChannelFact, forwardTargetSubjectKey, type ForwardTargetChannelFact, type ForwardTargetPrincipal } from "@address-radar/domain";
import { createPostgresForwardTargetAuthorizationRepository } from "./forward-target-authorization-store.js";
import type { LegacyForwardTargetSnapshot } from "./forward-target-hydration.js";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export type ForwardTargetRefreshKey = Pick<ForwardTargetChannelFact, "entityId" | "channel" | "subjectId" | "walletFamily">;
export interface ForwardTargetRefreshQuery extends ForwardTargetRefreshKey { readonly generationId: string; readonly asOf: number; }
export type ForwardTargetSourceCheck = { readonly status: "available"; readonly snapshot: LegacyForwardTargetSnapshot } | { readonly status: "missing" | "unavailable" };
export type ForwardTargetDecisionReader = (transaction: PostgresTransaction, input: ForwardTargetRefreshQuery) => Promise<unknown>;
export const POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL = `
CREATE TABLE forward_target_identity_refresh_receipts (
  refresh_id text PRIMARY KEY,generation_id text NOT NULL,entity_id text NOT NULL,channel text NOT NULL CHECK(channel IN ('fomo','wallet')),
  subject_key text NOT NULL,checked_at bigint NOT NULL CHECK(checked_at>=0),target_version_id text REFERENCES forward_target_channel_versions(version_id),
  source_fingerprint text,source_observed_at bigint,status text NOT NULL CHECK(status IN ('verified','source_missing','source_unavailable')),
  actor_id text NOT NULL,actor_authorization_ref text NOT NULL,fingerprint text NOT NULL,payload text NOT NULL,
  CHECK(status<>'verified' OR (target_version_id IS NOT NULL AND source_fingerprint IS NOT NULL AND source_observed_at IS NOT NULL)),
  CHECK(source_observed_at IS NULL OR source_observed_at<=checked_at)
);
CREATE TABLE forward_target_identity_refresh_heads (
  generation_id text NOT NULL,entity_id text NOT NULL,channel text NOT NULL,subject_key text NOT NULL,
  refresh_id text NOT NULL REFERENCES forward_target_identity_refresh_receipts(refresh_id),checked_at bigint NOT NULL,
  head_generation bigint NOT NULL,PRIMARY KEY(generation_id,entity_id,channel,subject_key)
);
`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: string) => { if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Invalid identity refresh identifier"); return value; };
const validate = (query: ForwardTargetRefreshQuery) => {
  text(query.entityId); text(query.generationId);
  if (!Number.isSafeInteger(query.asOf) || query.asOf < 0) throw new Error("Invalid identity refresh clock");
  return forwardTargetSubjectKey(query);
};
const stateObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid target authorization decision");
  return value as Record<string, unknown>;
};
const stamp = (state: Record<string, unknown>) => typeof state.authorizationStamp === "string" ? state.authorizationStamp : null;
const blocked = (reasonCode: string) => ({ status: "blocked_source", reasonCode, monitoringEligible: false, radarEligible: false, authorizationStamp: null });

export async function refreshPostgresForwardTargetIdentity(transaction: PostgresTransaction, input: {
  readonly query: ForwardTargetRefreshQuery; readonly source: ForwardTargetSourceCheck;
  readonly principal: ForwardTargetPrincipal; readonly readAuthorization: ForwardTargetDecisionReader;
}) {
  const { query, principal } = input, subjectKey = validate(query);
  if (!principal.actorId?.trim() || !principal.authorizationEvidenceRef?.trim() || !principal.permissions.includes("target_registry_write")) throw new Error("Identity refresh requires server-authorized registry permission");
  await transaction.query("INSERT INTO forward_target_control_locks(entity_id) VALUES($1) ON CONFLICT DO NOTHING", [query.entityId]);
  await transaction.query("SELECT entity_id FROM forward_target_control_locks WHERE entity_id=$1 FOR UPDATE", [query.entityId]);
  const repository = createPostgresForwardTargetAuthorizationRepository(transaction, principal);
  let target = await repository.readChannel({ ...query });
  let state: Record<string, unknown>, sourceFingerprint: string | null = null, sourceObservedAt: number | null = null;
  let status: "verified" | "source_missing" | "source_unavailable";
  if (input.source.status === "available") {
    const snapshot = input.source.snapshot, fact = canonicalForwardTargetChannelFact(snapshot.fact);
    if (fact.entityId !== query.entityId || forwardTargetSubjectKey(fact) !== subjectKey || snapshot.proofScope !== "legacy_registry_linkage"
      || snapshot.capturedAt !== query.asOf || !Number.isSafeInteger(snapshot.sourceObservedAt) || snapshot.sourceObservedAt < 0 || snapshot.sourceObservedAt > query.asOf) throw new Error("Identity refresh snapshot does not match its target and clock");
    sourceFingerprint = text(snapshot.sourceFingerprint); sourceObservedAt = snapshot.sourceObservedAt;
    if (!target || JSON.stringify(target.fact) !== JSON.stringify(fact)) {
      const versionId = `identity-refresh:${hash([query.generationId,query.entityId,subjectKey,target?.versionId ?? null,fact,sourceFingerprint,query.asOf,principal.actorId,principal.authorizationEvidenceRef])}`;
      await repository.recordChannel({ ...fact, versionId, effectiveAt: query.asOf, knownAt: query.asOf });
      target = await repository.readChannel({ ...query });
    }
    if (!target) throw new Error("Identity refresh did not establish a target version");
    state = stateObject(await input.readAuthorization(transaction, query)); status = "verified";
  } else {
    status = input.source.status === "missing" ? "source_missing" : "source_unavailable";
    state = blocked(status === "source_missing" ? "identity_source_missing" : "identity_source_unavailable");
  }
  const payload = { state, targetVersionId: target?.versionId ?? null, authorizationStamp: stamp(state) };
  const fingerprint = hash([query,status,sourceFingerprint,sourceObservedAt,payload,principal.actorId,principal.authorizationEvidenceRef]);
  const refreshId = `identity-refresh-receipt:${fingerprint}`;
  await transaction.query(`INSERT INTO forward_target_identity_refresh_receipts
    (refresh_id,generation_id,entity_id,channel,subject_key,checked_at,target_version_id,source_fingerprint,source_observed_at,status,actor_id,actor_authorization_ref,fingerprint,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
    [refreshId,query.generationId,query.entityId,query.channel,subjectKey,query.asOf,target?.versionId ?? null,sourceFingerprint,sourceObservedAt,status,principal.actorId,principal.authorizationEvidenceRef,fingerprint,JSON.stringify(payload)]);
  const existing = (await transaction.query("SELECT fingerprint FROM forward_target_identity_refresh_receipts WHERE refresh_id=$1", [refreshId])).rows[0];
  if (existing?.fingerprint !== fingerprint) throw new Error("Identity refresh receipt conflict");
  await transaction.query(`INSERT INTO forward_target_identity_refresh_heads(generation_id,entity_id,channel,subject_key,refresh_id,checked_at,head_generation)
    VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(generation_id,entity_id,channel,subject_key) DO UPDATE
    SET refresh_id=excluded.refresh_id,checked_at=excluded.checked_at,head_generation=forward_target_identity_refresh_heads.head_generation+1
    WHERE excluded.checked_at>=forward_target_identity_refresh_heads.checked_at AND excluded.refresh_id<>forward_target_identity_refresh_heads.refresh_id`,
    [query.generationId,query.entityId,query.channel,subjectKey,refreshId,query.asOf]);
  return { refreshId, status, checkedAt: query.asOf, targetVersionId: target?.versionId ?? null, state };
}

export async function readPostgresFreshForwardTargetAuthorization(transaction: PostgresTransaction, input: ForwardTargetRefreshQuery, readAuthorization: ForwardTargetDecisionReader) {
  const subjectKey = validate(input);
  await transaction.query("SELECT entity_id FROM forward_target_control_locks WHERE entity_id=$1 FOR SHARE", [input.entityId]);
  const row = (await transaction.query(`SELECT r.refresh_id,r.checked_at,r.status,r.payload FROM forward_target_identity_refresh_heads h
    JOIN forward_target_identity_refresh_receipts r ON r.refresh_id=h.refresh_id
    WHERE h.generation_id=$1 AND h.entity_id=$2 AND h.channel=$3 AND h.subject_key=$4 FOR SHARE OF h,r`,
    [input.generationId,input.entityId,input.channel,subjectKey])).rows[0];
  if (!row || Number(row.checked_at) !== input.asOf) return { ...blocked("identity_refresh_required"), refreshReceiptId: null };
  if (row.status !== "verified") return { ...blocked(row.status === "source_missing" ? "identity_source_missing" : "identity_source_unavailable"), refreshReceiptId: String(row.refresh_id) };
  const recorded = JSON.parse(String(row.payload)) as { targetVersionId: string; authorizationStamp: string | null };
  const state = stateObject(await readAuthorization(transaction,input));
  if (state.targetVersionId !== recorded.targetVersionId || stamp(state) !== recorded.authorizationStamp) return { ...blocked("authorization_changed_since_refresh"), refreshReceiptId: String(row.refresh_id) };
  return { status: "verified", reasonCode: null, monitoringEligible: state.monitoringEligible === true,
    radarEligible: state.radarEligible === true, authorizationStamp: stamp(state), refreshReceiptId: String(row.refresh_id), state };
}
