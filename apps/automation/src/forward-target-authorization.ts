import { createHash } from "node:crypto";
import { createPostgresForwardTargetAuthorizationRepository, type PostgresTransaction } from "@address-radar/database";
import { evaluateForwardTargetAuthorization } from "@address-radar/identity";
import { FORWARD_TRADER_CAPABILITY_VERSION, forwardEvidenceIdentifier, forwardEvidenceTime,
  forwardTargetIdentityTrusted, type ForwardTargetChannelFact, type ForwardTraderCapabilityProjection } from "@address-radar/domain";

type TargetKey = Pick<ForwardTargetChannelFact, "entityId" | "channel" | "subjectId" | "walletFamily">;
export async function readPostgresForwardTargetAuthorization(transaction: PostgresTransaction, input: TargetKey & { readonly generationId: string; readonly asOf: number }) {
  forwardEvidenceIdentifier(input.generationId); forwardEvidenceTime(input.asOf);
  const generation = await transaction.query("SELECT 1 FROM forward_strategy_generations WHERE generation_id=$1 AND activated_at<=$2", [input.generationId, input.asOf]);
  if (!generation.rowCount) throw new Error("Unknown or inactive authorization generation");
  const repository = createPostgresForwardTargetAuthorizationRepository(transaction);
  const target = await repository.readChannel(input);
  if (!target) return { status: "unregistered" as const, radarEligible: false, monitoringEligible: false, authorizationStamp: null };
  const manualAuthorization = await repository.readManual(input.entityId, input.asOf);
  const head = (await transaction.query(`SELECT v.payload,h.version_id,h.evaluated_at FROM forward_trader_capability_heads h
    JOIN forward_trader_capability_versions v ON v.version_id=h.version_id WHERE h.entity_id=$1 AND h.generation_id=$2 AND h.strategy_version=$3 FOR SHARE OF h`,
  [input.entityId, input.generationId, FORWARD_TRADER_CAPABILITY_VERSION])).rows[0];
  const capability = head ? { projection: JSON.parse(String(head.payload)) as ForwardTraderCapabilityProjection,
    versionId: String(head.version_id), evaluatedAt: Number(head.evaluated_at) } : null;
  const eligibility = evaluateForwardTargetAuthorization({ target, manualAuthorization, capability, generationId: input.generationId, asOf: input.asOf });
  const usesCapability = eligibility.authorizationBasis === "system_stable" || eligibility.authorizationBasis === "manual_and_system_stable";
  const authorizationStamp = eligibility.radarEligible ? createHash("sha256").update(JSON.stringify([input.entityId, input.generationId,
    target.versionId, target.bindingVersion, manualAuthorization?.authorizationId ?? null, usesCapability ? capability!.versionId : null,
    eligibility.authorizationBasis])).digest("hex") : null;
  return { status: "evaluated" as const, ...eligibility, authorizationStamp, targetVersionId: target.versionId,
    manualAuthorizationId: manualAuthorization?.authorizationId ?? null, capabilityVersionId: capability?.versionId ?? null };
}
export async function validatePostgresForwardTargetAuthorizationStamp(transaction: PostgresTransaction, input: TargetKey & {
  readonly generationId: string; readonly asOf: number; readonly expectedStamp: string;
}) {
  forwardEvidenceIdentifier(input.expectedStamp);
  const current = await readPostgresForwardTargetAuthorization(transaction, input);
  return current.radarEligible && current.authorizationStamp === input.expectedStamp;
}
export async function readPostgresForwardTargetRegistry(transaction: PostgresTransaction, input: Parameters<ReturnType<typeof createPostgresForwardTargetAuthorizationRepository>["page"]>[0]) {
  const repository = createPostgresForwardTargetAuthorizationRepository(transaction); const page = await repository.page(input);
  const monitored: ForwardTargetChannelFact[] = [];
  for (const fact of page.facts) {
    const state = await repository.readChannel({ ...fact, asOf: input.asOf });
    if (state && state.bindingState === "owned" && forwardTargetIdentityTrusted(state.fact) && state.fact.monitoringEnabled && !state.fact.suspended) monitored.push(state.fact);
  }
  return { scanned: page.facts.length, monitored, nextCursor: page.nextCursor };
}
