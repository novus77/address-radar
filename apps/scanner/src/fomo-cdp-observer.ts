import { createFomoSocketFrameTracker } from "./fomo-socket-provenance.js";
const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function fomoCdpEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("FOMO CDP endpoint must be a credential-free localhost HTTP origin");
  return url;
}

export function fomoCdpActivityPayload(body: string): string | null {
  if (Buffer.byteLength(body,"utf8") > 128 * 1024) return null;
  let value: Record<string, unknown> | null;
  try { value = object(JSON.parse(body)); } catch { return null; }
  if (value?.method !== "Network.webSocketFrameReceived") return null;
  const response = object(object(value.params)?.response);
  return response?.opcode === 1 && typeof response.payloadData === "string" && Buffer.byteLength(response.payloadData,"utf8") <= 64 * 1024 ? response.payloadData : null;
}

export function createFomoCdpObserver(input: { readonly endpoint: string; readonly onActivity: (body: string) => void }) {
  const endpoint = fomoCdpEndpoint(input.endpoint);
  const sockets = new Map<string, WebSocket>();
  const attached = new Set<string>();
  let lastRefresh = 0;
  let closed = false;
  let captureError: Error | null = null;
  return Object.freeze({
    async refresh(): Promise<number> {
      if (captureError) { const error=captureError;captureError=null;throw error; }
      if (closed) return 0;
      if (Date.now() - lastRefresh < 10_000) return attached.size;
      const response = await fetch(new URL("/json/list",endpoint), {signal:AbortSignal.timeout(5_000)});
      if (!response.ok) throw new Error(`FOMO debugger discovery HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text,"utf8") > 1024 * 1024) throw new Error("FOMO debugger discovery response exceeds limit");
      const pages: unknown = JSON.parse(text);
      if (!Array.isArray(pages)) throw new Error("FOMO debugger discovery is not a page list");
      const current = new Set<string>();
      for (const candidate of pages.slice(0,32)) {
        const page = object(candidate);
        if (page?.type !== "page" || typeof page.url !== "string" || typeof page.id !== "string" || typeof page.webSocketDebuggerUrl !== "string") continue;
        let pageUrl: URL;
        let socketUrl: URL;
        try { pageUrl = new URL(page.url); socketUrl = new URL(page.webSocketDebuggerUrl); } catch { continue; }
        if (pageUrl.protocol !== "https:" || !["fomo.family","www.fomo.family"].includes(pageUrl.hostname)) continue;
        if (socketUrl.protocol !== "ws:" || socketUrl.host !== endpoint.host || socketUrl.username || socketUrl.password || socketUrl.search || socketUrl.hash || !socketUrl.pathname.startsWith("/devtools/page/")) continue;
        const id=page.id;
        current.add(id);
        if (sockets.has(id)) continue;
        const tracker = createFomoSocketFrameTracker();
        const socket = new WebSocket(socketUrl);
        sockets.set(id,socket);
        const timer=setTimeout(()=>{if(!attached.has(id)) socket.close();},5_000);
        socket.addEventListener("open",()=>socket.send(JSON.stringify({id:1,method:"Network.enable"})));
        socket.addEventListener("message",event=>{
          if(typeof event.data !== "string") return;
          if(Buffer.byteLength(event.data,"utf8") > 128 * 1024) return;
          let message: Record<string,unknown> | null;
          try { message=object(JSON.parse(event.data)); } catch { return; }
          if(message?.id === 1) {
            if(message.error) {socket.close();return;}
            clearTimeout(timer);attached.add(id);
          }
          const body=tracker.observe(event.data);
          if(body !== null && attached.has(id)) {
            try {input.onActivity(body);} catch(error) {captureError=error instanceof Error?error:new Error("FOMO capture persistence failed");socket.close();}
          }

        });
        const cleanup=()=>{clearTimeout(timer);attached.delete(id);if(sockets.get(id)===socket)sockets.delete(id);};
        socket.addEventListener("close",cleanup);
        socket.addEventListener("error",()=>{cleanup();socket.close();});
      }
      for(const [id,socket] of sockets) if(!current.has(id)) socket.close();
      lastRefresh=Date.now();
      return attached.size;
    },
    close() {closed=true;for(const socket of sockets.values())socket.close();sockets.clear();attached.clear();},
  });
}
