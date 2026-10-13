import type { PostgresTransaction } from "@address-radar/database";

// Counts describe records in the selected generation, not profits or inferred qualifications.
const GENERATION_PROGRESS_SQL = `WITH bound AS MATERIALIZED (
  SELECT source_namespace,source_event_id,semantic_fingerprint,created_at
  FROM wallet_capture_generation_bindings WHERE generation_id=$1 AND created_at<=$2
), normalized AS MATERIALIZED (
  SELECT j.* FROM capture_normalization_jobs j JOIN bound b
    USING(source_namespace,source_event_id,semantic_fingerprint) WHERE j.requested_at<=$2
), samples AS MATERIALIZED (
  SELECT * FROM forward_purchase_samples WHERE generation_id=$1 AND created_at<=$2
), progress AS (
  SELECT 'capture'::text stage,'recorded'::text status,NULL::text reason_code,
    count(*)::text count,max(created_at)::text last_progress_at,
    count(*) FILTER(WHERE created_at>=$3)::text new_records_1h FROM bound
  UNION ALL SELECT 'normalization',status,failure_reason,count(*)::text,
    (max(completed_at) FILTER(WHERE completed_at<=$2))::text,count(*) FILTER(WHERE completed_at BETWEEN $3 AND $2)::text
    FROM normalized GROUP BY status,failure_reason
  UNION ALL SELECT 'consumer_work',j.status,j.failure_reason,count(*)::text,
    (max(j.completed_at) FILTER(WHERE j.completed_at<=$2))::text,count(*) FILTER(WHERE j.completed_at BETWEEN $3 AND $2)::text
    FROM capture_consumer_jobs j JOIN capture_consumer_intents i USING(intent_id)
    JOIN normalized n ON n.job_id=i.job_id GROUP BY j.status,j.failure_reason
  UNION ALL SELECT 'token_discovery','recorded',NULL,count(*)::text,
    max(first_discovered_at)::text,count(*) FILTER(WHERE first_discovered_at>=$3)::text
    FROM forward_token_watches WHERE generation_id=$1 AND first_discovered_at<=$2
  UNION ALL SELECT 'milestone_confirmation',threshold::text,NULL,count(*)::text,
    max(occurred_at)::text,count(*) FILTER(WHERE occurred_at>=$3)::text
    FROM forward_token_milestone_hits WHERE generation_id=$1 AND occurred_at<=$2 GROUP BY threshold
  UNION ALL SELECT 'purchase','recorded',NULL,count(*)::text,max(created_at)::text,
    count(*) FILTER(WHERE created_at>=$3)::text FROM samples
  UNION ALL SELECT 'opportunity',e.status,e.reason_code,count(*)::text,max(e.computed_at)::text,
    count(*) FILTER(WHERE e.computed_at>=$3)::text FROM forward_opportunity_heads h
    JOIN forward_opportunity_evaluations e USING(evaluation_id) JOIN samples s ON s.sample_id=h.sample_id
    WHERE e.execution_fingerprint=s.execution_fingerprint AND e.computed_at<=$2 GROUP BY e.status,e.reason_code
  UNION ALL SELECT 'opportunity_work',j.status,j.reason_code,count(*)::text,(max(j.completed_at) FILTER(WHERE j.completed_at<=$2))::text,
    count(*) FILTER(WHERE j.completed_at BETWEEN $3 AND $2)::text FROM forward_opportunity_jobs j
    JOIN samples s ON s.sample_id=j.sample_id AND s.execution_fingerprint=j.execution_fingerprint
    GROUP BY j.status,j.reason_code
  UNION ALL SELECT 'ability_evaluation',CASE WHEN v.stable_capability THEN 'stable' ELSE 'observing' END,
    NULL,count(*)::text,max(h.evaluated_at)::text,count(*) FILTER(WHERE h.evaluated_at>=$3)::text
    FROM forward_trader_capability_heads h JOIN forward_trader_capability_versions v USING(version_id)
    WHERE h.generation_id=$1 AND v.generation_id=$1 AND h.evaluated_at<=$2 GROUP BY v.stable_capability
  UNION ALL SELECT 'ability_work',status,reason_code,count(*)::text,(max(completed_at) FILTER(WHERE completed_at<=$2))::text,
    count(*) FILTER(WHERE completed_at BETWEEN $3 AND $2)::text FROM forward_capability_jobs
    WHERE generation_id=$1 AND latest_requested_at<=$2 GROUP BY status,reason_code
  UNION ALL SELECT 'signal_projection',action,NULL,count(*)::text,max(assessed_at)::text,
    count(*) FILTER(WHERE assessed_at>=$3)::text FROM forward_signal_evaluations
    WHERE generation_id=$1 AND assessed_at<=$2 GROUP BY action
  UNION ALL SELECT 'signal_readiness',status,NULL,count(*)::text,max(created_at)::text,
    count(*) FILTER(WHERE created_at>=$3)::text FROM forward_signal_readiness_intents
    WHERE generation_id=$1 AND created_at<=$2 GROUP BY status
) SELECT * FROM progress ORDER BY stage,status,reason_code NULLS FIRST LIMIT 201`;

