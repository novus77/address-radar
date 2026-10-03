import { describe,expect,it } from "vitest";
import * as database from "../src/index.js";

describe("durable target refresh coordination",()=>{
  it("exports fenced claim, checkpoint and release operations",()=>{
    const exports=database as unknown as Record<string,unknown>;
    for(const name of ["claimPostgresForwardTargetRefresh","checkpointPostgresForwardTargetRefresh","releasePostgresForwardTargetRefresh"]) expect(exports[name]).toBeTypeOf("function");
  });
});
