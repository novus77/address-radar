import { describe,expect,it } from "vitest";
import { runDurableForwardTargetRefreshCoordinator } from "../src/forward-target-refresh-coordinator.js";
describe("durable refresh loop",()=>{
  it("does not start work when already paused",async()=>{
    const controller=new AbortController();controller.abort();let calls=0;
    await runDurableForwardTargetRefreshCoordinator({tick:async()=>{calls++;return {status:"busy" as const};}},{intervalMs:10,signal:controller.signal,onResult:()=>undefined});
    expect(calls).toBe(0);
  });
  it("stops after cancellation without scheduling another page",async()=>{
    const controller=new AbortController();let calls=0,reports=0;
    await runDurableForwardTargetRefreshCoordinator({tick:async()=>{calls++;return {status:"busy" as const};}},{intervalMs:10,signal:controller.signal,onResult:()=>{reports++;controller.abort();}});
    expect(calls).toBe(1);expect(reports).toBe(1);
  });
});
