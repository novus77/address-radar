import { createHash, randomUUID } from "node:crypto";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const FORWARD_PURCHASE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL = `
CREATE TABLE forward_strategy_generations (
  generation_id text PRIMARY KEY, activated_at bigint NOT NULL
);
CREATE TABLE forward_economic_trades (
  trade_id text PRIMARY KEY, chain text NOT NULL, execution_key text NOT NULL, original_fingerprint text NOT NULL,
  entity_id text NOT NULL, token_address text NOT NULL, occurred_at bigint NOT NULL,
  UNIQUE(chain,execution_key)
);
CREATE TABLE forward_trade_revisions (
  trade_id text NOT NULL REFERENCES forward_economic_trades(trade_id), fingerprint text NOT NULL,
  state text NOT NULL CHECK(state IN ('original','pending_review')),
  entity_id text NOT NULL, token_address text NOT NULL, occurred_at bigint NOT NULL,
  token_quantity numeric NOT NULL CHECK(token_quantity>0), quote_asset text NOT NULL, quote_amount numeric NOT NULL CHECK(quote_amount>0),
  amount_usd numeric NOT NULL CHECK(amount_usd>0), entry_price_usd numeric NOT NULL CHECK(entry_price_usd>0),
  amount_basis text NOT NULL CHECK(amount_basis IN ('stablecoin_nominal','verified_usd')),
  amount_estimated boolean NOT NULL, source_representations text NOT NULL,
  execution_evidence_ref text NOT NULL, ownership_evidence_ref text NOT NULL, recorded_at bigint NOT NULL,
  PRIMARY KEY(trade_id,fingerprint)
);
CREATE TABLE forward_trade_source_links (
  job_id text NOT NULL REFERENCES capture_normalized_results(job_id), trade_id text NOT NULL, fingerprint text NOT NULL,
  execution_evidence_ref text NOT NULL, ownership_evidence_ref text NOT NULL, recorded_at bigint NOT NULL,
  PRIMARY KEY(job_id,trade_id,fingerprint),
  FOREIGN KEY(trade_id,fingerprint) REFERENCES forward_trade_revisions(trade_id,fingerprint)
);
CREATE TABLE forward_purchase_samples (
  sample_id text PRIMARY KEY, generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),
  trade_id text NOT NULL, execution_fingerprint text NOT NULL, entity_id text NOT NULL, chain text NOT NULL,
  token_address text NOT NULL, occurred_at bigint NOT NULL, expires_at bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('observing','window_elapsed_unverified')), created_at bigint NOT NULL,
  UNIQUE(generation_id,trade_id), FOREIGN KEY(trade_id,execution_fingerprint) REFERENCES forward_trade_revisions(trade_id,fingerprint)
);
CREATE INDEX forward_purchase_owner_time ON forward_purchase_samples(entity_id,occurred_at,sample_id);
CREATE INDEX forward_purchase_token_time ON forward_purchase_samples(chain,token_address,occurred_at,sample_id);
CREATE INDEX forward_purchase_expiry ON forward_purchase_samples(expires_at,sample_id);
CREATE TABLE forward_sample_work_intents (
  sample_id text NOT NULL REFERENCES forward_purchase_samples(sample_id), execution_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched')), created_at bigint NOT NULL,
  PRIMARY KEY(sample_id,execution_fingerprint)
);
`;

