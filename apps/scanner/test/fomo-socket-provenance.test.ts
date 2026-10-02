import { describe, expect, it } from "vitest";
import { createFomoSocketFrameTracker } from "../src/fomo-socket-provenance.js";
const created = (url:string)=>JSON.stringify({method:"Network.webSocketCreated",params:{requestId:"socket",url}});
const frame=JSON.stringify({method:"Network.webSocketFrameReceived",params:{requestId:"socket",response:{opcode:1,payloadData:"trade"}}});
describe("FOMO socket provenance",()=>{
  it("requires the observed production socket before accepting a frame",()=>{
    const tracker=createFomoSocketFrameTracker();
    expect(tracker.observe(frame)).toBeNull();
    expect(tracker.observe(created("wss://prod-api.fomo.family/ws?session=redacted"))).toBeNull();
    expect(tracker.observe(frame)).toBe("trade");
  });
  it.each(["wss://example.com/ws","wss://prod-api.fomo.family/other","ws://prod-api.fomo.family/ws"])("rejects a different source %s",url=>{
    const tracker=createFomoSocketFrameTracker();tracker.observe(created(url));expect(tracker.observe(frame)).toBeNull();
  });
  it("forgets closed sockets",()=>{
    const tracker=createFomoSocketFrameTracker();tracker.observe(created("wss://prod-api.fomo.family/ws"));
    tracker.observe(JSON.stringify({method:"Network.webSocketClosed",params:{requestId:"socket"}}));
    expect(tracker.observe(frame)).toBeNull();
  });
});
