import { createPostgresForwardTargetAuthorizationRepository,refreshPostgresForwardTargetIdentity,projectPostgresForwardSignal,validatePostgresForwardSignalReadiness,
  type ForwardSignalSafetyAssessment,type PostgresTransaction } from "@address-radar/database";
import type { ForwardTargetChannelFact,ForwardTargetPrincipal } from "@address-radar/domain";
import { readPostgresForwardTargetAuthorization } from "./forward-target-authorization.js";
interface Runtime { run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T>; probe(): Promise<unknown>; }
const proof = (value: unknown,message: string) => { if (!value) throw new Error(message); };
const tables = async (transaction: PostgresTransaction) => (await transaction.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r' ORDER BY relname")).rows.map(row => String(row.relname));
export async function verifyPostgresForwardSignalAcceptance(runtime: Runtime,options: { now: number;setup: (transaction: PostgresTransaction,now: number) => Promise<string> }) {
  await runtime.probe(); let owned: string[] = [],backend = 0,clock = options.now,cleanupVerified = false;
  const tokenAddress = `0x${"cd".repeat(20)}`,chain = "base";
  const principal: ForwardTargetPrincipal = { actorId: "signal-fixture",authorizationEvidenceRef: "signal-fixture-permission",permissions: ["target_registry_write","radar_authorization_write"] };
  const facts: ForwardTargetChannelFact[] = ["a","b"].map(id => ({ entityId: `signal-${id}`,channel: "fomo",subjectId: `signal-account-${id}`,walletFamily: null,
    associationConfidence: "confirmed",associationSource: "signal_fixture",ownerCount: 1,walletConfidence: null,walletSource: null,identityEvidenceRef: `identity:${id}`,ownershipEvidenceRef: `ownership:${id}`,monitoringEnabled: true,suspended: false }));
  const assertSession = async (transaction: PostgresTransaction) => { proof(Number((await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid) === backend,"Acceptance backend changed"); };
  const run: Runtime["run"] = operation => runtime.run(async transaction => { await assertSession(transaction); return operation(transaction); });
  try {
    const generationId = await runtime.run(async transaction => {
      proof((await tables(transaction)).length === 0,"Dedicated empty temporary namespace required"); backend = Number((await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      const generation = await options.setup(transaction,clock),repository = createPostgresForwardTargetAuthorizationRepository(transaction,principal);
      for (const [index,fact] of facts.entries()) {
        const tradeId = `signal-trade-${index}`,fingerprint = `signal-execution-${index}`,sampleId = `signal-sample-${index}`;
        await transaction.query("INSERT INTO forward_economic_trades(trade_id,chain,execution_key,original_fingerprint,entity_id,token_address,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[tradeId,chain,`signal-event-${index}`,fingerprint,fact.entityId,tokenAddress,clock]);
        await transaction.query(`INSERT INTO forward_trade_revisions(trade_id,fingerprint,state,entity_id,token_address,occurred_at,token_quantity,quote_asset,quote_amount,amount_usd,entry_price_usd,amount_basis,amount_estimated,source_representations,execution_evidence_ref,ownership_evidence_ref,recorded_at)
          VALUES($1,$2,'original',$3,$4,$5,50,'USDC',50,50,1,'stablecoin_nominal',true,$6,$7,$8,$5)`,[tradeId,fingerprint,fact.entityId,tokenAddress,clock,JSON.stringify(["synthetic_post_normalization"]),`execution-proof:${index}`,`ownership-proof:${index}`]);
        await transaction.query("INSERT INTO forward_purchase_samples(sample_id,generation_id,trade_id,execution_fingerprint,entity_id,chain,token_address,occurred_at,expires_at,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'observing',$8)",[sampleId,generation,tradeId,fingerprint,fact.entityId,chain,tokenAddress,clock,clock+30*86400000]);
        await repository.recordChannel({ ...fact,versionId: `signal-target-${index}`,effectiveAt: clock,knownAt: clock });
        await repository.recordManual({ authorizationId: `signal-grant-${index}`,entityId: fact.entityId,action: "grant",basisRef: "synthetic-approval",effectiveAt: clock,knownAt: clock });
      }
      owned = await tables(transaction); proof(owned.every(name => /^[a-z_][a-z0-9_]*$/.test(name)),"Invalid fixture inventory"); return generation;
    });
    const safety = (): ForwardSignalSafetyAssessment[] => facts.map((fact,index) => ({ sampleId: `signal-sample-${index}`,executionFingerprint: `signal-execution-${index}`,assessedAt: clock,target: fact,
      independenceKey: fact.entityId,riskVerdict: "validated",riskEvidenceRef: `synthetic-risk:${index}`,liveSourceVerified: true,sourceEvidenceRef: `synthetic-live-proof:${index}` }));
    const input = () => ({ generationId,chain,tokenAddress,asOf: clock,inputLimit: 100,safety: safety(),readAuthorization: readPostgresForwardTargetAuthorization });
    const refresh = () => run(async transaction => { for (const fact of facts) await refreshPostgresForwardTargetIdentity(transaction,{ query: { ...fact,generationId,asOf: clock },principal,readAuthorization: readPostgresForwardTargetAuthorization,
      source: { status: "available",snapshot: { fact,sourceObservedAt: options.now,capturedAt: clock,sourceFingerprint: `signal-source:${fact.entityId}`,proofScope: "legacy_registry_linkage" } } }); });
    const notFresh = await run(transaction => projectPostgresForwardSignal(transaction,input())); proof(notFresh.decision.action === "deferred" && notFresh.receiptCount === 0,"Missing identity refresh produced a receipt");
    await refresh();
    const bounded = await run(transaction => projectPostgresForwardSignal(transaction,{ ...input(),inputLimit: 1 })); proof(bounded.decision.action === "deferred" && bounded.receiptCount === 0,"Partial page falsely acknowledged full inputs");
    const missingRisk = await run(transaction => projectPostgresForwardSignal(transaction,{ ...input(),safety: safety().map(item => ({ ...item,riskVerdict: "pending" })) })); proof(missingRisk.decision.action === "deferred" && missingRisk.receiptCount === 0,"Pending risk produced a receipt");
    let injected = false;
    try { await run(transaction => projectPostgresForwardSignal({ query: async (sql,values) => {
      if (/INSERT/i.test(sql) && sql.includes("forward_signal_execution_receipts")) { injected = true; throw new Error("Injected signal receipt failure"); }
      return transaction.query(sql,values);
    } },input())); throw new Error("Expected signal failure was not thrown"); }
    catch (error) { proof(injected && error instanceof Error && error.message === "Injected signal receipt failure","Unexpected signal failure"); }
    const empty = (await run(transaction => transaction.query("SELECT count(*)::int AS count FROM forward_signal_readiness_intents"))).rows[0]; proof(Number(empty?.count) === 0,"Failed signal receipt partially committed readiness");
    const ready = await run(transaction => projectPostgresForwardSignal(transaction,input())); proof(ready.decision.action === "ready" && ready.decision.participantCount === 2 && ready.receiptCount === 2 && ready.signalId,"Two manual FOMO-only fifty-dollar buyers did not qualify");
    const retry = await run(transaction => projectPostgresForwardSignal(transaction,input())); proof(retry.decision.action === "observe" && retry.receiptCount === 0,"Consumed economic events were counted again");
    const signalId = ready.signalId!; const current = await run(transaction => validatePostgresForwardSignalReadiness(transaction,{ ...input(),signalId })); proof(current.valid,"Current ready signal failed validation");
    clock += 1; const stale = await run(transaction => validatePostgresForwardSignalReadiness(transaction,{ ...input(),signalId })); proof(stale.status === "deferred" && !stale.valid,"Old identity receipt was accepted at delivery boundary");
    await run(transaction => createPostgresForwardTargetAuthorizationRepository(transaction,principal).recordManual({ authorizationId: "signal-revoke-b",entityId: facts[1]!.entityId,action: "revoke",basisRef: "synthetic-revocation",effectiveAt: clock,knownAt: clock }));
    await refresh(); const revoked = await run(transaction => validatePostgresForwardSignalReadiness(transaction,{ ...input(),signalId })); proof(revoked.status === "cancelled" && !revoked.valid,"Revoked trader left a ready signal valid");
    const counts = (await run(transaction => transaction.query("SELECT (SELECT count(*) FROM forward_signal_readiness_intents)::int AS signals,(SELECT count(*) FROM forward_signal_execution_receipts)::int AS receipts,(SELECT count(*) FROM forward_signal_economic_consumption)::int AS consumed"))).rows[0];
    proof(Number(counts?.signals) === 1 && Number(counts?.receipts) === 2 && Number(counts?.consumed) === 2,"Signal intent or economic receipt counts drifted");
  } finally {
    if (owned.length) await runtime.run(async transaction => { await assertSession(transaction); const actual = await tables(transaction);
      proof(actual.length === owned.length && actual.every(name => owned.includes(name)),"Temporary inventory changed");
      await transaction.query(`DROP TABLE ${owned.map(name => `pg_temp."${name}"`).join(",")} CASCADE`); cleanupVerified = (await tables(transaction)).length === 0; proof(cleanupVerified,"Fixture cleanup failed"); });
  }
  return { status: "passed",fixtureScope: "synthetic_post_normalization_forward_signal",fomoOnlyFiftyDollarBuyersVerified: true,
    liveAndRiskPortsAreSynthetic: true,missingProofNoReceiptVerified: true,independentParticipantCount: 2,economicDeduplicationVerified: true,
    signalReceiptAtomicityVerified: true,revocationCancellationVerified: true,deliveryRevalidationRequired: true,cleanupVerified,
    businessActivation: false,liveSourceCoverageVerified: false,gatewayDeliveryEnabled: false } as const;
}
