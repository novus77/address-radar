import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createPublicKey} from 'node:crypto';
const slots=['authorizationPublicKeyPem','observerPublicKeyPem','snapshotPublicKeyPem','independentCompatibilityPublicKeyPem'];
const demand=(v,c)=>{if(!v)throw Error(c);};
export function inspectPublicTrustArtifact(body){
 demand(body.length<=1048576,'trust_artifact_oversize');const text=body.toString('utf8');
 if(/-----BEGIN [^-]*PRIVATE KEY-----/.test(text))return {status:'private_material_refused',trusted:false};
 let values;try{const value=JSON.parse(text);values=value.closureTrust??value;}catch{values=null;}
 const keys=[];
 if(values&&typeof values==='object')for(const slot of slots){if(typeof values[slot]==='string'){try{const key=createPublicKey(values[slot]);demand(key.asymmetricKeyType==='ed25519','unsupported_public_key');keys.push({slot,algorithm:'ed25519',spkiSha256:createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')});}catch{keys.push({slot,status:'invalid_public_key'});}}}
 else if(text.startsWith('-----BEGIN PUBLIC KEY-----')){try{const key=createPublicKey(text);demand(key.asymmetricKeyType==='ed25519','unsupported_public_key');keys.push({slot:'unassigned',algorithm:'ed25519',spkiSha256:createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')});}catch{keys.push({slot:'unassigned',status:'invalid_public_key'});}}
 return {status:'public_artifact_inventoried',artifactSha256:createHash('sha256').update(body).digest('hex'),bytes:body.length,keys,trusted:false,signaturesVerified:false,productionMigrationReady:false};
}
async function read(path){
 demand(resolve(path)===path&&path!=='/','absolute_path_required');const parents=[];
 for(let p=dirname(path);;p=dirname(p)){const s=await lstat(p,{bigint:true});demand(s.isDirectory()&&s.uid===0n&&!(s.mode&0o022n),'unsafe_trust_ancestor');parents.push([p,s.dev,s.ino,s.mode,s.uid,s.gid]);if(p==='/')break;}
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await h.stat({bigint:true});demand(s.isFile()&&s.uid===0n&&s.gid===0n&&s.nlink===1n&&!(s.mode&0o022n)&&s.size<=1048576n,'unsafe_trust_artifact');const b=Buffer.alloc(Number(s.size)+1);let n=0;while(n<b.length){const r=await h.read(b,n,b.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead;}
 const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');demand(n===Number(s.size)&&stamp(s)===stamp(await h.stat({bigint:true}))&&stamp(s)===stamp(await lstat(path,{bigint:true})),'trust_artifact_changed');for(const [p,dev,ino,mode,uid,gid] of parents){const a=await lstat(p,{bigint:true});demand(a.isDirectory()&&a.dev===dev&&a.ino===ino&&a.mode===mode&&a.uid===uid&&a.gid===gid,'trust_ancestor_changed');}return inspectPublicTrustArtifact(b.subarray(0,n));}finally{await h.close();}
}
export async function main(args=process.argv.slice(2)){demand(process.getuid?.()===0&&args.length>0&&args.length<=32&&args.length%2===0,'explicit_bounded_paths_required');const out=[];for(let i=0;i<args.length;i+=2){demand(args[i]==='--artifact','invalid_cli');out.push({path:args[i+1],...await read(args[i+1])});}return {status:'readonly_trust_inventory',artifacts:out,signingPerformed:false,trusted:false};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(v=>console.log(JSON.stringify(v)),()=>{console.log('{"status":"refused","code":"trust_inventory_refused"}');process.exitCode=1;});
