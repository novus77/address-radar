import { describe, expect, it } from "vitest";
import { fomoCdpEndpoint, fomoCdpActivityPayload } from "../src/fomo-cdp-observer.js";
describe("passive FOMO CDP boundary", () => {
  it("allows only a local debugger endpoint", () => {
    expect(fomoCdpEndpoint("http://127.0.0.1:9222").origin).toBe("http://127.0.0.1:9222");
    for (const url of ["http://example.com:9222","http://user:secret@127.0.0.1:9222","http://127.0.0.1:9222?token=secret","file:///tmp/session"]) expect(()=>fomoCdpEndpoint(url)).toThrow();
  });
  it("accepts only inbound text socket frames", () => {
    expect(fomoCdpActivityPayload(JSON.stringify({method:"Network.webSocketFrameReceived",params:{response:{opcode:1,payloadData:"activity"}}}))).toBe("activity");
    expect(fomoCdpActivityPayload(JSON.stringify({method:"Network.webSocketFrameSent",params:{response:{opcode:1,payloadData:"secret"}}}))).toBeNull();
    expect(fomoCdpActivityPayload("invalid")).toBeNull();
  });
});
