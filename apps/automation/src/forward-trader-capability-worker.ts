import { createHash } from "node:crypto";
import { createPostgresForwardTraderCapabilityRepository, type PostgresTransaction } from "@address-radar/database";
import { evaluateForwardTraderCapability } from "@address-radar/scoring";

export async function projectPostgresForwardTraderCapability(transaction: PostgresTransaction,
  input: { readonly entityId: string; readonly generationId: string; readonly asOf: number; readonly maximumSamples: number }) {
  const repository = createPostgresForwardTraderCapabilityRepository(transaction);
  const loaded = await repository.load(input);
  if (loaded.status === "deferred") return loaded;
  const projection = evaluateForwardTraderCapability({ ...input, activatedAt: loaded.activatedAt, facts: loaded.facts });
  const selected = new Set(projection.sampleIds);
  const basis = loaded.facts.filter(fact => selected.has(fact.sample.sampleId)).map(fact => [fact.sample.sampleId,
    fact.sample.executionFingerprint, fact.evaluationId, fact.peak?.peakId ?? null, fact.peak?.revisionId ?? null,
    fact.screening?.evidenceRef ?? null]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const basisFingerprint = createHash("sha256").update(JSON.stringify(basis)).digest("hex");
  return { ...await repository.save(projection, basisFingerprint), projection };
}
