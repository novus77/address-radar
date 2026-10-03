import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { readPostgresForwardTrace, type PostgresTransaction } from "@address-radar/database";
import type { ForwardTargetPrincipal } from "@address-radar/domain";

export interface ForwardTraceConsoleOptions {
  readonly run: <T>(operation: (tx: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly generationId: string; readonly developerToken: string; readonly principal: ForwardTargetPrincipal;
  readonly now: () => number; readonly limit: number; readonly maximumInFlight: number;
  readonly requestTimeoutMs: number; readonly port: number; readonly publicDirectory: string;
}

export async function startForwardTraceConsole(options: ForwardTraceConsoleOptions): Promise<{ readonly url: string; close(): Promise<void> }> {
  if (options.developerToken.length < 32 || !options.generationId.trim() ||
      !options.principal.permissions.includes("target_registry_write") ||
      !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000 ||
      !Number.isInteger(options.maximumInFlight) || options.maximumInFlight < 1 || options.maximumInFlight > 2 ||
      !Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 ||
      !Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid trace console configuration");
  const staticFiles = new Map<string, { type: string; content: Buffer }>();
  for (const [route,file,type] of [
    ["/","forward-trace.html","text/html; charset=utf-8"],
    ["/forward-trace.css","forward-trace.css","text/css; charset=utf-8"],
    ["/forward-trace.js","forward-trace.js","text/javascript; charset=utf-8"]
  ] as const) staticFiles.set(route,{type,content:await readFile(join(options.publicDirectory,file))});
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(options.developerToken);
  let inFlight = 0;
  const server = createServer((request,response) => {
    response.setHeader("Cache-Control","no-store");
    response.setHeader("X-Content-Type-Options","nosniff");
    response.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status: number,body: unknown) => { response.writeHead(status,{"Content-Type":"application/json; charset=utf-8"}); response.end(JSON.stringify(body)); };
    void (async () => {
      const url = new URL(request.url ?? "/","http://127.0.0.1");
      if (url.pathname === "/api/v2/forward-trace") {
        const authorization = request.headers.authorization ?? "";
        if (!authorization.startsWith("Bearer ") || !timingSafeEqual(expected,digest(authorization.slice(7)))) { send(401,{error:"operator_authorization_required"}); return; }
        if (request.method !== "GET") { request.resume(); send(405,{error:"read_only_endpoint"}); return; }
        const allowed = new Set(["entityId","afterBoughtAt","afterSampleId"]);
        if ([...url.searchParams.keys()].some(key=>!allowed.has(key) || url.searchParams.getAll(key).length !== 1)) { send(400,{error:"invalid_trace_query"}); return; }
        const entityId = url.searchParams.get("entityId") ?? "";
        const boughtAt = url.searchParams.get("afterBoughtAt"), sampleId = url.searchParams.get("afterSampleId");
        if (!entityId.trim() || entityId.length > 512 || (boughtAt === null) !== (sampleId === null) ||
            (boughtAt !== null && (!/^\d+$/.test(boughtAt) || !Number.isSafeInteger(Number(boughtAt)) || !sampleId?.trim()))) { send(400,{error:"invalid_trace_query"}); return; }
        if (inFlight >= options.maximumInFlight) { send(503,{error:"trace_reader_busy"}); return; }
        inFlight++;
        try {
          const snapshot = await options.run(tx=>readPostgresForwardTrace(tx,{entityId,generationId:options.generationId,
            asOf:options.now(),limit:options.limit,after:boughtAt === null ? null : {boughtAt:Number(boughtAt),sampleId:sampleId!}}));
          send(200,snapshot);
        } finally { inFlight--; }
        return;
      }
      const file = staticFiles.get(url.pathname);
      if (request.method !== "GET" || !file) { send(404,{error:"not_found"}); return; }
      response.writeHead(200,{"Content-Type":file.type}); response.end(file.content);
    })().catch(()=>{ if (!response.headersSent) send(503,{error:"trace_snapshot_unavailable"}); else response.destroy(); });
  });
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = options.requestTimeoutMs;
  await new Promise<void>((resolve,reject)=>{ server.once("error",reject); server.listen(options.port,"127.0.0.1",()=>{server.off("error",reject);resolve();}); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Trace listener unavailable");
  return {url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>((resolve,reject)=>{ server.close(error=>error ? reject(error) : resolve()); server.closeIdleConnections(); })};
}
