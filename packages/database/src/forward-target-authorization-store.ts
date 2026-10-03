import { createHash } from "node:crypto";
import { canonicalForwardTargetChannelFact, forwardTargetIdentityTrusted, forwardTargetSubjectKey, forwardEvidenceIdentifier, forwardEvidenceTime,
  type ForwardTargetChannelFact, type ForwardTargetChannelState, type ForwardManualRadarAuthorization, type ForwardTargetPrincipal, type ForwardTargetChannel } from "@address-radar/domain";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL = `
CREATE TABLE forward_target_control_locks (entity_id text PRIMARY KEY);
CREATE TABLE forward_target_channel_versions (
  version_id text PRIMARY KEY, entity_id text NOT NULL, channel text NOT NULL CHECK(channel IN ('fomo','wallet')), subject_key text NOT NULL,
  fingerprint text NOT NULL, effective_at bigint NOT NULL, known_at bigint NOT NULL, actor_id text NOT NULL,
  actor_authorization_ref text NOT NULL, payload text NOT NULL, CHECK(known_at>=effective_at)
);
CREATE INDEX forward_target_channel_history ON forward_target_channel_versions(entity_id,channel,subject_key,effective_at,known_at);
CREATE TABLE forward_target_channel_heads (
  entity_id text NOT NULL, channel text NOT NULL, subject_key text NOT NULL,
  version_id text NOT NULL REFERENCES forward_target_channel_versions(version_id), head_generation bigint NOT NULL,
  PRIMARY KEY(entity_id,channel,subject_key)
);
CREATE TABLE forward_target_identity_bindings (
  channel text NOT NULL, subject_key text NOT NULL, owner_entity_id text NOT NULL,
  created_at bigint NOT NULL, created_by_version text NOT NULL REFERENCES forward_target_channel_versions(version_id),
  conflict_at bigint, conflict_by_version text REFERENCES forward_target_channel_versions(version_id),
  PRIMARY KEY(channel,subject_key)
);
CREATE TABLE forward_manual_radar_authorizations (
  authorization_id text PRIMARY KEY, entity_id text NOT NULL, action text NOT NULL CHECK(action IN ('grant','revoke')),
  actor_id text NOT NULL, actor_authorization_ref text NOT NULL, basis_ref text NOT NULL, fingerprint text NOT NULL,
  effective_at bigint NOT NULL, known_at bigint NOT NULL, CHECK(known_at>=effective_at)
);
CREATE INDEX forward_manual_radar_history ON forward_manual_radar_authorizations(entity_id,effective_at,known_at);
CREATE TABLE forward_manual_radar_heads (
  entity_id text PRIMARY KEY, authorization_id text NOT NULL REFERENCES forward_manual_radar_authorizations(authorization_id), head_generation bigint NOT NULL
);
CREATE TABLE forward_target_authorization_intents (
  intent_key text PRIMARY KEY, entity_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('channel_changed','manual_changed','ownership_conflict')),
  event_id text NOT NULL, created_at bigint NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched'))
);
`;
function hash(input: unknown): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
function timePair(effectiveAt: number, knownAt: number): void {
  forwardEvidenceTime(effectiveAt); forwardEvidenceTime(knownAt);
  if (knownAt < effectiveAt) throw new Error("Target availability precedes its effective time");
}
function integer(value: unknown): number {
  const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid authorization integer"); return number;
}

