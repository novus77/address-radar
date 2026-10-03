import { createHash, randomUUID } from "node:crypto";
import {
  assessForwardOpportunity, canonicalForwardPeak, forwardEvidenceIdentifier, forwardEvidenceTime,
  forwardQualifyingBuyAmount, FORWARD_OPPORTUNITY_WINDOW_MS, FORWARD_OPPORTUNITY_EVIDENCE_VERSION,
  type ForwardPeakEvidence, type ForwardOpportunitySample, type ForwardOpportunityEvaluation,
} from "@address-radar/domain";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL = `
CREATE TABLE forward_peak_evidence (
  peak_id text NOT NULL, revision_id text NOT NULL, chain text NOT NULL, token_address text NOT NULL,
  price_usd numeric NOT NULL CHECK(price_usd>0), verification text NOT NULL CHECK(verification IN ('validated','pending_review')),
  observed_from bigint NOT NULL, observed_until bigint NOT NULL, known_at bigint NOT NULL,
  evidence_ref text NOT NULL, fingerprint text NOT NULL, payload text NOT NULL,
  PRIMARY KEY(peak_id,revision_id), CHECK(observed_until>=observed_from AND known_at>=observed_until)
);
CREATE INDEX forward_peak_token_range ON forward_peak_evidence(chain,token_address,observed_from,known_at);
CREATE TABLE forward_opportunity_evaluations (
  evaluation_id text PRIMARY KEY, sample_id text NOT NULL REFERENCES forward_purchase_samples(sample_id),
  execution_fingerprint text NOT NULL, strategy_version text NOT NULL, input_fingerprint text NOT NULL,
  status text NOT NULL CHECK(status IN ('hit','observing','awaiting_verification','insufficient_coverage','excluded')),
  tier integer NOT NULL, reason_code text NOT NULL, peak_id text, peak_revision_id text,
  computed_at bigint NOT NULL, payload text NOT NULL,
  UNIQUE(sample_id,execution_fingerprint,strategy_version,input_fingerprint),
  FOREIGN KEY(peak_id,peak_revision_id) REFERENCES forward_peak_evidence(peak_id,revision_id) MATCH FULL,
  CHECK((status='hit' AND tier IN (3,5) AND peak_id IS NOT NULL) OR (status<>'hit' AND tier=0))
);
CREATE TABLE forward_opportunity_heads (
  sample_id text PRIMARY KEY REFERENCES forward_purchase_samples(sample_id),
  evaluation_id text NOT NULL REFERENCES forward_opportunity_evaluations(evaluation_id)
);
CREATE TABLE forward_opportunity_intents (
  intent_id text PRIMARY KEY, evaluation_id text NOT NULL UNIQUE REFERENCES forward_opportunity_evaluations(evaluation_id),
  intent_type text NOT NULL CHECK(intent_type='forward_opportunity_changed'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched')), created_at bigint NOT NULL
);
`;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createPostgresForwardOpportunityRepository(transaction: PostgresTransaction) {
  async function sample(sampleId: string, lock = false): Promise<ForwardOpportunitySample | null> {
    forwardEvidenceIdentifier(sampleId);
    const rows = await transaction.query(`SELECT s.*,r.amount_usd::text AS amount_usd,r.amount_estimated,
      r.entry_price_usd::text AS entry_price_usd,r.execution_evidence_ref,r.state AS revision_state
      FROM forward_purchase_samples s JOIN forward_trade_revisions r
        ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
      WHERE s.sample_id=$1${lock ? " FOR UPDATE OF s" : ""}`, [sampleId]);
    const row = rows.rows[0];
    if (!row) return null;
    return Object.freeze({ sampleId: String(row.sample_id), executionFingerprint: String(row.execution_fingerprint),
      entityId: String(row.entity_id), chain: String(row.chain), tokenAddress: String(row.token_address),
      boughtAt: Number(row.occurred_at), amountUsd: String(row.amount_usd), amountEstimated: row.amount_estimated === true,
      entryPriceUsd: row.entry_price_usd === null ? null : String(row.entry_price_usd),
      entryBasisVerified: row.revision_state === "original" && typeof row.execution_evidence_ref === "string" && !!row.execution_evidence_ref.trim(),
      executionEvidenceRef: row.execution_evidence_ref === null ? null : String(row.execution_evidence_ref) });
  }
  async function peak(peakId: string, revisionId: string): Promise<ForwardPeakEvidence | null> {
    const result = await transaction.query("SELECT payload FROM forward_peak_evidence WHERE peak_id=$1 AND revision_id=$2", [peakId, revisionId]);
    return result.rows[0] ? canonicalForwardPeak(JSON.parse(String(result.rows[0].payload)) as ForwardPeakEvidence) : null;
  }
  async function head(sampleId: string): Promise<ForwardOpportunityEvaluation | null> {
    const result = await transaction.query(`SELECT e.payload FROM forward_opportunity_heads h
      JOIN forward_opportunity_evaluations e USING(evaluation_id) WHERE h.sample_id=$1`, [sampleId]);
    return result.rows[0] ? JSON.parse(String(result.rows[0].payload)) as ForwardOpportunityEvaluation : null;
  }
  return Object.freeze({
    getSample: sample,
    getHead: head,
    async recordPeak(input: ForwardPeakEvidence): Promise<"inserted" | "duplicate"> {
      const value = canonicalForwardPeak(input);
      const { knownAt: _knownAt, ...semantic } = value;
      const hash = fingerprint(semantic);
      const from = value.kind === "trade" ? value.occurredAt : value.openedAt;
      const until = value.kind === "trade" ? value.occurredAt : value.closedAt;
      const inserted = await transaction.query(`INSERT INTO forward_peak_evidence(peak_id,revision_id,chain,token_address,
        price_usd,verification,observed_from,observed_until,known_at,evidence_ref,fingerprint,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(peak_id,revision_id) DO NOTHING RETURNING peak_id`,
      [value.peakId,value.revisionId,value.chain,value.tokenAddress,value.priceUsd,value.verification,from,until,
        value.knownAt,value.evidenceRef,hash,JSON.stringify(value)]);
      if (inserted.rows.length) return "inserted";
      const existing = await transaction.query("SELECT fingerprint FROM forward_peak_evidence WHERE peak_id=$1 AND revision_id=$2", [value.peakId,value.revisionId]);
      if (existing.rows[0]?.fingerprint !== hash) throw new Error("Immutable forward peak revision conflict");
      return "duplicate";
    },
    async listPeaks(input: ForwardOpportunitySample, asOf: number): Promise<readonly ForwardPeakEvidence[]> {
      forwardEvidenceTime(asOf);
      const result = await transaction.query(`SELECT payload FROM forward_peak_evidence WHERE chain=$1 AND token_address=$2
        AND observed_until>=$3 AND observed_from<$4 AND known_at<=$5 ORDER BY peak_id,revision_id`,
      [input.chain,input.tokenAddress,input.boughtAt,input.boughtAt+FORWARD_OPPORTUNITY_WINDOW_MS,asOf]);
      return result.rows.map(row => canonicalForwardPeak(JSON.parse(String(row.payload)) as ForwardPeakEvidence));
    },
    async saveEvaluation(input: ForwardOpportunityEvaluation): Promise<{ readonly status: "stored" | "duplicate" | "retained_head" | "stale_execution"; readonly evaluationId: string | null }> {
      [input.sampleId,input.executionFingerprint,input.reasonCode].forEach(forwardEvidenceIdentifier);
      forwardEvidenceTime(input.computedAt); forwardEvidenceTime(input.expiresAt);
      if (input.strategyVersion !== FORWARD_OPPORTUNITY_EVIDENCE_VERSION
        || !["hit","observing","awaiting_verification","insufficient_coverage","excluded"].includes(input.status)
        || (input.status === "hit" ? ![3,5].includes(input.tier) : input.tier !== 0)) throw new Error("Invalid forward opportunity result");
      const current = await sample(input.sampleId, true);
      if (!current || current.executionFingerprint !== input.executionFingerprint) return { status: "stale_execution", evaluationId: null };
      if (input.computedAt < current.boughtAt || input.expiresAt !== current.boughtAt+FORWARD_OPPORTUNITY_WINDOW_MS
        || input.amountEstimated !== current.amountEstimated || (input.peakId === null) !== (input.peakRevisionId === null)) {
        throw new Error("Forward opportunity sample binding mismatch");
      }
      if (input.peakId !== null && input.peakRevisionId !== null) {
        const selected = await peak(input.peakId,input.peakRevisionId);
        const from = selected?.kind === "trade" ? selected.occurredAt : selected?.openedAt;
        const to = selected?.kind === "trade" ? selected.occurredAt : selected?.closedAt;
        if (!selected || selected.verification !== "validated" || selected.chain !== current.chain || selected.tokenAddress !== current.tokenAddress
          || selected.knownAt>input.computedAt || from!<current.boughtAt || from!>=input.expiresAt || to!>input.computedAt || to!>input.expiresAt) {
          throw new Error("Forward opportunity peak binding mismatch");
        }
        if (input.status === "hit") {
          const verified = assessForwardOpportunity({ boughtAt:current.boughtAt,now:input.computedAt,
            entryPriceUsd:current.entryPriceUsd,entryBasisVerified:current.entryBasisVerified,
            peak:{priceUsd:selected.priceUsd,occurredAt:from!,verification:"validated"} });
          if (!forwardQualifyingBuyAmount(current.amountUsd) || !current.executionEvidenceRef
            || verified.status !== "confirmed" || verified.tier !== input.tier) throw new Error("Forward opportunity hit is not proven");
        }
      } else if (input.status === "hit") throw new Error("Forward opportunity hit requires peak evidence");
      const semantic = { strategyVersion:input.strategyVersion,sampleId:input.sampleId,executionFingerprint:input.executionFingerprint,
        status:input.status,tier:input.tier,reasonCode:input.reasonCode,peakId:input.peakId,peakRevisionId:input.peakRevisionId,
        amountEstimated:input.amountEstimated,expiresAt:input.expiresAt };
      const hash = fingerprint(semantic);
      const value = { ...semantic,computedAt:input.computedAt };
      await transaction.query(`INSERT INTO forward_opportunity_evaluations(evaluation_id,sample_id,execution_fingerprint,strategy_version,
        input_fingerprint,status,tier,reason_code,peak_id,peak_revision_id,computed_at,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(sample_id,execution_fingerprint,strategy_version,input_fingerprint) DO NOTHING`,
      [randomUUID(),input.sampleId,input.executionFingerprint,input.strategyVersion,hash,input.status,input.tier,input.reasonCode,
        input.peakId,input.peakRevisionId,input.computedAt,JSON.stringify(value)]);
      const result = await transaction.query(`SELECT evaluation_id FROM forward_opportunity_evaluations
        WHERE sample_id=$1 AND execution_fingerprint=$2 AND strategy_version=$3 AND input_fingerprint=$4`,
      [input.sampleId,input.executionFingerprint,input.strategyVersion,hash]);
      const evaluationId = String(result.rows[0]?.evaluation_id ?? "");
      if (!evaluationId) throw new Error("Forward opportunity result was not persisted");
      const previous = await transaction.query("SELECT evaluation_id FROM forward_opportunity_heads WHERE sample_id=$1", [input.sampleId]);
      if (previous.rows[0]?.evaluation_id === evaluationId) return { status:"duplicate",evaluationId };
      const prior = await head(input.sampleId);
      if (prior?.executionFingerprint === input.executionFingerprint && (prior.computedAt>input.computedAt
        || (prior.status === "hit" && (input.status !== "hit" || prior.tier>input.tier)))) return { status:"retained_head",evaluationId };
      await transaction.query(`INSERT INTO forward_opportunity_heads(sample_id,evaluation_id) VALUES($1,$2)
        ON CONFLICT(sample_id) DO UPDATE SET evaluation_id=EXCLUDED.evaluation_id`, [input.sampleId,evaluationId]);
      await transaction.query(`INSERT INTO forward_opportunity_intents(intent_id,evaluation_id,intent_type,created_at)
        VALUES($1,$2,'forward_opportunity_changed',$3) ON CONFLICT(evaluation_id) DO NOTHING`, [`opportunity:${evaluationId}`,evaluationId,input.computedAt]);
      return { status:"stored",evaluationId };
    },
  });
}
