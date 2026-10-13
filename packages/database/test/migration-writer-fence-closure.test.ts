import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalFenceClosureEvidence, fenceClosureEvidenceSha256, fenceClosureSigningMessage, verifyWriterFenceSnapshotRollbackClosure, type FenceClosureInput, type FenceClosureScope, type FenceClosureSigned, type FenceClosureTrust } from "../src/migration-writer-fence-closure.js";

// Synthetic signing keys and protocol receipts exercise validation, not production proof.
const keys = Array.from({ length: 4 }, () => generateKeyPairSync("ed25519"));
function key(index: number) { const value=keys[index]; if (!value) throw new Error("Missing test key"); return value; }
const h="a".repeat(64), other="b".repeat(64);
const now=new Date("2026-10-04T07:30:00.000Z");
function seal<T>(kind: "authorization" | "census" | "snapshot" | "rollback", payload: T, privateKey: KeyObject): FenceClosureSigned<T> {
  return { payload, signatureBase64:sign(null,fenceClosureSigningMessage(kind,payload),privateKey).toString("base64") };
}
function fixture() {
  const binding={sourcePath:"/fixture/source.sqlite",sourceDevice:"1",sourceInode:"10",generation:"g1",watermark:"w1",cluster:"cluster1",schemaSha256:h,release:"pg-r1",artifactSha256:h,cohortSha256:h,providerGuardSha256:h,deliveryGuardSha256:h};
  const scopes:FenceClosureScope[]=[
    ...Array.from({length:12},(_,index)=>({id:`fixture-service-${index}`,kind:"service" as const,paths:[binding.sourcePath],directions:[]})),
    ...Array.from({length:5},(_,index)=>({id:`fixture-timer-${index}`,kind:"timer" as const,paths:[binding.sourcePath],directions:[]})),
    {id:"fixture-bridge",kind:"bridge",paths:["/fixture/input","/fixture/output"],directions:["source-to-input","output-to-source"]},
    ...(["cron","operator","deploy","external-input"] as const).map(kind=>({id:`fixture-${kind}`,kind,paths:[binding.sourcePath],directions:[]})),
  ];
  const auth={binding,scopes,windowStart:"2026-10-04T07:00:00.000Z",windowEnd:"2026-10-04T08:00:00.000Z",maximumSqlStatements:1000,maximumTransactionMs:60000};
  const census={authorizationSha256:fenceClosureEvidenceSha256(auth),observedAt:"2026-10-04T07:29:10.000Z",fencedAt:"2026-10-04T07:28:00.000Z",scopes:scopes.map(scope=>({id:scope.id,admission:"closed" as const,controlReceiptSha256:h,closedUntil:auth.windowEnd,processIds:scope.id==="fixture-service-0"?[100]:[],timer:scope.kind==="timer"?"disabled-no-pending-trigger" as const:"not-applicable" as const,bridgeDirections:[...scope.directions],cursorReceiptSha256:scope.kind==="bridge"?h:null})),processes:[{pid:100,children:[101],descendants:"complete" as const,fdScan:"complete" as const,mmapScan:"complete" as const,sourceHandles:[],sourceMappings:[]},{pid:101,children:[],descendants:"complete" as const,fdScan:"complete" as const,mmapScan:"complete" as const,sourceHandles:[],sourceMappings:[]}],discoveredScopeIds:scopes.map(scope=>scope.id),sourceDevice:binding.sourceDevice,sourceInode:binding.sourceInode,sourcePath:binding.sourcePath,generation:binding.generation,watermark:binding.watermark};
  const snapshot={authorizationSha256:fenceClosureEvidenceSha256(auth),censusSha256:fenceClosureEvidenceSha256(census),binding,kind:"final-full-fenced" as const,startedAt:"2026-10-04T07:28:00.000Z",completedAt:"2026-10-04T07:29:00.000Z",tableCensusSha256:fenceClosureEvidenceSha256([{name:"fixture_table",rowCount:"216",sha256:h}]),tables:[{name:"fixture_table",rowCount:"216",sha256:h}],parityReceiptSha256:h,restoreReceiptSha256:h};
  const rollback={authorizationSha256:fenceClosureEvidenceSha256(auth),binding,route:"compatible-postgres-release" as const,completedAt:"2026-10-04T07:29:30.000Z",parityReceiptSha256:h,rollbackRelease:"pg-rollback-r1",rollbackArtifactSha256:h,compatibilityTestReceiptSha256:h,preservedProviderGuardSha256:h,preservedDeliveryGuardSha256:h};
  const input:FenceClosureInput={authorization:seal("authorization",auth,key(0).privateKey),census:seal("census",census,key(1).privateKey),snapshot:seal("snapshot",snapshot,key(2).privateKey),rollback:seal("rollback",rollback,key(3).privateKey),phase:"after-first-pg-write"};
  const trust:FenceClosureTrust={authorizationPublicKeyPem:key(0).publicKey.export({type:"spki",format:"pem"}).toString(),observerPublicKeyPem:key(1).publicKey.export({type:"spki",format:"pem"}).toString(),snapshotPublicKeyPem:key(2).publicKey.export({type:"spki",format:"pem"}).toString(),independentCompatibilityPublicKeyPem:key(3).publicKey.export({type:"spki",format:"pem"}).toString(),expectedBinding:binding,expectedScopesSha256:fenceClosureEvidenceSha256(scopes),expectedTableNames:["fixture_table"],expectedRollbackRelease:"pg-rollback-r1",expectedRollbackArtifactSha256:h,maximumEvidenceAgeMs:300000,maximumMaintenanceWindowMs:3600000};
  return {input,trust};
}
type Fixture=ReturnType<typeof fixture>;
function resign(f:Fixture) {
  f.input.census.payload.authorizationSha256=fenceClosureEvidenceSha256(f.input.authorization.payload);
  f.input.snapshot.payload.authorizationSha256=fenceClosureEvidenceSha256(f.input.authorization.payload);
  f.input.snapshot.payload.censusSha256=fenceClosureEvidenceSha256(f.input.census.payload);
  f.input.rollback.payload.authorizationSha256=fenceClosureEvidenceSha256(f.input.authorization.payload);
  f.input.authorization=seal("authorization",f.input.authorization.payload,key(0).privateKey);
  f.input.census=seal("census",f.input.census.payload,key(1).privateKey);
  f.input.snapshot=seal("snapshot",f.input.snapshot.payload,key(2).privateKey);
  f.input.rollback=seal("rollback",f.input.rollback.payload,key(3).privateKey);
}
function process(f:Fixture,index:number) {const value=f.input.census.payload.processes[index];if(!value)throw new Error("Missing fixture process");return value;}
function scope(f:Fixture,id:string) {const value=f.input.census.payload.scopes.find(item=>item.id===id);if(!value)throw new Error("Missing fixture scope");return value;}
const rejectionCases:[string,(f:Fixture)=>void][]=[
  ["writable child DB FD",f=>process(f,1).sourceHandles.push({path:"/fixture/source.sqlite-wal",flagsOctal:"02500002"})],
  ["missing descendant",f=>{f.input.census.payload.processes.pop();}],
  ["unknown extra process",f=>{f.input.census.payload.processes.push({...process(f,1),pid:102});}],
  ["unknown mmap holder",f=>process(f,1).sourceMappings.push("/fixture/source.sqlite-shm")],
  ["denied FD scan",f=>Object.assign(process(f,1),{fdScan:"denied"})],
  ["truncated descendants",f=>Object.assign(process(f,0),{descendants:"truncated"})],
  ["extra scheduled writer",f=>f.input.census.payload.discoveredScopeIds.push("extra-backup.timer")],
  ["pending timer",f=>Object.assign(scope(f,"fixture-timer-0"),{timer:"active-waiting"})],
  ["missing observed timer",f=>{f.input.census.payload.scopes=f.input.census.payload.scopes.filter(item=>item.id!=="fixture-timer-0");}],
  ["one-way bridge",f=>{scope(f,"fixture-bridge").bridgeDirections=["source-to-input"];}],
  ["unpreserved bridge cursor",f=>{scope(f,"fixture-bridge").cursorReceiptSha256=null;}],
  ["opaque signed scope",f=>{const first=f.input.authorization.payload.scopes[0];if(!first)throw new Error("Missing scope");Object.assign(first,{kind:"opaque"});}],
  ["open future deploy",f=>Object.assign(scope(f,"fixture-deploy"),{admission:"unknown"})],
  ["closure expires before window",f=>{scope(f,"fixture-deploy").closedUntil="2026-10-04T07:40:00.000Z";}],
  ["future census",f=>{f.input.census.payload.observedAt="2026-10-04T07:31:00.000Z";}],
  ["stale census",f=>{f.input.census.payload.observedAt="2026-10-04T07:20:00.000Z";}],
  ["guessed delta",f=>Object.assign(f.input.snapshot.payload,{kind:"timestamp-delta"})],
  ["snapshot starts before window",f=>{f.input.snapshot.payload.startedAt="2026-10-04T06:59:00.000Z";}],
  ["wrong schema",f=>{f.trust.expectedBinding={...f.trust.expectedBinding,schemaSha256:other};}],
  ["wrong canonical source",f=>{f.input.census.payload.sourceInode="11";}],
  ["wrong generation",f=>{f.input.census.payload.generation="g2";}],
  ["SQLite rollback after first PG write",f=>Object.assign(f.input.rollback.payload,{route:"source-before-first-write",rollbackRelease:null,rollbackArtifactSha256:null,compatibilityTestReceiptSha256:null})],
  ["wrong retained rollback release",f=>{f.input.rollback.payload.rollbackRelease="sqlite-release-4b48";}],
  ["wrong retained artifact",f=>{f.input.rollback.payload.rollbackArtifactSha256=other;}],
  ["missing table",f=>{f.input.snapshot.payload.tables=[];f.input.snapshot.payload.tableCensusSha256=fenceClosureEvidenceSha256([]);}],
  ["unknown table",f=>{f.input.snapshot.payload.tables.push({name:"unknown_table",rowCount:"0",sha256:h});f.input.snapshot.payload.tableCensusSha256=fenceClosureEvidenceSha256(f.input.snapshot.payload.tables);}],
  ["coerced table count",f=>Object.assign(f.input.snapshot.payload.tables[0]??{}, {rowCount:216})],
  ["missing compatibility test",f=>{f.input.rollback.payload.compatibilityTestReceiptSha256=null;}],
  ["provider guard changed",f=>{f.input.rollback.payload.preservedProviderGuardSha256=other;}],
  ["delivery guard changed",f=>{f.input.rollback.payload.preservedDeliveryGuardSha256=other;}],
  ["self-selected verification key",f=>{f.trust.independentCompatibilityPublicKeyPem=f.trust.authorizationPublicKeyPem;}],
  ["budget above hard maximum",f=>{f.input.authorization.payload.maximumSqlStatements=10001;}],
  ["transaction above 60 seconds",f=>{f.input.authorization.payload.maximumTransactionMs=60001;}],
  ["fabricated true flag",f=>Object.assign(f.input.census.payload,{fenceEstablished:true})],
];
describe("externally signed writer fence closure protocol (synthetic fixtures)",()=>{
  it("validates evidence without granting production flags or raising the approved 1000 SQL budget",()=>{const f=fixture();const result=verifyWriterFenceSnapshotRollbackClosure(f.input,f.trust,now);expect(result.writeAuthorized).toBe(false);expect(result.activationEnabled).toBe(false);expect(f.input.authorization.payload.maximumSqlStatements).toBe(1000);});
  it.each(rejectionCases)("rejects %s even with correctly signed malformed evidence",(_label,mutate)=>{const f=fixture();mutate(f);resign(f);expect(()=>verifyWriterFenceSnapshotRollbackClosure(f.input,f.trust,now)).toThrow();});
  it("rejects unsigned tampering",()=>{const f=fixture();f.input.census.payload.watermark="new";expect(()=>verifyWriterFenceSnapshotRollbackClosure(f.input,f.trust,now)).toThrow("census signature");});
  it("allows source rollback only before the persisted first-write phase",()=>{const f=fixture();f.input.phase="before-first-pg-write";Object.assign(f.input.rollback.payload,{route:"source-before-first-write",rollbackRelease:null,rollbackArtifactSha256:null,compatibilityTestReceiptSha256:null});resign(f);expect(verifyWriterFenceSnapshotRollbackClosure(f.input,f.trust,now).phase).toBe("before-first-pg-write");});
  it("allows a 25-minute export/restore with historical signed fence boundaries and fresh final census",()=>{const f=fixture();Object.assign(f.input.census.payload,{fencedAt:"2026-10-04T07:01:00.000Z",observedAt:"2026-10-04T07:29:00.000Z"});f.input.snapshot.payload.startedAt="2026-10-04T07:02:00.000Z";f.input.snapshot.payload.completedAt="2026-10-04T07:27:00.000Z";resign(f);expect(verifyWriterFenceSnapshotRollbackClosure(f.input,f.trust,now).writeAuthorized).toBe(false);});
  it.each([undefined,NaN,Infinity,-0,1.5,new Date(),[undefined]])("rejects noncanonical coercible value %s",value=>{expect(()=>canonicalFenceClosureEvidence(value)).toThrow();});
  it("rejects accessor evidence without invoking getters",()=>{let invoked=false;const value=Object.defineProperty({},"secret",{enumerable:true,get(){invoked=true;return "secret";}});expect(()=>canonicalFenceClosureEvidence(value)).toThrow();expect(invoked).toBe(false);});
  it("rejects array getters without invoking them",()=>{let invoked=false;const value=[1];Object.defineProperty(value,"0",{enumerable:true,get(){invoked=true;return 1;}});expect(()=>canonicalFenceClosureEvidence(value)).toThrow();expect(invoked).toBe(false);});
  it("has stable key ordering and rejects sparse arrays",()=>{expect(fenceClosureEvidenceSha256({b:2,a:1})).toBe(fenceClosureEvidenceSha256({a:1,b:2}));expect(()=>canonicalFenceClosureEvidence(new Array(2))).toThrow();});
});