export function createPostgresForwardTargetAuthorizationRepository(transaction: PostgresTransaction, principal: ForwardTargetPrincipal | null = null) {
  const permit = (permission: ForwardTargetPrincipal["permissions"][number]) => {
    if (!principal?.permissions.includes(permission)) throw new Error("Target authorization permission denied");
    forwardEvidenceIdentifier(principal.actorId); forwardEvidenceIdentifier(principal.authorizationEvidenceRef); return principal;
  };
  const control = async (entityId: string, write: boolean) => {
    forwardEvidenceIdentifier(entityId);
    if (write) await transaction.query("INSERT INTO forward_target_control_locks(entity_id) VALUES($1) ON CONFLICT DO NOTHING", [entityId]);
    return (await transaction.query(`SELECT entity_id FROM forward_target_control_locks WHERE entity_id=$1 FOR ${write ? "UPDATE" : "SHARE"}`, [entityId])).rowCount;
  };
  const emit = async (kind: "channel_changed" | "manual_changed" | "ownership_conflict", entityId: string, eventId: string, knownAt: number) => {
    await transaction.query(`INSERT INTO forward_target_authorization_intents(intent_key,entity_id,kind,event_id,created_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [hash([kind, entityId, eventId]), entityId, kind, eventId, knownAt]);
  };
  return Object.freeze({
    async recordChannel(input: Omit<ForwardTargetChannelFact, "monitoringEnabled"> & {
      readonly monitoringEnabled?: boolean; readonly versionId: string; readonly effectiveAt: number; readonly knownAt: number;
    }) {
      const actor = permit("target_registry_write"); timePair(input.effectiveAt, input.knownAt); forwardEvidenceIdentifier(input.versionId);
      const fact = canonicalForwardTargetChannelFact({ ...input, monitoringEnabled: input.monitoringEnabled ?? true });
      const subjectKey = forwardTargetSubjectKey(fact); const fingerprint = hash([fact, input.effectiveAt, actor.actorId]);
      await control(fact.entityId, true);
      const inserted = await transaction.query(`INSERT INTO forward_target_channel_versions
        (version_id,entity_id,channel,subject_key,fingerprint,effective_at,known_at,actor_id,actor_authorization_ref,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [input.versionId, fact.entityId, fact.channel, subjectKey, fingerprint, input.effectiveAt, input.knownAt, actor.actorId, actor.authorizationEvidenceRef, JSON.stringify(fact)]);
      if (!inserted.rowCount) {
        const stored = (await transaction.query("SELECT fingerprint FROM forward_target_channel_versions WHERE version_id=$1", [input.versionId])).rows[0];
        if (stored?.fingerprint !== fingerprint) throw new Error("Target version identity conflict");
        return { status: "duplicate" as const };
      }
      const trusted = forwardTargetIdentityTrusted(fact);
      if (trusted) await transaction.query(`INSERT INTO forward_target_identity_bindings(channel,subject_key,owner_entity_id,created_at,created_by_version)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [fact.channel, subjectKey, fact.entityId, input.knownAt, input.versionId]);
      const binding = (await transaction.query("SELECT * FROM forward_target_identity_bindings WHERE channel=$1 AND subject_key=$2 FOR UPDATE", [fact.channel, subjectKey])).rows[0];
      const ownershipConflict = binding && ((trusted && binding.owner_entity_id !== fact.entityId) || (fact.ownerCount > 1 && fact.ownershipEvidenceRef !== null));
      if (ownershipConflict) {
        await transaction.query(`UPDATE forward_target_identity_bindings SET conflict_at=LEAST(COALESCE(conflict_at,$3),$3),
          conflict_by_version=COALESCE(conflict_by_version,$4) WHERE channel=$1 AND subject_key=$2`, [fact.channel, subjectKey, input.knownAt, input.versionId]);
        await emit("ownership_conflict", String(binding.owner_entity_id), input.versionId, input.knownAt);
        if (binding.owner_entity_id !== fact.entityId) await emit("ownership_conflict", fact.entityId, input.versionId, input.knownAt);
      }
      const head = (await transaction.query(`SELECT v.effective_at,v.known_at,h.version_id,h.head_generation FROM forward_target_channel_heads h
        JOIN forward_target_channel_versions v ON v.version_id=h.version_id WHERE h.entity_id=$1 AND h.channel=$2 AND h.subject_key=$3`,
      [fact.entityId, fact.channel, subjectKey])).rows[0];
      const stale = head && (integer(head.effective_at) > input.effectiveAt || (integer(head.effective_at) === input.effectiveAt &&
        (integer(head.known_at) > input.knownAt || (integer(head.known_at) === input.knownAt && String(head.version_id) >= input.versionId))));
      if (!stale) {
        await transaction.query(`INSERT INTO forward_target_channel_heads(entity_id,channel,subject_key,version_id,head_generation) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(entity_id,channel,subject_key) DO UPDATE SET version_id=excluded.version_id,head_generation=excluded.head_generation`,
        [fact.entityId, fact.channel, subjectKey, input.versionId, head ? integer(head.head_generation) + 1 : 1]);
        await emit("channel_changed", fact.entityId, input.versionId, input.knownAt);
      }
      return { status: ownershipConflict ? "ownership_conflict" as const : stale ? "stale_event" as const : "applied" as const };
    },
    async recordManual(input: { readonly authorizationId: string; readonly entityId: string; readonly action: "grant" | "revoke";
      readonly basisRef: string; readonly effectiveAt: number; readonly knownAt: number }) {
      const actor = permit("radar_authorization_write"); forwardEvidenceIdentifier(input.authorizationId); forwardEvidenceIdentifier(input.entityId);
      forwardEvidenceIdentifier(input.basisRef); timePair(input.effectiveAt, input.knownAt);
      if (input.action !== "grant" && input.action !== "revoke") throw new Error("Invalid radar authorization action");
      await control(input.entityId, true);
      const target = await transaction.query("SELECT 1 FROM forward_target_channel_versions WHERE entity_id=$1 AND known_at<=$2 LIMIT 1", [input.entityId, input.knownAt]);
      if (!target.rowCount) throw new Error("Manual authorization requires a registered target");
      const fingerprint = hash([input.entityId, input.action, input.basisRef, input.effectiveAt, actor.actorId]);
      const inserted = await transaction.query(`INSERT INTO forward_manual_radar_authorizations
        (authorization_id,entity_id,action,actor_id,actor_authorization_ref,basis_ref,fingerprint,effective_at,known_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [input.authorizationId, input.entityId, input.action, actor.actorId, actor.authorizationEvidenceRef, input.basisRef, fingerprint, input.effectiveAt, input.knownAt]);
      if (!inserted.rowCount) {
        const stored = (await transaction.query("SELECT fingerprint FROM forward_manual_radar_authorizations WHERE authorization_id=$1", [input.authorizationId])).rows[0];
        if (stored?.fingerprint !== fingerprint) throw new Error("Manual authorization identity conflict");
        return { status: "duplicate" as const };
      }
      const head = (await transaction.query(`SELECT a.*,h.head_generation FROM forward_manual_radar_heads h
        JOIN forward_manual_radar_authorizations a ON a.authorization_id=h.authorization_id WHERE h.entity_id=$1`, [input.entityId])).rows[0];
      const stale = head && (integer(head.effective_at) > input.effectiveAt || (integer(head.effective_at) === input.effectiveAt &&
        ((head.action === "revoke" && input.action === "grant") || (head.action === input.action &&
          (integer(head.known_at) > input.knownAt || (integer(head.known_at) === input.knownAt && String(head.authorization_id) >= input.authorizationId))))));
      if (stale) return { status: "stale_event" as const };
      await transaction.query(`INSERT INTO forward_manual_radar_heads(entity_id,authorization_id,head_generation) VALUES($1,$2,$3)
        ON CONFLICT(entity_id) DO UPDATE SET authorization_id=excluded.authorization_id,head_generation=excluded.head_generation`,
      [input.entityId, input.authorizationId, head ? integer(head.head_generation) + 1 : 1]);
      await emit("manual_changed", input.entityId, input.authorizationId, input.knownAt);
      return { status: "applied" as const };
    },
    async readChannel(input: Pick<ForwardTargetChannelFact, "entityId" | "channel" | "subjectId" | "walletFamily"> & { readonly asOf: number }): Promise<ForwardTargetChannelState | null> {
      forwardEvidenceTime(input.asOf); const subjectKey = forwardTargetSubjectKey(input);
      if (!await control(input.entityId, false)) return null;
      const row = (await transaction.query(`SELECT * FROM forward_target_channel_versions WHERE entity_id=$1 AND channel=$2 AND subject_key=$3
        AND effective_at<=$4 AND known_at<=$4 ORDER BY effective_at DESC,known_at DESC,version_id COLLATE "C" DESC LIMIT 1`,
      [input.entityId, input.channel, subjectKey, input.asOf])).rows[0];
      if (!row) return null;
      const binding = (await transaction.query("SELECT * FROM forward_target_identity_bindings WHERE channel=$1 AND subject_key=$2 FOR SHARE", [input.channel, subjectKey])).rows[0];
      const available = binding && integer(binding.created_at) <= input.asOf;
      const conflict = available && binding.conflict_at !== null && integer(binding.conflict_at) <= input.asOf;
      return { fact: canonicalForwardTargetChannelFact(JSON.parse(String(row.payload)) as ForwardTargetChannelFact), versionId: String(row.version_id),
        bindingState: conflict ? "conflict" : available && binding.owner_entity_id === input.entityId ? "owned" : "unbound",
        bindingVersion: available ? JSON.stringify([binding.created_by_version, conflict ? binding.conflict_by_version : null]) : null };
    },
    async readManual(entityId: string, asOf: number): Promise<ForwardManualRadarAuthorization | null> {
      forwardEvidenceTime(asOf); if (!await control(entityId, false)) return null;
      const row = (await transaction.query(`SELECT * FROM forward_manual_radar_authorizations WHERE entity_id=$1 AND effective_at<=$2 AND known_at<=$2
        ORDER BY effective_at DESC,(action='revoke') DESC,known_at DESC,authorization_id COLLATE "C" DESC LIMIT 1`, [entityId, asOf])).rows[0];
      if (!row) return null;
      return { authorizationId: String(row.authorization_id), entityId: String(row.entity_id), action: row.action as "grant" | "revoke",
        actorId: String(row.actor_id), basisRef: String(row.basis_ref), effectiveAt: integer(row.effective_at), knownAt: integer(row.known_at) };
    },
    async page(input: { readonly channel: ForwardTargetChannel; readonly asOf: number; readonly limit: number; readonly after: { readonly entityId: string; readonly subjectKey: string } | null }) {
      forwardEvidenceTime(input.asOf);
      if (!["fomo", "wallet"].includes(input.channel) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error("Invalid target registry budget");
      const rows = (await transaction.query(`SELECT h.entity_id,h.subject_key,v.payload FROM forward_target_channel_heads h
        JOIN forward_target_channel_versions v ON v.version_id=h.version_id WHERE h.channel=$1 AND v.known_at<=$2
        AND ($3::text IS NULL OR (h.entity_id COLLATE "C",h.subject_key COLLATE "C")>($3::text COLLATE "C",$4::text COLLATE "C"))
        ORDER BY h.entity_id COLLATE "C",h.subject_key COLLATE "C" LIMIT $5`,
      [input.channel, input.asOf, input.after?.entityId ?? null, input.after?.subjectKey ?? null, input.limit + 1])).rows;
      const page = rows.slice(0, input.limit); const last = page.at(-1);
      return { facts: page.map(row => canonicalForwardTargetChannelFact(JSON.parse(String(row.payload)) as ForwardTargetChannelFact)),
        nextCursor: rows.length > input.limit && last ? { entityId: String(last.entity_id), subjectKey: String(last.subject_key) } : null };
    },
  });
}