export interface PostgresProgressRow {
  stage: string;
  status: string;
  reasonCode: string | null;
  count: string;
  lastProgressAt: number | null;
  newRecords1h: string;
}

const stages = new Set(["capture", "normalization", "consumer_work", "token_discovery", "milestone_confirmation",
  "purchase", "opportunity", "opportunity_work", "ability_evaluation", "ability_work", "signal_projection", "signal_readiness"]);
function count(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("Invalid PostgreSQL progress count");
  return value;
}
function timestamp(value: unknown, asOf: number): number | null {
  if (value === null) return null;
  const text = count(value), parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed > asOf) throw new Error("Invalid PostgreSQL progress timestamp");
  return parsed;
}

export async function readPostgresGenerationProgress(transaction: PostgresTransaction,
  input: { generationId: string; asOf: number }) {
  if (typeof input.generationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.generationId)
    || !Number.isSafeInteger(input.asOf) || input.asOf < 0) throw new Error("Invalid PostgreSQL progress scope");
  const result = await transaction.query(GENERATION_PROGRESS_SQL, [input.generationId, input.asOf, Math.max(0, input.asOf - 3_600_000)]);
  if (result.rows.length > 200) throw new Error("PostgreSQL progress reason budget exceeded");
  const seen = new Set<string>();
  const rows: PostgresProgressRow[] = result.rows.map(row => {
    if (typeof row.stage !== "string" || !stages.has(row.stage) || typeof row.status !== "string"
      || !row.status.trim() || row.status.length > 64 || (row.reason_code !== null
        && (typeof row.reason_code !== "string" || !row.reason_code.trim() || row.reason_code.length > 512))) {
      throw new Error("Invalid PostgreSQL progress group");
    }
    const key = JSON.stringify([row.stage, row.status, row.reason_code]);
    if (seen.has(key)) throw new Error("Duplicate PostgreSQL progress group");
    seen.add(key);
    const total = count(row.count), newRecords = count(row.new_records_1h);
    if (BigInt(newRecords) > BigInt(total)) throw new Error("Invalid PostgreSQL progress interval count");
    return { stage: row.stage, status: row.status, reasonCode: row.reason_code,
      count: total, lastProgressAt: timestamp(row.last_progress_at, input.asOf), newRecords1h: newRecords };
  });
  return {
    backend: "postgresql" as const, generationId: input.generationId, asOf: input.asOf,
    gatewayDeliveryEnabled: false as const, coverageVerified: false as const, runnableDelta15m: null,
    stages: rows, definitions: {
      totals: "Current generation records; stages and states must not be summed into unique traders.",
      newRecords1h: "Records in the returned state with their recorded progress timestamp in the previous hour; not net queue change.",
      opportunity: "Current sample heads for the current execution revision, not historical evaluations.",
      ability: "Current capability heads; observing is not stable qualification and task completion is not qualification.",
      readiness: "Stored readiness intent only; no delivered signal and no inferred coverage proof.",
      gaps: "No independently verified coverage interval or persisted baseline supplied; coverage and queue delta remain unknown.",
    },
  };
}
