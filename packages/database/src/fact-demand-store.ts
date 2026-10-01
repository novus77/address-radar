import type { DatabaseSync } from "node:sqlite";
import { satisfiesFactDemand, type ConsumerFactDemand } from "@address-radar/domain";
import { withAddressRadarWriteTransaction } from "./connection.js";

export interface PersistedFactDemand extends ConsumerFactDemand {
  readonly status: "pending" | "satisfied";
}

export function initializeFactDemandSchema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS consumer_fact_demands (
    demand_id TEXT PRIMARY KEY, consumer_id TEXT NOT NULL, purchase_id TEXT NOT NULL,
    token_id TEXT NOT NULL, strategy_version TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('positive_hit','complete_range')),
    required_from INTEGER NOT NULL, required_to INTEGER NOT NULL,
    evaluated_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','satisfied')),
    reason_code TEXT NOT NULL, payload TEXT NOT NULL,
    CHECK(required_from >= 0 AND required_to >= required_from AND evaluated_at >= required_to)
  );
  CREATE INDEX IF NOT EXISTS consumer_fact_demands_pending ON consumer_fact_demands(status,token_id,purpose);
  CREATE INDEX IF NOT EXISTS consumer_fact_demands_consumer ON consumer_fact_demands(consumer_id,strategy_version,evaluated_at);`);
}

export function createFactDemandStore(database: DatabaseSync) {
  const get = (id: string): PersistedFactDemand | null => {
    const row = database.prepare("SELECT payload FROM consumer_fact_demands WHERE demand_id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as PersistedFactDemand : null;
  };
  return Object.freeze({
    get,
    record(input: ConsumerFactDemand): PersistedFactDemand {
      for (const value of [input.requiredFrom, input.requiredTo, input.evaluatedAt]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Fact demand timestamps must be non-negative safe integers");
      }
      if (input.requiredFrom > input.requiredTo || input.requiredTo > input.evaluatedAt) throw new Error("Invalid fact demand interval");
      return withAddressRadarWriteTransaction(database, () => {
        const current = get(input.demandId);
        if (current && ["consumerId", "purchaseId", "tokenId", "strategyVersion", "purpose", "requiredFrom"].some(key =>
          current[key as keyof ConsumerFactDemand] !== input[key as keyof ConsumerFactDemand])) throw new Error("Fact demand identity conflict");
        if (current && input.evaluatedAt < current.evaluatedAt) return current;
        const incomingSatisfied = satisfiesFactDemand(input);
        const currentSatisfied = current !== null && satisfiesFactDemand(input, current.proof);
        const preserveStronger = currentSatisfied && input.purpose === "positive_hit"
          && (!incomingSatisfied || current!.proof!.maximumMultiple! >= input.proof!.maximumMultiple!);
        const proof = preserveStronger ? current!.proof
          : incomingSatisfied ? input.proof : currentSatisfied ? current!.proof : null;
        const value: PersistedFactDemand = Object.freeze({ ...input, proof,
          status: proof ? "satisfied" : "pending",
          reasonCode: proof && (preserveStronger || !incomingSatisfied) ? current!.reasonCode : input.reasonCode,
        });
        database.prepare(`INSERT INTO consumer_fact_demands(demand_id,consumer_id,purchase_id,token_id,strategy_version,purpose,
          required_from,required_to,evaluated_at,status,reason_code,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(demand_id) DO UPDATE SET required_to=excluded.required_to,evaluated_at=excluded.evaluated_at,
          status=excluded.status,reason_code=excluded.reason_code,payload=excluded.payload`).run(
          value.demandId,value.consumerId,value.purchaseId,value.tokenId,value.strategyVersion,value.purpose,
          value.requiredFrom,value.requiredTo,value.evaluatedAt,value.status,value.reasonCode,JSON.stringify(value));
        return value;
      });
    },
  });
}
