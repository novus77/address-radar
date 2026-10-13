import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrationCutoverCanonicalJson } from '../../packages/database/src/migration-cutover-coordinator.js';
import { validateSourcePreparationJob } from '../prepare-address-only-source-replacement-cli.js';
const digest = (value: unknown) => createHash('sha256').update(migrationCutoverCanonicalJson(value)).digest('hex');
const hash = 'a'.repeat(64);
const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
function fixture() {
  const validator = { kind: 'execution', validatorId: 'validator', keyId: 'key', publicKey, actorId: 'actor', authorizationRef: 'original-authorization', reviewedSourceProviders: ['official-replay'], validUntil: Date.now()+86400000 };
  const trusted = { approvalRef: 'original-approval', validators: [validator] };
  const review = { version: 1 as const, importId: 'new-contract', approvalRef: 'user-source-replacement', generationId: 'gen', importedAt: Date.now(), contractRef: 'approved-publicnode-terms', budgets: [{providerId:'new-source',origin:'https://solana-rpc.publicnode.com',windowStartedAt:Date.now(),windowMs:60000,maximumRequests:60,requestsUsed:0,maximumConcurrency:1,cooldownUntil:'0'}] };
  const material = { authority: {generationId:'gen',credential:{path:'/private/credential',sha256:hash},privateKey:{path:'/private/key',sha256:hash},validator:{validatorId:'validator',keyId:'key',publicKey,reviewedProviderBindings:[{chain:'solana',sourceProviderId:'old-source',sourceEndpoint:'https://helius.example/private',replayProviderId:'official-replay',replayEndpoint:'https://api.mainnet-beta.solana.com'}]},publisher:{validators:[structuredClone(validator)]}}, deployment:{generationId:'gen',gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false,walletExecution:{solana:{providerId:'old-source',endpoint:'https://helius.example/private'}}},settings:{providerContracts:[{providerId:'old-source',origin:'https://helius.example',importId:'old',sourceFingerprint:hash,windowMs:60000,maximumRequests:60,maximumConcurrency:1}]},environment:{RADAR_RPC_SOLANA_HTTP_URL:'https://helius.example/private'}};
  const input={oldProviderId:'old-source',oldOrigin:'https://helius.example',oldOperator:'Helius',newOperator:'Allnodes/PublicNode',review,trustedReviewSha256:digest(review),material};
  const job={protocol:'address-only-source-root-prepare-job-v1',expiresAtMs:Date.now()+120000,expectedValidatorConfigurationSha256:digest(validator),expectedValidatorApprovalRefSha256:digest(trusted.approvalRef),expectedValidatorLedgerFingerprint:digest({approvalRef:trusted.approvalRef,proofScope:'validator_authority',configuration:validator})};
  const receipt={status:'provisioned',approvedConfigSha256:digest(trusted)};
  return {input,job,trusted,receipt};
}
describe('root source preparation trusted approval binding',()=>{
 it('retains original trusted validator configuration and approvalRef',()=>{const f=fixture();expect(()=>validateSourcePreparationJob(f.job,f.input,f.trusted,f.receipt)).not.toThrow();});
 it.each(['receipt','configuration','approval','replay','expiry'])('refuses %s drift before publishing',fault=>{const f=fixture();if(fault==='receipt')f.receipt.approvedConfigSha256=hash;if(fault==='configuration')f.job.expectedValidatorConfigurationSha256=hash;if(fault==='approval')f.job.expectedValidatorApprovalRefSha256=hash;if(fault==='replay')f.input.material.authority.validator.reviewedProviderBindings[0]!.replayProviderId='unapproved';if(fault==='expiry')f.job.expiresAtMs=1;expect(()=>validateSourcePreparationJob(f.job,f.input,f.trusted,f.receipt)).toThrow('SOURCE_ROOT_PREPARE_');});
});

const readerFaults = ['missing-keyId','drift-keyId','missing-publicKey','drift-publicKey','invalid-publicKey','non-ed25519',
  'missing-actorId','drift-actorId','missing-authorizationRef','drift-authorizationRef'] as const;
