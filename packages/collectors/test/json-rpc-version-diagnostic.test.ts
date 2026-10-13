import {describe,expect,it,vi} from "vitest";
import {createJsonRpcClient} from "../src/json-rpc-client.js";

const standard=(version:string)=>`Transaction version (${version}) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": ${version}`;
async function fail(params:readonly unknown[],message=standard("1"),method="getTransaction",code=-32015){
  let body="";
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    body=String(init?.body);const request=JSON.parse(body);
    return new Response(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code,message}}));
  });
  const client=createJsonRpcClient({endpoint:"https://private.example/?token=secret",fetch});
  await expect(client.request(method,params)).rejects.toMatchObject({name:"JsonRpcResponseError",code});
  expect(fetch).toHaveBeenCalledOnce();return body;
}
const expected={event:"json_rpc_transaction_version_failure",method:"getTransaction",code:-32015,
  requestedVersionState:"safe_integer",requestedMaxSupportedTransactionVersion:0,
  requiredVersionPresent:true,requiredMaxSupportedTransactionVersion:1};
describe("actual JSON-RPC serialized transaction version diagnostics",()=>{
  it("observes the exact body passed to the existing fetch without URL/signature/message",async()=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{
      const body=await fail(["private-signature",{encoding:"jsonParsed",maxSupportedTransactionVersion:0}]);
      expect(JSON.parse(body).params[1].maxSupportedTransactionVersion).toBe(0);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(expected));
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/secret|private|https:|configuration|signature/);
    }finally{log.mockRestore();}
  });
  it.each([
    [{encoding:"jsonParsed"},"absent",null],
    [{maxSupportedTransactionVersion:undefined},"absent",null],
    [{maxSupportedTransactionVersion:"0"},"invalid",null],
    [{maxSupportedTransactionVersion:1.5},"invalid",null],
    [{maxSupportedTransactionVersion:-1},"invalid",null],
    [{maxSupportedTransactionVersion:Number.MAX_SAFE_INTEGER+1},"invalid",null],
    [{maxSupportedTransactionVersion:1},"safe_integer",1],
  ])("distinguishes actual version field state %j",async(options,requestedVersionState,requestedMaxSupportedTransactionVersion)=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{await fail(["private-signature",options]);expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({...expected,requestedVersionState,requestedMaxSupportedTransactionVersion}));}
    finally{log.mockRestore();}
  });
  it("observes serialization rather than rereading mutable/toJSON request options",async()=>{
    const toJSON=vi.fn(()=>({maxSupportedTransactionVersion:1})),options={maxSupportedTransactionVersion:0,toJSON};
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{await fail(["private-signature",options]);expect(toJSON).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({...expected,requestedMaxSupportedTransactionVersion:1}));}
    finally{log.mockRestore();}
  });
  it.each([
    "private opaque error",standard("01"),standard("-1"),standard("1.5"),standard("9007199254740992"),
    standard("1")+" https://private.example/?token=secret",standard("1").replace(/: 1$/ ,": 2"),"x".repeat(513),
  ])("does not infer a required version from a noncanonical or unsafe response",async message=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{await fail(["private-signature",{maxSupportedTransactionVersion:0}],message);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({...expected,requiredVersionPresent:false,requiredMaxSupportedTransactionVersion:null}));}
    finally{log.mockRestore();}
  });
  it.each(["eth_getLogs","getTransaction https://private.example","secret"])("does not log an unapproved method %s",async method=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{await fail(["private-signature",{maxSupportedTransactionVersion:0}],standard("1"),method);expect(log).not.toHaveBeenCalled();}
    finally{log.mockRestore();}
  });
  it("covers getBlock through the same existing transport and does not log other response codes",async()=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{await fail([5,{maxSupportedTransactionVersion:0}],standard("1"),"getBlock");
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({...expected,method:"getBlock"}));
      log.mockClear();await fail(["private-signature",{maxSupportedTransactionVersion:0}],"private invalid params","getTransaction",-32602);
      expect(log).not.toHaveBeenCalled();}
    finally{log.mockRestore();}
  });
});

describe("version diagnostic own-data and side-effect fencing",()=>{
  it.each(["code","message"])("never executes an error %s getter or toJSON",async field=>{
    const {logJsonRpcTransactionVersionFailure}=await import("../src/json-rpc-version-diagnostic.js");
    const getter=vi.fn(()=>"secret"),toJSON=vi.fn(()=>"secret"),error={code:-32015,message:standard("1"),toJSON};
    Object.defineProperty(error,field,{get:getter});const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{logJsonRpcTransactionVersionFailure(JSON.stringify({method:"getTransaction",params:["secret",{maxSupportedTransactionVersion:0}]}),error);
      expect(getter).not.toHaveBeenCalled();expect(toJSON).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();}
    finally{log.mockRestore();}
  });
  it("rejects inherited metadata and proxy traps",async()=>{
    const {logJsonRpcTransactionVersionFailure}=await import("../src/json-rpc-version-diagnostic.js");
    const trap=vi.fn(()=>{throw new Error("secret");}),body=JSON.stringify({method:"getTransaction",params:["secret",{maxSupportedTransactionVersion:0}]});
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{
      logJsonRpcTransactionVersionFailure(body,Object.create({code:-32015,message:standard("1")}));
      logJsonRpcTransactionVersionFailure(body,new Proxy({code:-32015,message:standard("1")},{get:trap,getOwnPropertyDescriptor:trap}));
      expect(trap).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
    }finally{log.mockRestore();}
  });
  it("bounds request-body parsing and cannot turn a failed log into transport success",async()=>{
    const {logJsonRpcTransactionVersionFailure}=await import("../src/json-rpc-version-diagnostic.js");
    const log=vi.spyOn(console,"error").mockImplementation(()=>{throw new Error("private sink");});
    try{expect(()=>logJsonRpcTransactionVersionFailure("x".repeat(4097),{code:-32015,message:standard("1")})).not.toThrow();
      await fail(["private-signature",{maxSupportedTransactionVersion:0}]);expect(log).toHaveBeenCalledOnce();}
    finally{log.mockRestore();}
  });
});
