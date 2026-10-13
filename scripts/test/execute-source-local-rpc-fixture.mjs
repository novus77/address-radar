/** Network-only fixture prelude. Never deploy this file or its derived probe. */
import {createServer as fixtureCreateServer} from 'node:http';
import {readFileSync as fixtureReadFile} from 'node:fs';
if(!process.argv.includes('--verify-release-summary')){
  const fixtureRoot='/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef';
  if(process.geteuid?.()!==0 || fixtureReadFile('/proc/1/comm','utf8').trim()!=='systemd' || !process.argv[1]?.startsWith(fixtureRoot+'/tools/'))throw Error('isolated_rpc_fixture_only');
  const fixturePayload=JSON.parse(fixtureReadFile(fixtureRoot+'/probe-payload.json','utf8'));
  const fixtureWallet='11111111111111111111111111111111',fixtureMint='TokenCase',fixtureQuote='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const fixtureTime=Math.floor(fixturePayload.event.occurredAt/1000);
  const fixtureTransaction={version:1,slot:5,blockTime:fixtureTime,transaction:{signatures:['fixture-signature'],message:{
    accountKeys:[{pubkey:fixtureWallet,signer:true,writable:true,source:'transaction'},{pubkey:'token-account',signer:false,writable:true,source:'transaction'},{pubkey:'usdc-account',signer:false,writable:true,source:'transaction'},{pubkey:'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',signer:false,writable:false,source:'transaction'}],recentBlockhash:'fixture-recent-block',instructions:[{programId:'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',accounts:[fixtureWallet,'token-account','usdc-account'],data:'1'}],transactionConfig:{computeUnitLimit:null,heapSize:null,loadedAccountsDataSizeLimit:null,priorityFee:null}}},
    meta:{err:null,fee:5000,preBalances:[1000000000,2039280,2039280,1],postBalances:[999995000,2039280,2039280,1],innerInstructions:null,
      preTokenBalances:[{accountIndex:1,mint:fixtureMint,owner:fixtureWallet,uiTokenAmount:{amount:'0',decimals:0}},{accountIndex:2,mint:fixtureQuote,owner:fixtureWallet,uiTokenAmount:{amount:'100000000',decimals:6}}],
      postTokenBalances:[{accountIndex:1,mint:fixtureMint,owner:fixtureWallet,uiTokenAmount:{amount:'100',decimals:0}},{accountIndex:2,mint:fixtureQuote,owner:fixtureWallet,uiTokenAmount:{amount:'40000000',decimals:6}}]}};
  let fixtureRequests=0;
  const fixtureServer=fixtureCreateServer(async(req,res)=>{
    let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2097152){req.destroy();return;}}
    if(++fixtureRequests>8){res.writeHead(429).end();return;}
    const request=JSON.parse(body);
    const results={getGenesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',getSignatureStatuses:{context:{slot:5},value:[{slot:5,confirmations:null,err:null,confirmationStatus:'finalized'}]},
      getTransaction:fixtureTransaction,getBlock:{blockhash:'fixture-block',previousBlockhash:'fixture-parent-block',parentSlot:4,blockHeight:5,blockTime:fixtureTime,signatures:['fixture-signature']}};
    if(!Object.hasOwn(results,request.method)){res.writeHead(400).end();return;}
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:request.id,result:results[request.method]}));
  });
  await new Promise((resolve,reject)=>{fixtureServer.once('error',reject);fixtureServer.listen(0,'127.0.0.1',resolve);});
  fixtureServer.unref();
  const fixtureAddress=fixtureServer.address(),fixtureFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    const url=new URL(String(input));
    if(!['https://solana-rpc.publicnode.com/','https://api.mainnet-beta.solana.com/'].includes(url.href)||init?.method!=='POST'||typeof init.body!=='string')throw Error('isolated_rpc_fixture_request');
    return fixtureFetch(`http://127.0.0.1:${fixtureAddress.port}/`,init).then(response=>new Response(response.body,{status:response.status,statusText:response.statusText,headers:response.headers}));
  };
}
