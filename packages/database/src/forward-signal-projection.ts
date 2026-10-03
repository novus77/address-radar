import { createHash } from "node:crypto";
import { evaluateForwardSignal,FORWARD_SIGNAL_WINDOW_MS,FORWARD_SIGNAL_STRATEGY_VERSION,forwardEvidenceIdentifier,forwardEvidenceTime,type ForwardOpportunitySample,type ForwardSignalEvidence } from "@address-radar/domain";
import { readPostgresFreshForwardTargetAuthorization,type ForwardTargetDecisionReader,type ForwardTargetRefreshKey } from "./forward-target-revalidation.js";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";
export const POSTGRES_FORWARD_SIGNAL_SCHEMA_SQL = `
CREATE TABLE forward_signal_token_locks(generation_id text NOT NULL,chain text NOT NULL,token_address text NOT NULL,PRIMARY KEY(generation_id,chain,token_address));
CREATE TABLE forward_signal_evaluations(evaluation_id text PRIMARY KEY,generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),chain text NOT NULL,token_address text NOT NULL,assessed_at bigint NOT NULL,strategy_version text NOT NULL,input_fingerprint text NOT NULL,action text NOT NULL CHECK(action IN ('observe','deferred','ready')),payload text NOT NULL);
CREATE TABLE forward_signal_readiness_intents(signal_id text PRIMARY KEY,evaluation_id text NOT NULL REFERENCES forward_signal_evaluations(evaluation_id),generation_id text NOT NULL,chain text NOT NULL,token_address text NOT NULL,created_at bigint NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','cancelled')),payload text NOT NULL);
CREATE TABLE forward_signal_execution_receipts(evaluation_id text NOT NULL REFERENCES forward_signal_evaluations(evaluation_id),sample_id text NOT NULL REFERENCES forward_purchase_samples(sample_id),execution_fingerprint text NOT NULL,refresh_id text NOT NULL REFERENCES forward_target_identity_refresh_receipts(refresh_id),authorization_stamp text NOT NULL,PRIMARY KEY(evaluation_id,sample_id));
CREATE TABLE forward_signal_economic_consumption(generation_id text NOT NULL,chain text NOT NULL,token_address text NOT NULL,trade_id text NOT NULL REFERENCES forward_economic_trades(trade_id),signal_id text NOT NULL REFERENCES forward_signal_readiness_intents(signal_id),PRIMARY KEY(generation_id,chain,token_address,trade_id));
CREATE TABLE forward_signal_readiness_checks(check_id text PRIMARY KEY,signal_id text NOT NULL REFERENCES forward_signal_readiness_intents(signal_id),checked_at bigint NOT NULL,status text NOT NULL CHECK(status IN ('validated','deferred','cancelled')),payload text NOT NULL);
`;
export interface ForwardSignalSafetyAssessment {
  readonly sampleId: string; readonly executionFingerprint: string; readonly assessedAt: number; readonly target: ForwardTargetRefreshKey;
  readonly independenceKey: string | null; readonly riskVerdict: "validated" | "pending" | "blocked"; readonly riskEvidenceRef: string | null;
  readonly liveSourceVerified: boolean; readonly sourceEvidenceRef: string | null;
}
export interface ForwardSignalProjectionInput {
  readonly generationId: string; readonly chain: string; readonly tokenAddress: string; readonly asOf: number; readonly inputLimit: number;
  readonly safety: readonly ForwardSignalSafetyAssessment[]; readonly readAuthorization: ForwardTargetDecisionReader;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validate = (input: ForwardSignalProjectionInput) => {
  for (const identifier of [input.generationId,input.chain,input.tokenAddress]) forwardEvidenceIdentifier(identifier);
  forwardEvidenceTime(input.asOf);
  if (!Number.isSafeInteger(input.inputLimit) || input.inputLimit < 1 || input.inputLimit > 1000) throw new Error("Explicit bounded signal input budget required");
  if (new Set(input.safety.map(item => item.sampleId)).size !== input.safety.length) throw new Error("Duplicate signal safety assessment");
};
async function readInputs(transaction: PostgresTransaction,input: ForwardSignalProjectionInput,includeConsumed: boolean,tradeIds: readonly string[] | null = null) {
  const rows = (await transaction.query(`SELECT s.sample_id,s.trade_id,s.execution_fingerprint,s.entity_id,s.chain,s.token_address,s.occurred_at,
    r.amount_usd::text amount_usd,r.amount_estimated,r.entry_price_usd::text entry_price_usd,r.execution_evidence_ref,r.ownership_evidence_ref,r.state,
    t.original_fingerprint,EXISTS(SELECT 1 FROM forward_trade_revisions pending WHERE pending.trade_id=s.trade_id AND pending.state='pending_review') pending_review
    FROM forward_purchase_samples s JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
    JOIN forward_economic_trades t ON t.trade_id=s.trade_id JOIN forward_strategy_generations g ON g.generation_id=s.generation_id
    WHERE s.generation_id=$1 AND s.chain=$2 AND s.token_address=$3 AND s.occurred_at>=$4 AND s.occurred_at<=$5
      AND s.created_at<=$5 AND g.activated_at<=s.occurred_at AND r.recorded_at<=$5
      AND ($6::boolean OR NOT EXISTS(SELECT 1 FROM forward_signal_economic_consumption c WHERE c.generation_id=s.generation_id AND c.chain=s.chain AND c.token_address=s.token_address AND c.trade_id=s.trade_id))
      AND ($7::text[] IS NULL OR s.trade_id=ANY($7::text[])) ORDER BY s.entity_id,s.trade_id,s.sample_id LIMIT $8`,
    [input.generationId,input.chain,input.tokenAddress,input.asOf-FORWARD_SIGNAL_WINDOW_MS,input.asOf,includeConsumed,tradeIds,input.inputLimit+1])).rows;
  if (rows.length > input.inputLimit) return { exceeded: true,evidence: [] as ForwardSignalEvidence[] };
  const evidence: ForwardSignalEvidence[] = [];
  for (const row of rows) {
    const sample: ForwardOpportunitySample = { sampleId: String(row.sample_id),executionFingerprint: String(row.execution_fingerprint),entityId: String(row.entity_id),chain: String(row.chain),tokenAddress: String(row.token_address),
      boughtAt: Number(row.occurred_at),amountUsd: String(row.amount_usd),amountEstimated: row.amount_estimated === true,entryPriceUsd: String(row.entry_price_usd),
      entryBasisVerified: row.state === "original" && row.execution_fingerprint === row.original_fingerprint && row.pending_review !== true && Boolean(row.ownership_evidence_ref),executionEvidenceRef: String(row.execution_evidence_ref) };
    const assessment = input.safety.find(item => item.sampleId === sample.sampleId);
    const matched = assessment && assessment.assessedAt === input.asOf && assessment.executionFingerprint === sample.executionFingerprint && assessment.target.entityId === sample.entityId;
    const fresh = matched ? await readPostgresFreshForwardTargetAuthorization(transaction,{ ...assessment.target,generationId: input.generationId,asOf: input.asOf },input.readAuthorization) : null;
    evidence.push({ sample,economicKey: String(row.trade_id),radarEligible: fresh?.radarEligible === true,
      qualificationPending: !fresh || fresh.status !== "verified",authorizationStamp: fresh?.authorizationStamp ?? null,refreshReceiptId: fresh?.refreshReceiptId ?? null,
      liveSourceVerified: matched === true && assessment.liveSourceVerified === true,sourceEvidenceRef: matched ? assessment.sourceEvidenceRef : null,
      independenceKey: matched ? assessment.independenceKey : null,riskVerdict: matched ? assessment.riskVerdict : "pending",riskEvidenceRef: matched ? assessment.riskEvidenceRef : null });
  }
  return { exceeded: false,evidence };
}
async function lockToken(transaction: PostgresTransaction,input: ForwardSignalProjectionInput) {
  await transaction.query("INSERT INTO forward_signal_token_locks(generation_id,chain,token_address) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[input.generationId,input.chain,input.tokenAddress]);
  await transaction.query("SELECT generation_id FROM forward_signal_token_locks WHERE generation_id=$1 AND chain=$2 AND token_address=$3 FOR UPDATE",[input.generationId,input.chain,input.tokenAddress]);
}
export async function projectPostgresForwardSignal(transaction: PostgresTransaction,input: ForwardSignalProjectionInput) {
  validate(input); await lockToken(transaction,input);
  const inputs = await readInputs(transaction,input,false), evaluated = evaluateForwardSignal({ asOf: input.asOf,evidence: inputs.evidence });
  const decision = inputs.exceeded ? { ...evaluated,action: "deferred" as const,reasonCodes: ["signal_input_budget_exceeded"] } : evaluated;
  const fingerprint = hash([input.generationId,input.chain,input.tokenAddress,input.asOf,input.safety,inputs.evidence,decision]);
  const evaluationId = `forward-signal-evaluation:${fingerprint}`;
  await transaction.query(`INSERT INTO forward_signal_evaluations(evaluation_id,generation_id,chain,token_address,assessed_at,strategy_version,input_fingerprint,action,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[evaluationId,input.generationId,input.chain,input.tokenAddress,input.asOf,FORWARD_SIGNAL_STRATEGY_VERSION,fingerprint,decision.action,JSON.stringify(decision)]);
  if (decision.action !== "ready") return { evaluationId,signalId: null,decision,receiptCount: 0,gatewayDeliveryEnabled: false };
  const signalId = `forward-signal:${hash([input.generationId,input.chain,input.tokenAddress,decision.consumedEconomicKeys])}`;
  await transaction.query(`INSERT INTO forward_signal_readiness_intents(signal_id,evaluation_id,generation_id,chain,token_address,created_at,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[signalId,evaluationId,input.generationId,input.chain,input.tokenAddress,input.asOf,JSON.stringify({ economicKeys: decision.consumedEconomicKeys,sampleIds: decision.accepted.map(item => item.sample.sampleId) })]);
  for (const item of decision.accepted) {
    await transaction.query(`INSERT INTO forward_signal_execution_receipts(evaluation_id,sample_id,execution_fingerprint,refresh_id,authorization_stamp)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[evaluationId,item.sample.sampleId,item.sample.executionFingerprint,item.refreshReceiptId,item.authorizationStamp]);
    await transaction.query(`INSERT INTO forward_signal_economic_consumption(generation_id,chain,token_address,trade_id,signal_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[input.generationId,input.chain,input.tokenAddress,item.economicKey,signalId]);
  }
  return { evaluationId,signalId,decision,receiptCount: decision.accepted.length,gatewayDeliveryEnabled: false };
}
export async function validatePostgresForwardSignalReadiness(transaction: PostgresTransaction,input: ForwardSignalProjectionInput & { readonly signalId: string }) {
  validate(input); await lockToken(transaction,input);
  const intent = (await transaction.query("SELECT status,payload FROM forward_signal_readiness_intents WHERE signal_id=$1 AND generation_id=$2 AND chain=$3 AND token_address=$4 FOR UPDATE",[input.signalId,input.generationId,input.chain,input.tokenAddress])).rows[0];
  if (!intent || intent.status !== "pending") return { status: "cancelled" as const,valid: false,gatewayDeliveryEnabled: false };
  const stored = JSON.parse(String(intent.payload)) as { economicKeys: string[] };
  const inputs = await readInputs(transaction,input,true,stored.economicKeys), decision = evaluateForwardSignal({ asOf: input.asOf,evidence: inputs.evidence });
  const status = inputs.exceeded || decision.action === "deferred" ? "deferred" : decision.action === "ready" ? "validated" : "cancelled";
  const checkId = `forward-signal-check:${hash([input.signalId,input.asOf,input.safety,inputs.evidence,status])}`;
  await transaction.query("INSERT INTO forward_signal_readiness_checks(check_id,signal_id,checked_at,status,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[checkId,input.signalId,input.asOf,status,JSON.stringify({ reasonCodes: inputs.exceeded ? ["signal_input_budget_exceeded"] : decision.reasonCodes })]);
  if (status === "cancelled") await transaction.query("UPDATE forward_signal_readiness_intents SET status='cancelled' WHERE signal_id=$1 AND status='pending'",[input.signalId]);
  return { status,valid: status === "validated",gatewayDeliveryEnabled: false };
}
