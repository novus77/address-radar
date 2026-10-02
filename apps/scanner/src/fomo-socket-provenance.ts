const object = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function createFomoSocketFrameTracker() {
  const allowed = new Set<string>();
  return Object.freeze({
    observe(body: string): string | null {
      if(Buffer.byteLength(body,"utf8") > 128 * 1024) return null;
      let message: Record<string,unknown> | null;
      try {message=object(JSON.parse(body));} catch {return null;}
      const params=object(message?.params);
      const requestId=params?.requestId;
      if(typeof requestId !== "string" || requestId.length > 128) return null;
      if(message?.method === "Network.webSocketClosed") {allowed.delete(requestId);return null;}
      if(message?.method === "Network.webSocketCreated") {
        allowed.delete(requestId);
        if(typeof params?.url !== "string" || params.url.length > 4096 || allowed.size >= 256) return null;
        try {
          const url=new URL(params.url);
          if(url.origin === "wss://prod-api.fomo.family" && url.pathname === "/ws" && !url.username && !url.password) allowed.add(requestId);
        } catch {return null;}
        return null;
      }
      if(message?.method !== "Network.webSocketFrameReceived" || !allowed.has(requestId)) return null;
      const response=object(params?.response);
      return response?.opcode === 1 && typeof response.payloadData === "string" && Buffer.byteLength(response.payloadData,"utf8") <= 64 * 1024 ? response.payloadData : null;
    },
  });
}
