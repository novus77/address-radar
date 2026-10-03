import { createHash } from "node:crypto";
import { createPostgresForwardTargetAuthorizationRepository, type LegacyForwardTargetLookup,
  type LegacyForwardTargetSnapshot, type PostgresTransaction } from "@address-radar/database";
import type { ForwardTargetChannel, ForwardTargetPrincipal } from "@address-radar/domain";
import type { ConsoleResult } from "./application.js";

export interface ForwardTargetDecisionQuery extends Omit<LegacyForwardTargetLookup,"capturedAt"> { readonly generationId: string; readonly asOf: number; }
export interface ForwardTargetRegistryQuery { readonly channel: ForwardTargetChannel; readonly asOf: number; readonly limit: number; readonly after: { entityId: string; subjectKey: string } | null; }
export interface ForwardTargetConsoleExtension {
  handle(input: { method: string; url: URL; body?: unknown; principal: ForwardTargetPrincipal }): Promise<ConsoleResult>;
}
export interface ForwardTargetControlOptions {
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly source: { read(input: LegacyForwardTargetLookup): LegacyForwardTargetSnapshot | null };
  readonly generationId: string;
  readonly now: () => number;
  readonly readAuthorization: (transaction: PostgresTransaction, input: ForwardTargetDecisionQuery) => Promise<unknown>;
  readonly readRegistry: (transaction: PostgresTransaction, input: ForwardTargetRegistryQuery) => Promise<unknown>;
}
class ControlError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new ControlError(400,"invalid_target_control_input");
  return value.trim();
};
const fields = (body: unknown, allowed: readonly string[]): Record<string,unknown> => {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new ControlError(400,"invalid_target_control_input");
  return body as Record<string,unknown>;
};
const lookup = (body: Record<string,unknown>): Omit<LegacyForwardTargetLookup,"capturedAt"> => {
  const channel = text(body.channel);
  if (channel !== "fomo" && channel !== "wallet") throw new ControlError(400,"invalid_target_channel");
  const walletFamily = body.walletFamily ?? null;
  if (channel === "fomo" ? walletFamily !== null : walletFamily !== "evm" && walletFamily !== "solana") throw new ControlError(400,"invalid_target_family");
  return { entityId: text(body.entityId),channel,subjectId: text(body.subjectId),walletFamily: walletFamily as "evm" | "solana" | null };
};
const requirePermission = (principal: ForwardTargetPrincipal, permission: ForwardTargetPrincipal["permissions"][number]) => {
  if (!principal?.actorId?.trim() || !principal.authorizationEvidenceRef?.trim() || !principal.permissions.includes(permission)) throw new ControlError(403,"target_control_forbidden");
};
const decision = (options: ForwardTargetControlOptions, transaction: PostgresTransaction, key: Omit<LegacyForwardTargetLookup,"capturedAt">, now: number) =>
  options.readAuthorization(transaction,{ ...key,generationId: options.generationId,asOf: now });

