import { describe, expect, it } from "vitest";
import { createSyntheticPublicationExecution, runPostgresFactPublicationFixture } from "./postgres-fact-publication-fixture.js";

it("synthetic publication data satisfies the actual executed stablecoin capture contract",()=>{
 const candidate=createSyntheticPublicationExecution("synthetic-generation",200000,90000);
 expect(candidate.purchaseCandidate).toMatchObject({entityId:"synthetic-owner",tokenQuantity:"100",quoteAmount:"60",entryPriceUsd:"0.6",amountEstimated:true,amountBasis:"stablecoin_nominal",executionEvidenceRef:"solana:synthetic-fixture-signature"});
 expect(candidate).not.toHaveProperty("attestation");
});

const enabled=process.env.ADDRESS_RADAR_RUN_FACT_PUBLICATION_REHEARSAL==="1";
describe.skipIf(!enabled)("bounded real private PostgreSQL execution and price publication",()=>{
 it("uses exact v2 and a dedicated actor for signed synthetic proofs, atomic receipts and awaited COMMIT",async()=>{
  const receipt=await runPostgresFactPublicationFixture();
  expect(receipt).toMatchObject({syntheticOnly:true,productionWrites:false,cleaned:true,schemaVersion:2,
   executionPublished:true,executionDuplicate:true,pricePublished:true,priceDuplicate:true,
   mismatchRejections:3,authorityScopeRejections:2,physicalMultiCandleRollback:true,
   awaitingCommit:true,commitUncertaintyReconciled:true,consumerAuthorityWrites:false});
  console.info("Synthetic real PG publication receipt",JSON.stringify(receipt));
 },180000);
});