// Internal verified-match port. Neither a page price nor a position ID satisfies this contract.
export interface VerifiedForwardPurchase {
  readonly executionKey: string;
  readonly chain: "solana" | "eth" | "bsc" | "base" | "robinhood";
  readonly tokenAddress: string;
  readonly entityId: string;
  readonly sourceUserId: string;
  readonly occurredAt: number;
  readonly tokenQuantity: string;
  readonly quoteAsset: string;
  readonly quoteAmount: string;
  readonly amountUsd: string;
  readonly entryPriceUsd: string;
  readonly amountBasis: "stablecoin_nominal" | "verified_usd";
  readonly amountEstimated: boolean;
  readonly executionEvidenceRef: string;
  readonly ownershipEvidenceRef: string;
}
export interface ForwardPurchaseWrite {
  readonly generationId: string;
  readonly sourceJobId: string;
  readonly purchase: VerifiedForwardPurchase;
  readonly recordedAt: number;
}
export interface ForwardPurchaseResult {
  readonly tradeId: string;
  readonly fingerprint: string;
  readonly status: "sample_ready" | "revision_pending" | "ownership_conflict" | "below_threshold" | "before_generation";
  readonly sampleId: string | null;
}
function id(value: string): void {
  if (!value.trim() || value.length > 512) throw new Error("Forward purchase identity is invalid");
}
function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Forward purchase timestamp is invalid");
}
function decimal(value: string): string {
  if (value.length>512 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Forward purchase decimal must be a bounded lossless positive string");
  const [integer = "", fractional = ""] = value.split(".");
  const whole = integer.replace(/^0+/,"") || "0";
  const fraction = fractional.replace(/0+$/,"");
  const canonical = fraction ? `${whole}.${fraction}` : whole;
  if (canonical === "0") throw new Error("Forward purchase decimal must be positive");
  return canonical;
}

export function createPostgresForwardPurchaseRepository(transaction: PostgresTransaction) {
  return Object.freeze({
    async registerGeneration(input: { readonly generationId:string; readonly activatedAt:number }): Promise<void> {
      id(input.generationId); time(input.activatedAt);
      await transaction.query(`INSERT INTO forward_strategy_generations(generation_id,activated_at) VALUES($1,$2)
        ON CONFLICT(generation_id) DO NOTHING`,[input.generationId,input.activatedAt]);
      const result = await transaction.query("SELECT activated_at FROM forward_strategy_generations WHERE generation_id=$1",[input.generationId]);
      if (Number(result.rows[0]?.activated_at)!==input.activatedAt) throw new Error("Forward generation identity conflicts with its activation time");
    },
    async record(input: ForwardPurchaseWrite): Promise<ForwardPurchaseResult> {
      const purchase = input.purchase;
      [input.generationId,input.sourceJobId,purchase.executionKey,purchase.entityId,purchase.sourceUserId,purchase.tokenAddress,
        purchase.quoteAsset,purchase.executionEvidenceRef,purchase.ownershipEvidenceRef].forEach(id);
      time(input.recordedAt); time(purchase.occurredAt);
      if (!Number.isSafeInteger(purchase.occurredAt+FORWARD_PURCHASE_WINDOW_MS)) throw new Error("Forward purchase expiry is unsafe");
      if (purchase.occurredAt>input.recordedAt) throw new Error("Forward purchase execution cannot occur in the future");
      if (!["solana","eth","bsc","base","robinhood"].includes(purchase.chain)) throw new Error("Forward purchase chain is unsupported");
      if (!["stablecoin_nominal","verified_usd"].includes(purchase.amountBasis) || typeof purchase.amountEstimated!=="boolean") {
        throw new Error("Forward purchase amount basis is invalid");
      }
      const quantity = decimal(purchase.tokenQuantity), quote = decimal(purchase.quoteAmount), amount = decimal(purchase.amountUsd), price = decimal(purchase.entryPriceUsd);
      if (purchase.amountBasis==="stablecoin_nominal"
        && (!["USDT","USDC"].includes(purchase.quoteAsset) || !purchase.amountEstimated || amount!==quote)) {
        throw new Error("Stablecoin nominal USD requires USDT/USDC, equal nominal amounts and an estimation marker");
      }
      const token = purchase.chain==="solana" ? purchase.tokenAddress : purchase.tokenAddress.toLowerCase();
      const source = await transaction.query("SELECT * FROM capture_normalized_results WHERE job_id=$1",[input.sourceJobId]);
      const sourceRow = source.rows[0];
      if (!sourceRow || sourceRow.event_kind!=="buy" || sourceRow.requires_review===true || sourceRow.source_user_id!==purchase.sourceUserId
        || sourceRow.chain!==purchase.chain || sourceRow.token_address!==token
        || (sourceRow.entity_id!==null && sourceRow.entity_id!==purchase.entityId)) throw new Error("Verified purchase does not match its attributable source revision");
      const generation = await transaction.query("SELECT activated_at FROM forward_strategy_generations WHERE generation_id=$1",[input.generationId]);
      if (!generation.rows[0]) throw new Error("Forward generation must be registered explicitly");
      const fingerprint = createHash("sha256").update(JSON.stringify({ entityId:purchase.entityId,chain:purchase.chain,token,
        occurredAt:purchase.occurredAt,quantity,quoteAsset:purchase.quoteAsset,quote,amount,price,
        amountBasis:purchase.amountBasis,amountEstimated:purchase.amountEstimated })).digest("hex");
      await transaction.query(`INSERT INTO forward_economic_trades(trade_id,chain,execution_key,original_fingerprint,entity_id,token_address,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chain,execution_key) DO NOTHING`,
      [randomUUID(),purchase.chain,purchase.executionKey,fingerprint,purchase.entityId,token,purchase.occurredAt]);
      const heads = await transaction.query("SELECT * FROM forward_economic_trades WHERE chain=$1 AND execution_key=$2 FOR UPDATE",[purchase.chain,purchase.executionKey]);
      const head = heads.rows[0];
      if (!head) throw new Error("Forward economic trade was not persisted");
      const tradeId = String(head.trade_id);
      const original = head.original_fingerprint===fingerprint;
      await transaction.query(`INSERT INTO forward_trade_revisions(trade_id,fingerprint,state,entity_id,token_address,occurred_at,
        token_quantity,quote_asset,quote_amount,amount_usd,entry_price_usd,amount_basis,amount_estimated,source_representations,
        execution_evidence_ref,ownership_evidence_ref,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT(trade_id,fingerprint) DO NOTHING`,[tradeId,fingerprint,original?"original":"pending_review",purchase.entityId,token,purchase.occurredAt,
        quantity,purchase.quoteAsset,quote,amount,price,purchase.amountBasis,purchase.amountEstimated,
        JSON.stringify({tokenQuantity:purchase.tokenQuantity,quoteAmount:purchase.quoteAmount,amountUsd:purchase.amountUsd,entryPriceUsd:purchase.entryPriceUsd}),
        purchase.executionEvidenceRef,purchase.ownershipEvidenceRef,input.recordedAt]);
      await transaction.query(`INSERT INTO forward_trade_source_links(job_id,trade_id,fingerprint,execution_evidence_ref,ownership_evidence_ref,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id,trade_id,fingerprint) DO NOTHING`,
      [input.sourceJobId,tradeId,fingerprint,purchase.executionEvidenceRef,purchase.ownershipEvidenceRef,input.recordedAt]);
      const result = (status:ForwardPurchaseResult["status"],sampleId:string|null=null):ForwardPurchaseResult => Object.freeze({tradeId,fingerprint,status,sampleId});
      if (!original) return result(head.entity_id!==purchase.entityId?"ownership_conflict":"revision_pending");
      if (purchase.occurredAt<Number(generation.rows[0].activated_at)) return result("before_generation");
      if (BigInt(amount.split(".")[0]!)<50n) return result("below_threshold");
      const expiresAt = purchase.occurredAt+FORWARD_PURCHASE_WINDOW_MS;
      await transaction.query(`INSERT INTO forward_purchase_samples(sample_id,generation_id,trade_id,execution_fingerprint,entity_id,chain,
        token_address,occurred_at,expires_at,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(generation_id,trade_id) DO NOTHING`,[randomUUID(),input.generationId,tradeId,fingerprint,purchase.entityId,purchase.chain,token,
        purchase.occurredAt,expiresAt,input.recordedAt<expiresAt?"observing":"window_elapsed_unverified",input.recordedAt]);
      const samples = await transaction.query("SELECT sample_id FROM forward_purchase_samples WHERE generation_id=$1 AND trade_id=$2",[input.generationId,tradeId]);
      const sampleId = String(samples.rows[0]?.sample_id ?? "");
      if (!sampleId) throw new Error("Forward purchase sample was not persisted");
      await transaction.query(`INSERT INTO forward_sample_work_intents(sample_id,execution_fingerprint,created_at) VALUES($1,$2,$3)
        ON CONFLICT(sample_id,execution_fingerprint) DO NOTHING`,[sampleId,fingerprint,input.recordedAt]);
      return result("sample_ready",sampleId);
    },
  });
}