function corruptReader(f: ReturnType<typeof fixture>, fault: string) {
  const reader = f.input.material.authority.validator as unknown as Record<string, unknown>;
  const publisher = f.input.material.authority.publisher.validators[0]! as unknown as Record<string, unknown>;
  const field = fault.slice(fault.indexOf('-') + 1);
  const target = field === 'actorId' || field === 'authorizationRef' ? publisher : reader;
  if (fault.startsWith('missing-')) delete target[field];
  else if (fault === 'drift-publicKey') reader.publicKey = otherKey;
  else if (fault === 'invalid-publicKey') reader.publicKey = 'not-a-key';
  else if (fault === 'non-ed25519') reader.publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({type:'spki',format:'pem'}).toString();
  else target[field] = 'other';
}
describe('reader identity and trusted Ed25519 key binding before prepare', () => {
  it.each(readerFaults)('refuses %s before prepare', fault => {
    const f = fixture(); corruptReader(f, fault);
    expect(() => validateSourcePreparationJob(f.job,f.input,f.trusted,f.receipt)).toThrow('SOURCE_ROOT_PREPARE_');
  });
  it('accepts equivalent Ed25519 SPKI PEM line endings without changing approval', () => {
    const f = fixture(); f.input.material.authority.validator.publicKey = publicKey.replaceAll('\n','\r\n');
    expect(() => validateSourcePreparationJob(f.job,f.input,f.trusted,f.receipt)).not.toThrow();
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSourceReplacementPlan } from '../prepare-address-only-source-replacement.js';
const dockerEnabled = process.env.ADDRESS_RADAR_SOURCE_PREPARE_CLI_DOCKER === '1';
describe.skipIf(!dockerEnabled)('formal standalone root prepare CLI (systemctl fixture, no network/PG)', () => {
  it.each(['valid','scope',...readerFaults])('publishes exclusive private metadata only when reader and authority scope are valid: fault=%s', fault => {
    const directory=mkdtempSync(join(tmpdir(),'source-prepare-cli-'));
    try {
      const f=fixture(),gen='production-20261006-v1';f.input.review.generationId=gen;f.input.material.authority.generationId=gen;f.input.material.deployment.generationId=gen;
      f.input.trustedReviewSha256=digest(f.input.review);
      if(fault!=='valid'&&fault!=='scope')corruptReader(f,fault);
      const plan=createSourceReplacementPlan(f.input);
      writeFileSync(join(directory,'fixture.json'),JSON.stringify({...f,fault,expectedReplacementSha256:plan.replacementSha256,expectedMaterialSha256:digest(plan.material)}),{mode:0o600});
      const build=pathToFileURL(new URL('../build-address-only-compiled-release.mjs',import.meta.url).pathname).href;
      execFileSync(process.execPath,['--input-type=module','-e','const {buildAddressOnlyMaintenanceModule}=await import(process.argv[1]);await buildAddressOnlyMaintenanceModule({entry:process.argv[2],output:process.argv[3],seal:false});',build,new URL('../prepare-address-only-source-replacement-cli.ts',import.meta.url).pathname,join(directory,'prepare.mjs')],{timeout:15000,stdio:['ignore','pipe','pipe']});
      const setup=String.raw`import fs from 'node:fs';import crypto from 'node:crypto';
const f=JSON.parse(fs.readFileSync('/input/fixture.json','utf8')),root='/var/lib/address-radar-maintenance-tools/source-fixture';
fs.mkdirSync(root,{recursive:true,mode:0o700});fs.mkdirSync('/etc/address-radar/source-fixture',{recursive:true,mode:0o700});
const pin=(name,value)=>{const path=root+'/'+name,raw=JSON.stringify(value);fs.writeFileSync(path,raw,{mode:0o600});return {path,sha256:crypto.createHash('sha256').update(raw).digest('hex')};};
const sourcePins={};for(const name of ['authority','deployment','settings','environment'])sourcePins[name]=pin(name+'.json',f.input.material[name]);
for(const service of ['scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console']){const env={...f.input.material.environment};for(const [name,key]of [['deployment','DEPLOYMENT'],['settings','CONFIGURED_PREFLIGHT'],...((service==='wallet-monitor'||f.fault==='scope'&&service==='scanner')?[['authority','AUTHORITY']]:[])]){env['ADDRESS_RADAR_POSTGRES_'+key+'_FILE']=sourcePins[name].path;env['ADDRESS_RADAR_POSTGRES_'+key+'_SHA256']=sourcePins[name].sha256;}fs.writeFileSync('/etc/address-radar/source-fixture/env-'+service,Object.entries(env).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600});}
fs.writeFileSync('/usr/bin/systemctl','#!/bin/sh\nname="$2"\nname="'+'$'+'{name#address-radar-}"\nname="'+'$'+'{name%.service}"\nprintf "/etc/address-radar/source-fixture/env-%s (ignore_errors=no)\\n" "$name"\n',{mode:0o755});
const job={...f.job,outputDirectory:'/var/lib/address-radar-maintenance-tools/source-replacement-cli-fixture',review:pin('review.json',f.input.review),sourcePins,trustedValidatorJob:pin('trusted-job.json',f.trusted),trustedValidatorApplyReceipt:pin('trusted-receipt.json',f.receipt),expectedReplacementSha256:f.expectedReplacementSha256,expectedMaterialSha256:f.expectedMaterialSha256};
const jobPin=pin('job.json',job);fs.copyFileSync('/input/prepare.mjs',root+'/prepare.mjs');fs.chmodSync(root+'/prepare.mjs',0o400);fs.writeFileSync('/work/job-sha',jobPin.sha256,{mode:0o600});`;
      writeFileSync(join(directory,'setup.mjs'),setup,{mode:0o600});
      const run=()=>execFileSync('docker',['run','--rm','--pull=never','--network','none','-v',directory+':/input:ro','--entrypoint','/bin/sh','openclew/trial-base:latest','-c',
        'set -e; test ! -e /node_modules; test ! -e /packages; mkdir -m 700 /work; node /input/setup.mjs; set +e; node /var/lib/address-radar-maintenance-tools/source-fixture/prepare.mjs --job /var/lib/address-radar-maintenance-tools/source-fixture/job.json --job-sha256 "$(cat /work/job-sha)"; code=$?; if [ "$code" -ne 0 ]; then test ! -e /var/lib/address-radar-maintenance-tools/source-replacement-cli-fixture || exit 99; exit "$code"; fi; set -e; node --input-type=module -e \'import fs from "node:fs";const p="/var/lib/address-radar-maintenance-tools/source-replacement-cli-fixture";if((fs.statSync(p).mode&511)!==448)throw Error("directory mode");for(const n of fs.readdirSync(p)){if((fs.statSync(p+"/"+n).mode&511)!==384)throw Error("file mode");}\''],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
      if(fault!=='valid') {
        let failure: { status?: number; stderr?: unknown } | undefined;
        try { run(); } catch (error) { failure = error as typeof failure; }
        expect(failure?.status).toBe(1);
        expect(String(failure?.stderr)).toContain('SOURCE_ROOT_PREPARE_REFUSED_PRESERVED');
      } else {const output=run();expect(output).toContain('PREPARED_NOT_IMPORTED_NOT_ACTIVATED');expect(output).toContain('"closedSourceFields":9');expect(output).toContain('"environmentArtifactPinFields":6');}
    } finally {rmSync(directory,{recursive:true,force:true});}
  },30000);
});
