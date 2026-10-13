import { describe, expect, it, vi } from 'vitest';
import { measureEvmFloors, operationalOnlyRuntime, validateFloorJob, EVM_FLOOR_OPERATIONAL_SQL as SQL } from '../measure-address-only-evm-bootstrap-floors.js';
import type { FloorProvider } from '../measure-address-only-evm-bootstrap-floors.js';
import type { PostgresBusinessRuntime } from '../../packages/database/src/postgres-business-driver.js';
// Binding tests isolate deployment validation; production imports the real validator.
vi.mock('../postgres-service-entry.js',()=>({validatePostgresServiceDeployment:(value:unknown)=>value}));

const h = (n: number) => '0x'+n.toString(16).padStart(64,'0');
const provider: FloorProvider = {chain:'bsc',providerId:'bsc-source',endpoint:'https://rpc.example/SECRET',expectedChainId:'56',expectedGenesisBlockHash:h(0)};
function fake(options: {head?:number; timestamp?:(n:number)=>number; mutate?:(r:any,q:any)=>void} = {}) {
  const head = options.head ?? 100;
  return vi.fn(async (_url:any,init:any) => {
    const q = JSON.parse(init.body);
    const n = q.params[0] === 'latest' ? head : Number(BigInt(q.params[0] ?? '0x0'));
    const result = q.method === 'eth_chainId' ? '0x38' : {number:'0x'+n.toString(16),hash:h(n),parentHash:h(Math.max(0,n-1)),
      timestamp:'0x'+(options.timestamp?.(n) ?? 100+n*2).toString(16)};
    const response = {jsonrpc:'2.0',id:q.id,result}; options.mutate?.(response,q);
    return new Response(JSON.stringify(response));
  });
}
const measure = (fetch:any,activatedAt=151000,providers:FloorProvider[]=[provider]) => measureEvmFloors({fetch,activatedAt,providers,signal:new AbortController().signal});
describe('maintenance EVM bootstrap floors',()=>{
  it('finds the first header at or after millisecond activation, not a rounded historical block',async()=>{
    const fetch = fake(), r = await measure(fetch);
    expect(r.floors).toEqual({bsc:26}); expect(r.chains[0]!.before!.number).toBe(25);
    expect(r.chains[0]!.header.timestamp).toBe(152); expect(r.providerRequests['bsc-source']).toBeLessThanOrEqual(40);
    expect(JSON.stringify(r)).not.toContain('SECRET'); expect(JSON.stringify(r)).not.toContain('https:');
    for (const [,init] of fetch.mock.calls) {
      const q = JSON.parse(init.body); expect(['eth_chainId','eth_getBlockByNumber']).toContain(q.method);
      expect(init.redirect).toBe('error'); if (q.method !== 'eth_chainId') expect(q.params[1]).toBe(false);
    }
  });
  it('allows an exact positive timestamp boundary and refuses an unusable genesis floor',async()=>{
    expect((await measure(fake(),150000)).floors.bsc).toBe(25);
    await expect(measure(fake(),0)).rejects.toThrow('EVM_FLOOR_REFUSED');
  });
  it('selects the first of repeated timestamps',async()=>{
    const r = await measure(fake({timestamp:n=>100+Math.floor(n/3)}),110000); expect(r.floors.bsc).toBe(30);
  });
  it('measures every supplied active chain independently',async()=>{
    const base = {...provider,chain:'base' as const,providerId:'base-source',endpoint:'https://base.example/SECRET'};
    const r = await measure(fake(),151000,[provider,base]); expect(r.floors).toEqual({bsc:26,base:26});
  });
  it('rejects identity mismatches, null headers, RPC errors and wrong IDs',async()=>{
    for (const mutate of [(r:any,q:any)=>{if(q.method==='eth_chainId')r.result='0x1';},
      (r:any,q:any)=>{if(q.params[0]==='0x0')r.result.hash=h(2);},
      (r:any,q:any)=>{if(q.params[0]==='latest')r.result=null;},
      (r:any)=>{r.error={message:'SECRET'};},(r:any)=>{r.id=999;}]) {
      await expect(measure(fake({mutate}))).rejects.toThrow('EVM_FLOOR_REFUSED');
    }
  });
  it('rejects an activation newer than the pinned head',async()=>{await expect(measure(fake(),999999)).rejects.toThrow();});
  it('rejects noncanonical quantities and unsafe timestamps',async()=>{
    for (const bad of ['0x00','-1','0x20000000000000']) {
      await expect(measure(fake({mutate:(r,q)=>{if(q.method!=='eth_chainId')r.result.timestamp=bad;}}))).rejects.toThrow();
    }
  });
  it('rejects a disconnected boundary parent',async()=>{
    await expect(measure(fake({mutate:(r,q)=>{if(q.params[0]==='0x1a')r.result.parentHash=h(500);}}))).rejects.toThrow();
  });
  it('rejects header changes on final boundary recheck',async()=>{
    let count=0;
    await expect(measure(fake({mutate:(r,q)=>{if(q.params[0]==='0x1a'&&++count>1)r.result.hash=h(777);}}))).rejects.toThrow();
  });
  it('rejects observed timestamp regressions',async()=>{
    await expect(measure(fake({timestamp:n=>n===50?400:100+n*2}))).rejects.toThrow();
  });
  it('reserves budget and never exceeds 40 calls for a shared provider',async()=>{
    const p2 = {...provider,chain:'base' as const}; const fetch=fake({head:2**27-1});
    await expect(measure(fetch,151000,[provider,p2])).rejects.toThrow(); expect(fetch.mock.calls.length).toBeLessThanOrEqual(40);
  });
  it('refuses a search whose worst case cannot fit its request cap',async()=>{
    const fetch=fake({head:2**40}); await expect(measure(fetch)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('honors an aborted parent before making a request',async()=>{
    const fetch=fake(); await expect(measureEvmFloors({providers:[provider],activatedAt:1,fetch,
      signal:AbortSignal.abort()})).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it('enforces 180 seconds with monotonic time',async()=>{
    const fetch=fake(); let tick=0;
    await expect(measureEvmFloors({providers:[provider],activatedAt:1,fetch,signal:new AbortController().signal,
      monotonicNow:()=>tick++*180000})).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it('caps responses and stops on HTTP failure without retries',async()=>{
    for (const response of [new Response('x'.repeat(262145)),new Response('SECRET',{status:429})]) {
      const fetch=vi.fn(async()=>response); await expect(measure(fetch)).rejects.toThrow(); expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects unexpected chains, duplicate chains, HTTP and ambiguous provider origins',async()=>{
    for (const providers of [[provider,provider],[{...provider,chain:'other' as any}],
      [{...provider,endpoint:'http://rpc.example'}],[provider,{...provider,chain:'base' as const,providerId:'other'}]]) {
      const fetch=fake(); await expect(measure(fetch,1,providers)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
    }
  });
});
describe('operational-only DB boundary',()=>{
  function setup(row:any={provider_id:provider.providerId}) {
    const query=vi.fn(async()=>({rows:[row]}));
    const native={run:async (op:any)=>op({query}),probe:vi.fn(),statistics:vi.fn(),close:vi.fn()} as unknown as PostgresBusinessRuntime;
    return {runtime:operationalOnlyRuntime(native,'g',[provider]),query};
  }
  it('passes existing budget/lease/cooldown SQL to the same parent runtime, without reimplementing it',async()=>{
    const {runtime,query}=setup();
    for(const [sql,values] of [
      [SQL.lock,['g','https://rpc.example',1]], [SQL.debit,['g',provider.providerId,1,1]],
      [SQL.cooldown,['g',provider.providerId,'1']],
      [SQL.insert,['a'.repeat(36),'g',provider.providerId,'wallet-monitor:owner',1]],
      [SQL.release,['a'.repeat(36),'g',provider.providerId,'wallet-monitor:owner',1]],
      [SQL.activation,['g']],
    ] as const) {
      await runtime.run(tx=>tx.query(sql,values));
    }
    expect(query).toHaveBeenCalledTimes(6);
  });
  it('blocks facts/checkpoints/backfill/provisioning SQL before DB execution',async()=>{
    const {runtime,query}=setup();
    for(const sql of ['INSERT INTO wallet_service_fact_inputs VALUES (1)','UPDATE wallet_service_cursors SET cursor=1',
      'DELETE FROM forward_strategy_generations','CREATE TABLE anything(id text)','SELECT * FROM wallet_service_profile_cohort',
      '/* service-provider-cooldown */ UPDATE wallet_service_fact_inputs SET value=1',
      '/* service-provider-cooldown */ UPDATE wallet_service_provider_budgets SET requests_used=1; DELETE FROM wallet_service_fact_inputs']) {
      await expect(runtime.run(tx=>tx.query(sql))).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('refuses wrong generation/origin or a DB provider identity mismatch',async()=>{
    const {runtime,query}=setup({provider_id:'other'});
    await expect(runtime.run(tx=>tx.query(SQL.lock,['other','https://rpc.example',1]))).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    await expect(runtime.run(tx=>tx.query(SQL.lock,['g','https://other.example',1]))).rejects.toThrow();
    await expect(runtime.run(tx=>tx.query(SQL.lock,['g','https://rpc.example',1]))).rejects.toThrow();
  });
  it('rejects exact-template suffixes, comment camouflage and altered statements',async()=>{
    const {runtime,query}=setup();
    for(const sql of [SQL.debit+'; DELETE FROM wallet_service_fact_inputs',SQL.debit+' RETURNING 1',
      SQL.lock+' /* harmless */',SQL.cooldown.replace('wallet_service_provider_budgets','wallet_service_fact_inputs'),
      SQL.release.replace('released_at=$5','released_at=$5,owner_id=$4'),
      '/* service-provider-budget-lock */ SELECT 1']) {
      await expect(runtime.run(tx=>tx.query(sql,['g',provider.providerId,1,1]))).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('validates complete parameter count and generation/provider positions for every write',async()=>{
    const {runtime,query}=setup();
    for(const [sql,values] of [
      [SQL.debit,['g','unapproved',1,1]], [SQL.debit,['other',provider.providerId,1,1]],
      [SQL.debit,['g',provider.providerId,1,1,99]], [SQL.cooldown,['g',provider.providerId,'-1']],
      [SQL.insert,['a'.repeat(36),'other',provider.providerId,'wallet-monitor:owner',1]],
      [SQL.release,['a'.repeat(36),'g','unapproved','wallet-monitor:owner',1]],
      [SQL.release,['a'.repeat(36),'g',provider.providerId,'publisher:owner',1]],
      [SQL.lock,['g','https://rpc.example']], [SQL.activation,['g',1]],
    ] as const) await expect(runtime.run(tx=>tx.query(sql,values))).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
describe('root job contract',()=>{
  const pin={path:'/private/pin.json',sha256:'a'.repeat(64)};
  const job={protocol:'address-only-evm-floor-job-v1',generationId:'g',activatedAt:1,releaseSha256:'b'.repeat(64),
    deployment:pin,environment:pin,credential:pin,currentJournal:pin,currentReceipt:pin,receiptPath:'/private/floors.json'};
  it('accepts explicit pins only',()=>{expect(validateFloorJob(job)).toEqual(job);});
  it('rejects absent activation, guessed release, unpinned credentials and unsafe receipt paths',()=>{
    for(const change of [{activatedAt:undefined},{activatedAt:-1},{releaseSha256:'wrong'},{credential:{...pin,sha256:'wrong'}},
      {receiptPath:'/private/../floors.json'},{receiptPath:'relative.json'},{extra:true}]) expect(()=>validateFloorJob({...job,...change})).toThrow();
  });
});

describe('complete job with the real production adapter and fake DB/network',()=>{
  async function setup() {
    const { createHash } = await import('node:crypto');
    const { createPostgresServiceFactAdapters } = await import('../../apps/automation/src/postgres-service-fact-adapters.js');
    const { runFloorJob } = await import('../measure-address-only-evm-bootstrap-floors.js');
    const sha='a'.repeat(64), id={operationId:'op',importId:'cohort',generationId:'g',activatedAt:151000,releaseSha256:sha};
    const receipt={...id,protocol:'address-only-configured-transition-receipt-v1',databaseImported:true,newImportPerformed:false,
      businessReleaseSwitched:true,businessEligibilityGranted:false,monitoringCompleted:false,
      gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false};
    const authority={protocol:'address-only-cli-execution-authority-v1',operationId:'op',generationId:'g',releaseSha256:sha,
      validator:{reviewedProviderBindings:[{...provider,sourceProviderId:provider.providerId,sourceEndpoint:provider.endpoint}]}};
    const sources={leaseMs:60000,maximumProfileAgeMs:1000,maximumFactAgeMs:1000,maximumSafetyAgeMs:1000,
      providerTimeoutMs:5000,maximumResponseBytes:262144,maximumFactPayloadBytes:262144};
    const config={...id,database:'address_radar',schema:'address_radar_business',releaseRoot:'/opt/address-radar/releases/b',
      cutover:{addressOnly:id},services:{'wallet-monitor':{username:'wallet_role'}},driver:{connectionTimeoutMs:5000,
        statementTimeoutMs:5000,lockTimeoutMs:1000,shutdownTimeoutMs:5000},wallet:{maximumProfiles:1},sources,
      walletExecution:{evm:{bsc:{...provider}}}};
    const raw=new Map<string,Buffer>();
    const pin=(name:string,value:any)=>{
      const bytes=Buffer.from(JSON.stringify(value));raw.set('/root/'+name+'.json',bytes);
      return {path:'/root/'+name+'.json',sha256:createHash('sha256').update(bytes).digest('hex')};
    };
    const authorityPin=pin('authority',authority);
    const environment={ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE:authorityPin.path,
      ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256:authorityPin.sha256,ADDRESS_RADAR_POSTGRES_RELEASE_SHA256:sha};
    const job={protocol:'address-only-evm-floor-job-v1',generationId:'g',activatedAt:151000,releaseSha256:sha,
      deployment:pin('deployment',config),environment:pin('environment',environment),
      credential:pin('credential',{username:'wallet_role',connectionString:'postgresql://wallet_role:SECRET@127.0.0.1:5432/address_radar',gatewayDeliveryEnabled:false}),
      currentJournal:pin('journal',{phase:'COMPLETE',pending:null,operationId:'op',configuredReleaseRoot:config.releaseRoot,
        release:{releaseSha256:sha},receipt}),currentReceipt:pin('receipt',receipt),receiptPath:'/root/floor.json'};
    const query=vi.fn(async(sql:string)=>{
      if(sql.startsWith('SELECT activated_at')) return {rows:[{activated_at:'151000'}]};
      if(sql.includes('service-provider-budget-lock')) return {rows:[{provider_id:provider.providerId,cooldown_until:'0',
        window_started_at:Date.now()-1000,window_ms:60000,active_leases:0,maximum_concurrency:1,requests_used:0,maximum_requests:100}]};
      return {rows:[{provider_id:provider.providerId}]};
    });
    const runtime={run:async(op:any)=>op({query}),probe:vi.fn(async()=>({generation:'g',database:config.database,
      schema:config.schema,username:'wallet_role',service:'wallet-monitor'})),close:vi.fn(async()=>{}),statistics:vi.fn()};
    const fetch=fake(); const publish=vi.fn(async()=>({receiptPath:job.receiptPath,receiptSha256:sha}));
    const createRuntime=vi.fn(()=>runtime as any);
    const ports={readPin:vi.fn(async(p:any)=>{const bytes=raw.get(p.path)!;expect(createHash('sha256').update(bytes).digest('hex')).toBe(p.sha256);return bytes;}),
      verifyRelease:vi.fn(async()=>sha),createRuntime,
      createFacts:(options:any)=>createPostgresServiceFactAdapters({...options,sources:{...options.sources,fetchImpl:fetch}}),
      publish,checkReceiptTarget:vi.fn(async()=>{})};
    return {runFloorJob,job,ports,raw,fetch,query,publish,runtime,createRuntime};
  }
  it('uses real adapter debit/lease/release for each call and publishes only after close',async()=>{
    const x=await setup(); await x.runFloorJob(x.job,x.ports);
    const sql=x.query.mock.calls.map(([s])=>s);
    expect(sql.filter(s=>s.includes('service-provider-budget-debit'))).toHaveLength(x.fetch.mock.calls.length);
    expect(sql.filter(s=>s.startsWith('INSERT INTO wallet_service_provider_leases'))).toHaveLength(x.fetch.mock.calls.length);
    expect(sql.filter(s=>s.includes('service-provider-release'))).toHaveLength(x.fetch.mock.calls.length);
    expect(x.runtime.close.mock.invocationCallOrder[0]).toBeLessThan(x.publish.mock.invocationCallOrder[0]!);
    const receipt=(x.publish.mock.calls[0] as any)[1];
    expect(receipt.floorEnvironment).toBe('{"bsc":26}'); expect(receipt.activationGranted).toBe(false);
    expect(receipt.signalPermissionGranted).toBe(false); expect(receipt.businessFactsWritten).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('SECRET'); expect(JSON.stringify(receipt)).not.toContain('https:');
    expect(sql.some(s=>/checkpoint|fact_inputs|backfill|publication/.test(s))).toBe(false);
  });
  it('rejects job activation/release/generation mismatches before DB or RPC',async()=>{
    for(const change of [{activatedAt:1},{releaseSha256:'b'.repeat(64)},{generationId:'other'}]) {
      const x=await setup();await expect(x.runFloorJob({...x.job,...change},x.ports)).rejects.toThrow();
      expect(x.createRuntime).not.toHaveBeenCalled();expect(x.fetch).not.toHaveBeenCalled();expect(x.publish).not.toHaveBeenCalled();
    }
  });
  it('rejects DB activation mismatch with no RPC and closes runtime',async()=>{
    const x=await setup();x.query.mockResolvedValueOnce({rows:[{activated_at:'1'}]} as any);
    await expect(x.runFloorJob(x.job,x.ports)).rejects.toThrow();expect(x.fetch).not.toHaveBeenCalled();
    expect(x.runtime.close).toHaveBeenCalled();expect(x.publish).not.toHaveBeenCalled();
  });
  it('persists 429 cooldown and releases the actual adapter lease; never publishes a floor',async()=>{
    const x=await setup();x.fetch.mockImplementation(async()=>new Response('SECRET',{status:429,headers:{'Retry-After':'60'}}));
    await expect(x.runFloorJob(x.job,x.ports)).rejects.toThrow();
    const sql=x.query.mock.calls.map(([s])=>s);expect(sql.some(s=>s.includes('service-provider-cooldown'))).toBe(true);
    expect(sql.some(s=>s.includes('service-provider-release'))).toBe(true);expect(x.publish).not.toHaveBeenCalled();
  });
  it('honors a durable cooldown before network execution',async()=>{
    const x=await setup();const impl=x.query.getMockImplementation()!;
    x.query.mockImplementation(async(sql:string)=>sql.includes('service-provider-budget-lock')
      ? {rows:[{provider_id:provider.providerId,cooldown_until:String(Date.now()+60000)}]} as any : impl(sql));
    await expect(x.runFloorJob(x.job,x.ports)).rejects.toThrow();expect(x.fetch).not.toHaveBeenCalled();expect(x.publish).not.toHaveBeenCalled();
  });
  it('refuses a zero floor before receipt publication with the actual adapter',async()=>{
    const x=await setup();const transport=fake({timestamp:n=>200+n});x.fetch.mockImplementation(transport);
    await expect(x.runFloorJob(x.job,x.ports)).rejects.toThrow();expect(x.publish).not.toHaveBeenCalled();
    expect(x.runtime.close).toHaveBeenCalled();
  });
});