export const createForwardTargetConsoleApplication = (options: ForwardTargetControlOptions): ForwardTargetConsoleExtension => {
  text(options.generationId);
  return { async handle({ method,url,body,principal }): Promise<ConsoleResult> {
    try {
      const now = options.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid target control clock");
      if (method === "GET" && url.pathname === "/api/v2/forward-targets/state") {
        const key = lookup(fields(Object.fromEntries(url.searchParams),["entityId","channel","subjectId","walletFamily"]));
        return { status: 200,body: { state: await options.run(transaction => decision(options,transaction,key,now)),sourceVerificationMode: "last_hydrated_snapshot",otherSignalGatesRequired: true } };
      }
      if (method === "GET" && url.pathname === "/api/v2/forward-targets/registry") {
        const input = fields(Object.fromEntries(url.searchParams),["channel","limit","afterEntityId","afterSubjectKey"]);
        const channel = text(input.channel);
        if (channel !== "fomo" && channel !== "wallet") throw new ControlError(400,"invalid_target_channel");
        const limit = input.limit === undefined ? 100 : Number(input.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ControlError(400,"invalid_target_page_limit");
        const after = input.afterEntityId === undefined && input.afterSubjectKey === undefined ? null : { entityId: text(input.afterEntityId),subjectKey: text(input.afterSubjectKey) };
        return { status: 200,body: await options.run(transaction => options.readRegistry(transaction,{ channel,asOf: now,limit,after })) };
      }
      if (method === "POST" && url.pathname === "/api/v2/forward-targets/hydrate") {
        requirePermission(principal,"target_registry_write");
        const key = lookup(fields(body,["entityId","channel","subjectId","walletFamily"]));
        const snapshot = options.source.read({ ...key,capturedAt: now });
        if (!snapshot) throw new ControlError(404,"verified_identity_source_not_found");
        const versionId = `legacy-target:${createHash("sha256").update(JSON.stringify([snapshot.sourceFingerprint,principal.actorId,principal.authorizationEvidenceRef])).digest("hex")}`;
        const result = await options.run(async transaction => {
          const repository = createPostgresForwardTargetAuthorizationRepository(transaction,principal);
          const writeResult = await repository.recordChannel({ ...snapshot.fact,versionId,effectiveAt: snapshot.sourceObservedAt,knownAt: now });
          return { writeResult,state: await decision(options,transaction,{ ...key,subjectId: snapshot.fact.subjectId },now) };
        });
        return { status: 200,body: { ...result,proofScope: snapshot.proofScope,sourceObservedAt: snapshot.sourceObservedAt,capturedAt: now,otherSignalGatesRequired: true } };
      }
      if (method === "POST" && url.pathname === "/api/v2/forward-targets/manual-authorization") {
        requirePermission(principal,"radar_authorization_write");
        const input = fields(body,["authorizationId","entityId","action","basisRef"]);
        const authorizationId = text(input.authorizationId),entityId = text(input.entityId),basisRef = text(input.basisRef);
        if (input.action !== "grant" && input.action !== "revoke") throw new ControlError(400,"invalid_manual_authorization_action");
        const action = input.action;
        const result = await options.run(async transaction => {
          await transaction.query("INSERT INTO forward_target_control_locks(entity_id) VALUES($1) ON CONFLICT DO NOTHING",[entityId]);
          await transaction.query("SELECT entity_id FROM forward_target_control_locks WHERE entity_id=$1 FOR UPDATE",[entityId]);
          const registered = await transaction.query("SELECT 1 FROM forward_target_channel_heads WHERE entity_id=$1 LIMIT 1",[entityId]);
          if (!registered.rows.length) throw new ControlError(404,"forward_target_not_registered");
          const existing = (await transaction.query("SELECT entity_id,action,basis_ref,actor_id,actor_authorization_ref,effective_at,known_at FROM forward_manual_radar_authorizations WHERE authorization_id=$1",[authorizationId])).rows[0];
          if (existing && (existing.entity_id !== entityId || existing.action !== action || existing.basis_ref !== basisRef || existing.actor_id !== principal.actorId || existing.actor_authorization_ref !== principal.authorizationEvidenceRef)) throw new ControlError(409,"manual_authorization_id_conflict");
          const repository = createPostgresForwardTargetAuthorizationRepository(transaction,principal);
          const writeResult = await repository.recordManual({ authorizationId,entityId,action,basisRef,effectiveAt: Number(existing?.effective_at ?? now),knownAt: Number(existing?.known_at ?? now) });
          return { writeResult,manualAuthorization: await repository.readManual(entityId,now),otherSignalGatesRequired: true };
        });
        return { status: 200,body: result };
      }
      return { status: 404,body: { error: "forward_target_route_not_found" } };
    } catch (error) {
      return { status: error instanceof ControlError ? error.status : 500,body: { error: error instanceof ControlError ? error.code : "forward_target_control_failed" } };
    }
  } };
};
