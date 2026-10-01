import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceLedgerStore, migrateAddressRadarDatabase, openAddressRadarDatabase } from "../src/index.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });
const fixture = () => {
  const path=join(mkdtempSync(join(tmpdir(),"provider-budget-")),"radar.db");
  const first=openAddressRadarDatabase(path); migrateAddressRadarDatabase(first);
  const second=openAddressRadarDatabase(path); databases.push(first,second);
  return { first:createSourceLedgerStore(first),second:createSourceLedgerStore(second) };
};
function consume(store: ReturnType<typeof createSourceLedgerStore>, provider: string, window: string, units: number, limit: number) {
  const reserve=(store as unknown as { tryConsumeBudget?: (p:string,w:string,u:number,l:number,at:number)=>boolean }).tryConsumeBudget;
  expect(reserve).toBeTypeOf("function");
  return reserve!(provider,window,units,limit,100);
}

describe("atomic provider budget reservation",()=>{
  it("does not let two independent connections spend the same observed remaining quota",()=>{
    const f=fixture();
    expect(f.first.budgetUsage("gecko","1")).toBe(0);
    expect(f.second.budgetUsage("gecko","1")).toBe(0);
    expect(consume(f.first,"gecko","1",1,1)).toBe(true);
    expect(consume(f.second,"gecko","1",1,1)).toBe(false);
    expect(f.first.budgetUsage("gecko","1")).toBe(1);
  });
  it("keeps providers and minute windows independent and rejects a reservation without charging",()=>{
    const f=fixture();
    expect(consume(f.first,"gecko","1",2,1)).toBe(false);
    expect(f.first.budgetUsage("gecko","1")).toBe(0);
    expect(consume(f.first,"gecko","1",1,1)).toBe(true);
    expect(consume(f.second,"gecko","2",1,1)).toBe(true);
    expect(consume(f.second,"llama","1",1,1)).toBe(true);
  });
  it("includes existing ledger usage without rewriting its history",()=>{
    const f=fixture();
    f.first.addBudgetUsage("dune","day",0.5,1);
    expect(consume(f.second,"dune","day",0.5,1)).toBe(true);
    expect(consume(f.first,"dune","day",0.1,1)).toBe(false);
    expect(f.first.budgetUsage("dune","day")).toBe(1);
  });
  it.each([[-1,1],[Number.NaN,1],[1,Number.POSITIVE_INFINITY]])("rejects invalid reservation units=%s limit=%s",(units,limit)=>{
    const f=fixture();
    expect(()=>consume(f.first,"gecko","1",units,limit)).toThrow();
    expect(f.first.budgetUsage("gecko","1")).toBe(0);
  });
});
