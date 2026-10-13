import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open} from "node:fs/promises";
import {resolve} from "node:path";
import {verifyFullDataPreservationManifest,verifyOpaqueFullDataPreservationChunk} from "../packages/database/src/postgres-full-data-import.js";
export const sourceSealPolicy=Object.freeze({directory:"/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle",manifestSha256:"d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c",snapshotSha256:"d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7",catalogFingerprint:"6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5",operationId:"preparation-20261004-largechunk-9c8ae4bf",tables:141,chunks:1548,rows:6023033,uid:0});
type Policy={directory:string;manifestSha256:string;snapshotSha256:string;catalogFingerprint:string;operationId:string;tables:number;chunks:number;rows:number;uid:number};
const hash=(body:Uint8Array|string)=>createHash("sha256").update(body).digest("hex");
function gate(value:unknown,code:string):asserts value{if(!value)throw Error("source_seal_validator_"+code);}
export async function validateSealingSource(policy:Policy=sourceSealPolicy,onChunk:(value:{event:string;file:string;sha256:string})=>void=()=>{}){
 const began=performance.now(),wall=Date.now();let totalBytes=0;
 const checkpoint=()=>gate(performance.now()-began<1740000 && Date.now()-wall<1740000,"deadline");
 const root=await lstat(policy.directory);gate(root.isDirectory()&&!root.isSymbolicLink()&&root.uid===policy.uid&&!(root.mode&0o077),"root");
 const files:Record<string,string>={};
 const read=async(name:string,maximum:number)=>{
  checkpoint();gate(name==="manifest.json"||/^table-[0-9]{4}-chunk-[0-9]{6}\.json$/.test(name),"filename");
  const path=policy.directory+"/"+name,fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const a=await fd.stat({bigint:true});gate(a.isFile()&&a.uid===BigInt(policy.uid)&&a.nlink===1n&&!(a.mode&0o077n)&&a.size>0n&&a.size<=BigInt(maximum),"file");
   const body=Buffer.alloc(Number(a.size)+1);let offset=0;
   while(offset<body.length){checkpoint();const r=await fd.read(body,offset,Math.min(65536,body.length-offset),offset);if(!r.bytesRead)break;offset+=r.bytesRead;
    const pacing=(totalBytes+offset)/(32*1024**2)*1000-(performance.now()-began);if(pacing>0)await new Promise(r=>setTimeout(r,Math.min(pacing,20)));}
   const b=await fd.stat({bigint:true}),current=await lstat(path,{bigint:true});
   gate(offset===Number(a.size)&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&current.dev===a.dev&&current.ino===a.ino,"file_race");
   totalBytes+=offset;gate(totalBytes<=8*1024**3,"total_bytes");const bytes=body.subarray(0,offset);files[name]=hash(bytes);return bytes;
  }finally{await fd.close();}
 };
 const manifest=verifyFullDataPreservationManifest(await read("manifest.json",1024**2));
 gate(manifest.manifestSha256===policy.manifestSha256&&manifest.value.snapshotSha256===policy.snapshotSha256&&manifest.value.catalogFingerprint===policy.catalogFingerprint&&manifest.value.operationId===policy.operationId&&manifest.totalRows===policy.rows&&manifest.totalChunks===policy.chunks&&manifest.value.tables.length===policy.tables,"manifest_binding");
 for(const table of manifest.value.tables){const content=createHash("sha256");let rows=0;
  async function frame(ordinal:number,file:string){const bytes=await read(file,manifest.value.limits.maximumChunkBytes);const chunk=verifyOpaqueFullDataPreservationChunk(bytes,manifest,table.name,ordinal);
   for(const row of chunk.rowBodies){content.update(row);content.update("\n");}return chunk.rowBodies.length;}
  for(const plan of table.chunks){rows+=await frame(plan.ordinal,plan.file);global.gc?.();checkpoint();onChunk({event:"chunk-validated",file:plan.file,sha256:files[plan.file]!});}
  gate(rows===table.rowCount&&content.digest("hex")===table.contentSha256,"table_content");
 }
 const current=await lstat(policy.directory);gate(current.dev===root.dev&&current.ino===root.ino,"root_race");checkpoint();
 return {version:1,status:"source-validated",manifestSha256:manifest.manifestSha256,operationId:manifest.value.operationId,snapshotSha256:manifest.value.snapshotSha256,tables:policy.tables,chunks:policy.chunks,rows:policy.rows,totalBytes,rootIdentity:[root.dev,root.ino],files};
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename){
 try{gate(process.platform==="linux"&&process.getuid?.()===0&&process.argv.length===2,"arguments");process.stdout.write(JSON.stringify(await validateSealingSource(sourceSealPolicy,value=>process.stdout.write(JSON.stringify(value)+"\n")))+"\n");}
 catch{process.stdout.write('{"status":"validation-refused"}\n');process.exitCode=1;}
}
