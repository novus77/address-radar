import { attachDedicatedReportedApproval, dedicatedReportedLedgerRow } from './reported-market-approval-fixture.js';
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PostgresBusinessRuntime } from "../../../packages/database/src/postgres-business-driver.js";
import { createPostgresServiceFactAdapters, POSTGRES_SERVICE_FACT_SCHEMA_SQL,
  PostgresProviderBudgetError, postgresServiceFactFingerprint } from "../src/postgres-service-fact-adapters.js";

const asOf = 100_000;
const generationId = "generation-live";
const signal = new AbortController().signal;
const sources = { leaseMs: 5000, maximumProfileAgeMs: 60_000, maximumFactAgeMs: 60_000,
  maximumSafetyAgeMs: 10_000, providerTimeoutMs: 1000, maximumResponseBytes: 1000, maximumFactPayloadBytes: 20_000 };
function setup(handler: (sql: string, args: readonly unknown[]) => Record<string, unknown>[] = () => [],
  fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}'))) {
  const queries: string[] = [];
  const query = vi.fn(async (sql: string, args: readonly unknown[] = []) => { queries.push(sql); return { rows: handler(sql, args), rowCount: 1 }; });
  const runtime = { run: async (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    probe: async () => ({ generation: generationId, service: "scanner", schema: "radar_live", database: "radar_live" }) } as unknown as PostgresBusinessRuntime;
  return { runtime, query, queries, fetchImpl,
    create: (extra: Record<string, unknown> = {}) => createPostgresServiceFactAdapters({ runtime, generationId,
      maximumProfiles: 10, now: () => asOf, sources: { ...sources, fetchImpl, ...extra } }) };
}
const peak = { peakId: "real-candle", revisionId: "provider-revision", chain: "solana", tokenAddress: "ActualMint",
  priceUsd: "3", kind: "candle", openedAt: 90_000, closedAt: 95_000, knownAt: 96_000,
  verification: "validated", evidenceRef: "source:actual-candle" };
function fact(kind: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return { fact_id: "fact-1", generation_id: generationId, kind, subject_key: "subject", payload: JSON.stringify(payload),
    fingerprint: postgresServiceFactFingerprint(payload), source_ref: "source:actual-candle", provider_id: "rpc-provider",
    validator_id: "independent-validator", validation_ref: "validation:1", checked_at: 97_000, expires_at: 110_000,
    observed_at: 95_000, known_at: 96_000, validator_from: 0, validator_until: 200_000,
    revoked_at: null, import_revoked_at: null, ...overrides };
}
function priceHandler(rows: Record<string, unknown>[]) {
  return (sql: string) => sql.includes('reported-approval-transaction') ? rows.filter(row => typeof row.payload === 'string').slice(0,1).map(row => {
    const approval = JSON.parse(String(row.payload)).validation.sourceProof.rawEvidence.approval;
    return dedicatedReportedLedgerRow(approval);
  }) : sql.includes("service-fact-price-claim") ? [{ claim_generation: 4, lease_expires_at: 105_000 }]
    : sql.includes("service-fact-inputs") ? rows : sql.includes("service-fact-price-owned") ? [{ claim_generation: 4 }]
    : sql.includes("service-fact-price-complete") ? [{ claim_generation: 4 }] : [];
}

describe("durable service fact ports", () => {
  it("requires explicit budgets and matching probed generation without writing at construction", async () => {
    const state = setup(); const ports = await state.create();
    expect(ports).toHaveProperty("targetedBackfillPoll"); expect(state.queries).toEqual([]);
    await expect(state.create({ maximumFactAgeMs: undefined })).rejects.toThrow("budget");
    await expect(createPostgresServiceFactAdapters({ runtime: state.runtime, generationId: "other", maximumProfiles: 10,
      now: () => asOf, sources })).rejects.toThrow("generation");
  });
  it("uses approved bounded coherent profile reads, never an empty unverified ready cohort", async () => {
    const state = setup(); const ports = await state.create();
    expect(await ports.profiles.load({ generationId, chainFamily: "solana", asOf, limit: 10, signal })).toMatchObject({ status: "deferred" });
    expect(state.queries.join(" ")).toContain("forward_target_identity_bindings");
    expect(state.queries.join(" ")).toContain("service-fact-profile-cohort");
    expect(state.queries.join(" ")).toContain("LIMIT");
  });
  it("defers missing execution and safety proofs and never writes business receipts", async () => {
    const state = setup(); const ports = await state.create();
    expect(await ports.facts.safety({ generationId, asOf, limit: 10, signal,
      sample: { sampleId: "sample", executionFingerprint: "fp", entityId: "entity", chain: "solana", tokenAddress: "Mint", boughtAt: 99_000 } })).toMatchObject({ status: "deferred" });
    expect(state.queries.every(sql => !/INSERT|UPDATE/.test(sql))).toBe(true);
    expect(await ports.facts.target({ generationId, asOf, limit: 10, signal,
      key: { entityId: "entity", channel: "fomo", subjectId: "account", walletFamily: null } })).toEqual({ status: "missing" });
  });
  it.each([
    { fingerprint: "invented" }, { expires_at: asOf }, { validator_id: "rpc-provider" },
    { revoked_at: 99_000 }, { checked_at: 110_000 }, { observed_at: -1 },
  ])("defers independently invalid price proof %j without consumption", async override => {
    const state = setup(priceHandler([fact("price", { type: "peak", peak }, override)])); const ports = await state.create();
    expect(await ports.facts.prices({ generationId, asOf, limit: 10, signal })).toMatchObject({ status: "deferred" });
    expect(state.queries.some(sql => sql.includes("INSERT INTO wallet_service_price_consumption"))).toBe(false);
  });
  it("returns validated canonical prices under a real fenced shared lease, not a ready flag", async () => {
    const state = setup(priceHandler([fact("price", { type: "peak", peak })])); const ports = await state.create();
    const batch = await ports.facts.prices({ generationId, asOf, limit: 10, signal });
    expect(batch.status).toBe("available");
    if (batch.status !== "available") throw new Error("Expected factual price batch");
    expect(batch.peaks).toEqual([peak]); expect(batch.markets).toEqual([]);
    const tx = { query: state.query };
    await batch.lease.assertOwned(tx, asOf); await batch.lease.complete(tx, asOf);
    expect(state.queries.join(" ")).toContain("INSERT INTO wallet_service_price_consumption");
    await expect(batch.lease.assertOwned(tx, 105_000)).rejects.toThrow("lease");
  });
  it("does not poll or fabricate old historical purchases when the price lease is unavailable", async () => {
    const state = setup(); const ports = await state.create();
    expect(await ports.targetedBackfillPoll({ signal, limit: 10 })).toMatchObject({ status: "deferred" });
    expect(state.queries.some(sql => sql.includes("forward_purchase_samples"))).toBe(false);
  });
  it("drains an oversized independent fact backlog in bounded batches rather than permanently deferring", async () => {
    const state=setup(priceHandler([fact("price",{type:"peak",peak}),fact("price",{type:"peak",peak},{fact_id:"fact-2"})]));
    const ports=await state.create(), batch=await ports.facts.prices({generationId,asOf,limit:1,signal});
    expect(batch.status).toBe("available");if(batch.status!=="available")throw new Error("Expected bounded facts");
    expect(batch.peaks).toHaveLength(1);await batch.lease.complete({query:state.query},asOf);
    const consumed=state.query.mock.calls.filter(([sql])=>sql.includes("INSERT INTO wallet_service_price_consumption"));
    expect(consumed).toHaveLength(1);expect(consumed[0]?.[1]).toContain("fact-1");expect(consumed[0]?.[1]).not.toContain("fact-2");
  });
  it("fails closed before network access without a seeded global provider allowance", async () => {
    const state = setup(); const ports = await state.create();
    await expect(ports.fetch("https://rpc.example/secret-path")).rejects.toBeInstanceOf(PostgresProviderBudgetError);
    expect(state.fetchImpl).not.toHaveBeenCalled();
    expect(state.queries.some(sql => sql.includes("INSERT INTO wallet_service_provider_budgets"))).toBe(false);
  });
  it("shares PG request and concurrency budget before RPC and releases after bounded response reading", async () => {
    const state = setup(sql => sql.includes("service-provider-budget-lock") ? [{ provider_id: "provider", window_started_at: 90_000,
      window_ms: 60_000, maximum_requests: 5, requests_used: 2, maximum_concurrency: 2, active_leases: 0, cooldown_until: 0 }]
      : sql.includes("service-provider-budget-debit") ? [{ provider_id: "provider" }] : []);
    const ports = await state.create(); const response = await ports.fetch("https://rpc.example/path");
    expect(await response.json()).toEqual({ ok: true }); expect(state.fetchImpl).toHaveBeenCalledOnce();
    expect(state.fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    const debit = state.queries.findIndex(sql => sql.includes("service-provider-budget-debit"));
    expect(debit).toBeGreaterThanOrEqual(0);
    expect(state.queries.findIndex(sql => sql.includes("service-provider-release"))).toBeGreaterThan(debit);
  });
  it("requires an independent durable producer contract; schema has no business eligibility flags", () => {
    expect(POSTGRES_SERVICE_FACT_SCHEMA_SQL).toContain("wallet_service_fact_attestations");
    expect(POSTGRES_SERVICE_FACT_SCHEMA_SQL).toContain("wallet_service_source_requests");
    expect(POSTGRES_SERVICE_FACT_SCHEMA_SQL).not.toMatch(/adapter_ready|live_source_verified|stable_capability/);
    expect(postgresServiceFactFingerprint({ price: "3" })).toBe(createHash("sha256").update('{"price":"3"}').digest("hex"));
  });
});

describe("shared durable provider cooldown", () => {
  function provider(cooldown: unknown = 0, response = new Response("rate limited",{status:429,headers:{"Retry-After":"20"}})) {
    const row: Record<string,unknown> = { provider_id:"provider",window_started_at:90_000,window_ms:60_000,
      maximum_requests:5,requests_used:2,maximum_concurrency:2,active_leases:0,cooldown_until:cooldown };
    const state=setup((sql,args)=>{
      if(sql.includes("service-provider-budget-lock"))return [{...row}];
      if(sql.includes("service-provider-budget-debit")){row.requests_used=args[3];row.window_started_at=args[2];return [{provider_id:"provider"}];}
      if(sql.includes("service-provider-cooldown")){
        row.cooldown_until=(BigInt(String(row.cooldown_until))>BigInt(String(args[2]))?BigInt(String(row.cooldown_until)):BigInt(String(args[2]))).toString();
        return [{cooldown_until:row.cooldown_until}];
      }
      return [];
    },vi.fn<typeof fetch>().mockResolvedValue(response));
    return {...state,row};
  }
  it("requires an explicit migration-owned cooldown column with no default",()=>{
    expect(POSTGRES_SERVICE_FACT_SCHEMA_SQL).toMatch(/cooldown_until bigint NOT NULL CHECK\(cooldown_until>=0\)/);
    expect(POSTGRES_SERVICE_FACT_SCHEMA_SQL).not.toMatch(/cooldown_until[^,\n]*DEFAULT/);
  });
  it("blocks imported cooldown before request debit, network or lease allocation even after a window rollover",async()=>{
    const state=provider(120_000);state.row.window_started_at=0;state.row.requests_used=5;
    const ports=await state.create();await expect(ports.fetch("https://rpc.example/path")).rejects.toMatchObject({retryAt:120_000});
    expect(state.fetchImpl).not.toHaveBeenCalled();expect(state.row.requests_used).toBe(5);
    expect(state.queries.some(sql=>sql.includes("service-provider-budget-debit")||sql.includes("INSERT INTO wallet_service_provider_leases"))).toBe(false);
  });
  it("persists grounded delta cooldown across independently constructed workers without startup reset",async()=>{
    const state=provider(),first=await state.create();const response=await first.fetch("https://rpc.example/path");
    expect(response.status).toBe(429);expect(state.row.cooldown_until).toBe("120000");expect(state.row.requests_used).toBe(3);
    const writes=state.queries.filter(sql=>/UPDATE|INSERT/.test(sql)).length,second=await state.create();
    expect(state.queries.filter(sql=>/UPDATE|INSERT/.test(sql))).toHaveLength(writes);
    await expect(second.fetch("https://rpc.example/path")).rejects.toMatchObject({retryAt:120_000});
    expect(state.fetchImpl).toHaveBeenCalledOnce();expect(state.row.requests_used).toBe(3);
    const query=state.query.mock.calls.find(([sql])=>sql.includes("service-provider-cooldown"));
    expect(query?.[0]).toContain("GREATEST(cooldown_until");expect(query?.[1]).toEqual([generationId,"provider","120000"]);
    expect(state.queries.findIndex(sql=>sql.includes("service-provider-cooldown"))).toBeLessThan(state.queries.findIndex(sql=>sql.includes("service-provider-release")));
  });
  it.each(["Thu, 01 Jan 1970 00:02:30 GMT","Thursday, 01-Jan-70 00:02:30 GMT","Thu Jan  1 00:02:30 1970"])("accepts actual HTTP-date %s",async header=>{
    const state=provider(0,new Response("rate limited",{status:429,headers:{"Retry-After":header}})),ports=await state.create();
    await ports.fetch("https://rpc.example/path");expect(state.row.cooldown_until).toBe("150000");
  });
  it.each([null,"","invalid","1.5","-2","2026-10-04","Thu, 31 Feb 2026 00:00:00 GMT","0",
    "Thu, 01 Jan 1970 00:00:00 GMT", "x".repeat(257)])("persists finite conservative backoff for missing/invalid Retry-After %j",async header=>{
    const state=provider(0,new Response("rate limited",{status:429,headers:header===null?{}:{"Retry-After":header}}));
    await (await state.create()).fetch("https://rpc.example/path");expect(state.row.cooldown_until).toBe("160000");
    await expect((await state.create()).fetch("https://rpc.example/path")).rejects.toMatchObject({retryAt:160000});
    expect(state.fetchImpl).toHaveBeenCalledOnce();expect(state.row.requests_used).toBe(3);
  });
  it.each(["999999999999999999999999", "86401", "Fri, 01 Jan 9999 00:00:00 GMT"])("bounds huge Retry-After %s without a permanent pause",async header=>{
    const state=provider(0,new Response("rate limited",{status:429,headers:{"Retry-After":header}}));
    await (await state.create()).fetch("https://rpc.example/path");
    expect(state.row.cooldown_until).toBe(String(asOf+86_400_000));
    await expect((await state.create()).fetch("https://rpc.example/path")).rejects.toMatchObject({retryAt:asOf+86_400_000});
    expect(state.fetchImpl).toHaveBeenCalledOnce();expect(state.row.requests_used).toBe(3);
  });
  it("permits one budgeted retry after fallback expiry and persists another delay on repeated 429",async()=>{
    const state=provider(0,new Response("rate limited",{status:429}));
    await (await state.create()).fetch("https://rpc.example/path");
    state.fetchImpl.mockResolvedValue(new Response("rate limited",{status:429}));
    const at=160_000;
    const retry=await createPostgresServiceFactAdapters({runtime:state.runtime,generationId,maximumProfiles:10,
      now:()=>at,sources:{...sources,fetchImpl:state.fetchImpl}});
    await retry.fetch("https://rpc.example/path");
    expect(state.row.cooldown_until).toBe("220000");expect(state.fetchImpl).toHaveBeenCalledTimes(2);
    expect(state.row.maximum_requests).toBe(5);expect(state.row.maximum_concurrency).toBe(2);
    await expect(retry.fetch("https://rpc.example/path")).rejects.toMatchObject({retryAt:220000});
    expect(state.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("never automatically clears a historical operator-owned pause",async()=>{
    const state=provider("9223372036854775807");
    await expect((await state.create()).fetch("https://rpc.example/path")).rejects.toMatchObject({retryAt:null});
    expect(state.row.cooldown_until).toBe("9223372036854775807");expect(state.fetchImpl).not.toHaveBeenCalled();
    expect(state.queries.some(sql=>sql.includes("service-provider-cooldown")||sql.includes("service-provider-budget-debit"))).toBe(false);
  });
  it.each([undefined,null,"unknown"])("does not coerce unknown migrated cooldown %j to zero",async cooldown=>{
    const state=provider();state.row.cooldown_until=cooldown;
    await expect((await state.create()).fetch("https://rpc.example/path")).rejects.toMatchObject({retryAt:null});
    expect(state.fetchImpl).not.toHaveBeenCalled();expect(state.row.requests_used).toBe(2);
  });
});

describe("HTTP 200 JSON-RPC durable rate cooldown", () => {
  function rpcState(message: string, retryAfter?: string) {
    let cooldown = "0", used = 0;
    const state = setup((sql,args) => {
      if (sql.includes("service-provider-budget-lock")) return [{ provider_id: "provider", window_started_at: 90_000,
        window_ms: 60_000, maximum_requests: 5, requests_used: used, maximum_concurrency: 2, active_leases: 0, cooldown_until: cooldown }];
      if (sql.includes("service-provider-budget-debit")) { used = Number(args[3]); return [{ provider_id: "provider" }]; }
      if (sql.includes("service-provider-cooldown")) { cooldown = String(args[2]); return [{ cooldown_until: cooldown }]; }
      return [];
    },vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
      error: { code: -32005, message } }), { status: 200, headers: retryAfter ? { "Retry-After": retryAfter } : {} })));
    return { ...state, cooldown: () => cooldown, used: () => used };
  }
  const init = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [] }) };
  it.each([[undefined,"160000"],["999999999999999999999999","86500000"]])("persists finite rate cooldown with Retry-After %s", async (header,until) => {
    const state = rpcState("request rate limit exceeded",header), ports = await state.create();
    const response = await ports.fetch("https://rpc.example/private",init);
    expect(response.status).toBe(200); expect((await response.json()).error.code).toBe(-32005);
    expect(state.cooldown()).toBe(until); expect(state.used()).toBe(1);
    await expect((await state.create()).fetch("https://rpc.example/private",init)).rejects.toBeInstanceOf(PostgresProviderBudgetError);
    expect(state.fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(["query returned more than 10000 results", "limit exceeded", "provider-specific rejection"])("does not persist a rate pause for %s", async message => {
    const state = rpcState(message), ports = await state.create();
    const response = await ports.fetch("https://rpc.example/private",init);
    expect((await response.json()).error.message).toBe(message);
    expect(state.cooldown()).toBe("0"); expect(state.used()).toBe(1);
    expect(state.queries.some(sql => sql.includes("service-provider-cooldown"))).toBe(false);
  });
});

describe("source exact-envelope consumption", () => {
  it.each(["current", "missing-version", "old-version", "changed-target"])("checks independently attested current target: %s", async kind => {
    const { sourceRpcFixture } = await import("./postgres-source-fact-fixture.js");
    const { forwardTargetSubjectKey } = await import("../../../packages/domain/src/forward-target-authorization.js");
    const rpc = await sourceRpcFixture(), profile = rpc.profile;
    const sample = { sampleId: "sample", executionFingerprint: "a".repeat(64), entityId: profile.fact.entityId,
      chain: "solana" as const, tokenAddress: "TokenCase", boughtAt: 90_000 };
    const subject = postgresServiceFactFingerprint([sample.sampleId, sample.executionFingerprint]);
    const source = { sampleId: sample.sampleId, executionFingerprint: sample.executionFingerprint,
      target: { ...profile.fact }, canonical: "confirmed_live_execution", targetVersionId: profile.versionId };
    if (kind === "missing-version") delete (source as any).targetVersionId;
    if (kind === "old-version") source.targetVersionId = "old-version";
    if (kind === "changed-target") source.target.associationSource = "different-source";
    const state = setup((sql, args) => {
      if (sql.includes("service-fact-safety-sample")) return [{ ownership_evidence_ref: profile.fact.ownershipEvidenceRef }];
      if (sql.includes("service-fact-inputs")) {
        const proof = args[1] === "source" ? source : { sampleId: sample.sampleId, executionFingerprint: sample.executionFingerprint,
          ...(args[1] === "risk" ? { verdict: "validated" } : { independenceKey: "independent-entity" }) };
        return [fact(String(args[1]), proof, { subject_key: subject })];
      }
      if (sql.includes("service-fact-profile-cohort")) return [{ entity_id: profile.fact.entityId,
        wallet_family: "solana", subject_key: forwardTargetSubjectKey(profile.fact),
        proof_scope: "legacy_registry_linkage", imported_at: 90_000, observed_at: 95_000, import_revoked_at: null,
        enabled: true, suspended: false, profile_payload: JSON.stringify(profile), channel_payload: JSON.stringify(profile.fact),
        profile_known_at: 95_000, channel_known_at: 95_000, channel_version_id: profile.versionId,
        profile_version_id: "profile-version", import_id: "registry-import", owner_entity_id: profile.fact.entityId, conflict_at: null }];
      return [];
    });
    const ports = await state.create();
    expect(await ports.facts.safety({ generationId, asOf, limit: 10, signal, sample }))
      .toMatchObject({ status: kind === "current" ? "available" : "deferred" });
  });
});

describe("execution envelope budget contract", () => {
  const publisherBytes = 2 * 1024 * 1024;
  async function executionState(padding: number, overrides: Record<string, unknown> = {}, duplicate = false) {
    const { sourceRpcFixture } = await import("./postgres-source-fact-fixture.js");
    const { forwardTargetSubjectKey } = await import("../../../packages/domain/src/forward-target-authorization.js");
    const rpc = await sourceRpcFixture(), profile = rpc.profile;
    const payload = { generationId, collectorId: "solana", chainFamily: "solana" as const, profile,
      event: { eventId: "event", chain: "solana", walletAddress: profile.wallet.address, sourceReference: rpc.request.execution.sourceReference,
        tokenAddress: rpc.request.validation.claims.purchase.tokenAddress, side: "buy", occurredAt: 90_000 } };
    const subject = postgresServiceFactFingerprint([payload.event.chain,payload.event.walletAddress,
      payload.event.sourceReference,payload.event.tokenAddress]);
    const value = { canonical: "confirmed_execution", sourceReference: payload.event.sourceReference,
      purchase: rpc.request.validation.claims.purchase,
      executionEnvelope: { candidate: rpc.request.execution, validation: rpc.request.validation, evidence: "x".repeat(padding) } };
    const row = fact("execution", value, { subject_key: subject, validation_ref: value.purchase.executionEvidenceRef, ...overrides });
    const state = setup(sql => {
      if (sql.includes("service-fact-inputs")) return duplicate ? [row, { ...row, fact_id: "second" }] : [row];
      if (sql.includes("service-fact-profile-cohort")) return [{ entity_id: profile.fact.entityId,
        wallet_family: "solana", subject_key: forwardTargetSubjectKey(profile.fact),
        proof_scope: "legacy_registry_linkage", imported_at: 90_000, observed_at: 95_000, import_revoked_at: null,
        enabled: true, suspended: false, profile_payload: JSON.stringify(profile), channel_payload: JSON.stringify(profile.fact),
        profile_known_at: 95_000, channel_known_at: 95_000, channel_version_id: profile.versionId,
        profile_version_id: "profile-version", import_id: "registry-import", owner_entity_id: profile.fact.entityId, conflict_at: null }];
      return [];
    });
    return { ...state, ctx: { generationId, asOf, limit: 1, signal, payload } as any };
  }
  const executionBudget = { maximumExecutionFactPayloadBytes: publisherBytes, maximumFactResultBytes: publisherBytes };
  it("reads a publisher-sized immutable envelope without raising other fact limits", async () => {
    const state = await executionState(300_000);
    const ports = await state.create(executionBudget);
    expect(await ports.facts.purchase(state.ctx)).toMatchObject({ status: "verified" });
    const query = state.query.mock.calls.find(([sql]) => sql.includes("service-fact-inputs"));
    expect(query?.[0]).toContain("payload_bytes");
    expect(query?.[0]).toContain("result_bytes");
    expect(query?.[1]).toEqual([generationId,"execution",expect.any(String),asOf,2,publisherBytes,publisherBytes]);
  });
  it("does not silently widen an unconfigured execution allowance", async () => {
    const state = await executionState(30_000), ports = await state.create();
    expect(await ports.facts.purchase(state.ctx)).toEqual({ status: "deferred", reasonCode: "wallet_execution_fact_payload_budget_exceeded" });
  });
  it("returns an explicit per-fact rejection above the approved publisher ceiling", async () => {
    const state = await executionState(publisherBytes), ports = await state.create(executionBudget);
    expect(await ports.facts.purchase(state.ctx)).toEqual({ status: "deferred", reasonCode: "wallet_execution_fact_payload_budget_exceeded" });
  });
  it("bounds total rows before parsing even when individual envelopes fit", async () => {
    const state = await executionState(30_000, {}, true);
    const ports = await state.create({ ...executionBudget, maximumFactResultBytes: 50_000 });
    expect(await ports.facts.purchase(state.ctx)).toEqual({ status: "deferred", reasonCode: "wallet_execution_fact_result_budget_exceeded" });
  });
  it("retains expired-proof rejection with the larger explicit envelope allowance", async () => {
    const state = await executionState(300_000, { expires_at: asOf }), ports = await state.create(executionBudget);
    expect(await ports.facts.purchase(state.ctx)).toEqual({ status: "deferred", reasonCode: "wallet_canonical_execution_proof_unavailable" });
  });
  it("does not expand the price fact allowance", async () => {
    const state = setup(priceHandler([fact("price", { type: "peak", peak, envelope: "x".repeat(30_000) })]));
    const ports = await state.create(executionBudget);
    expect(await ports.facts.prices({ generationId, asOf, limit: 1, signal })).toMatchObject({ status: "deferred" });
  });
  it("counts escaped JSON and row metadata against the total result budget", async () => {
    const state = await executionState(0, { diagnostic: "\\".repeat(30_000) });
    const ports = await state.create({ ...executionBudget, maximumFactResultBytes: 50_000 });
    expect(await ports.facts.purchase(state.ctx)).toEqual({ status: "deferred", reasonCode: "wallet_execution_fact_result_budget_exceeded" });
  });
});

describe("closed provider budget rejection conditions", () => {
  it.each([
    [{cooldown_until:125_000},"cooldown"],
    [{cooldown_until:"9223372036854775807"},"paused"],
    [{cooldown_until:null},"invalid_cooldown"],
    [{window_started_at:100_001},"clock_regressed"],
    [{active_leases:1},"concurrency"],
    [{requests_used:60},"window"],
  ])("retains exact local rejection %s without debit or cooldown writes",async(override,budgetReason)=>{
    const state=setup(sql=>sql.includes("service-provider-budget-lock")?[{provider_id:"provider",window_started_at:90_000,
      window_ms:60_000,maximum_requests:60,requests_used:1,maximum_concurrency:1,active_leases:0,cooldown_until:0,...override}]:[]);
    await expect((await state.create()).fetch("https://rpc.example/private")).rejects.toMatchObject({name:"PostgresProviderBudgetError",budgetReason});
    expect(state.fetchImpl).not.toHaveBeenCalled();
    expect(state.queries.some(sql=>sql.includes("service-provider-budget-debit")||sql.includes("service-provider-cooldown"))).toBe(false);
  });
  it("identifies missing approved contract without fabricating cooldown",async()=>{
    const state=setup();await expect((await state.create()).fetch("https://rpc.example/private")).rejects.toMatchObject({budgetReason:"contract_unavailable"});
  });
});

describe("bounded collector RPC observation",()=>{
  function observed(response: Response) {
    const onSourceRpcDiagnostic=vi.fn();
    const state=setup(sql=>sql.includes("service-provider-budget-lock")?[{provider_id:"provider",window_started_at:90_000,
      window_ms:60_000,maximum_requests:60,requests_used:1,maximum_concurrency:1,active_leases:0,cooldown_until:0}]
      :sql.includes("service-provider-budget-debit")?[{provider_id:"provider"}]
      :sql.includes("service-provider-cooldown")?[{cooldown_until:160_000}]:[],vi.fn<typeof fetch>().mockResolvedValue(response));
    const create=()=>createPostgresServiceFactAdapters({runtime:state.runtime,generationId,maximumProfiles:10,now:()=>asOf,
      sources:{...sources,fetchImpl:state.fetchImpl},sourceRpcOrigin:"https://rpc.example",onSourceRpcDiagnostic});
    return {...state,create,onSourceRpcDiagnostic};
  }
  it.each([429,200])("observes actual serialized collector method and transport at HTTP %s",async status=>{
    const state=observed(new Response(JSON.stringify({jsonrpc:"2.0",id:1,error:{code:-32005,message:"Too many requests: private"}}),{status}));
    const ports=await state.create();await ports.fetch("https://rpc.example/private?token=secret",{method:"POST",
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSignaturesForAddress",params:["secret-signature"]})});
    expect(state.onSourceRpcDiagnostic).toHaveBeenCalledWith(expect.objectContaining({method:"getSignaturesForAddress",
      transport:status===429?"http":"rpc",subcategory:"rate_limit",reasonCode:"execution_rpc_rate_limited"}));
    expect(JSON.stringify(state.onSourceRpcDiagnostic.mock.calls)).not.toMatch(/secret|private|https:|params/);
    expect(state.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown","oversized","other-origin"])("does not observe %s request material",async kind=>{
    const state=observed(new Response("limited",{status:429})),ports=await state.create();
    await ports.fetch(kind==="other-origin"?"https://other.example/private":"https://rpc.example/private",{body:JSON.stringify({
      method:kind==="unknown"?"private-method":"getTransaction",params:[kind==="oversized"?"x".repeat(2000):"private"]})});
    expect(state.onSourceRpcDiagnostic).not.toHaveBeenCalled();
  });
  it("reports a closed unknown transport failure and ignores observer exceptions",async()=>{
    const state=observed(new Response("unused")),ports=await state.create();
    state.fetchImpl.mockRejectedValueOnce(new Error("secret https://private"));
    state.onSourceRpcDiagnostic.mockImplementation(()=>{throw new Error("sink failed");});
    await expect(ports.fetch("https://rpc.example/private",{body:JSON.stringify({method:"getTransaction"})})).rejects.toThrow("secret");
    expect(state.onSourceRpcDiagnostic).toHaveBeenCalledWith(expect.objectContaining({method:"getTransaction",subcategory:"unknown_failure",transport:"unknown"}));
    expect(JSON.stringify(state.onSourceRpcDiagnostic.mock.calls)).not.toContain("secret");
    expect(state.queries.some(sql=>sql.includes("service-provider-release"))).toBe(true);
  });
});

it("does not invoke a request body's toJSON for diagnostics",async()=>{
  const toJSON=vi.fn(()=>({method:"getTransaction",params:["private"]})),onSourceRpcDiagnostic=vi.fn();
  const state=setup(sql=>sql.includes("service-provider-budget-lock")?[{provider_id:"provider",window_started_at:90_000,
    window_ms:60_000,maximum_requests:60,requests_used:1,maximum_concurrency:1,active_leases:0,cooldown_until:0}]
    :sql.includes("service-provider-budget-debit")?[{provider_id:"provider"}]
    :sql.includes("service-provider-cooldown")?[{cooldown_until:160_000}]:[],vi.fn<typeof fetch>().mockResolvedValue(new Response("limited",{status:429})));
  const ports=await createPostgresServiceFactAdapters({runtime:state.runtime,generationId,maximumProfiles:10,now:()=>asOf,
    sources:{...sources,fetchImpl:state.fetchImpl},sourceRpcOrigin:"https://rpc.example",onSourceRpcDiagnostic});
  await ports.fetch("https://rpc.example/private",{body:{toJSON} as unknown as BodyInit});
  expect(toJSON).not.toHaveBeenCalled();expect(onSourceRpcDiagnostic).not.toHaveBeenCalled();
});

// These are synthetic durable attestation rows, not production source approvals.
function reportedDurablePayload() {
  const evidence = { reportedMarketCap: 100000, reportedFdv: 900000, reportedUpdatedAt: 95 };
  const mapping = { chain: 'solana' as const, tokenAddress: '1'.repeat(31)+'2', poolAddress: '1'.repeat(31)+'3',
    tokenSide: 'base' as const, network: 'solana', evidenceRef: 'synthetic-map', knownAt: 0 };
  const quote = '1'.repeat(31)+'4';
  const approval = attachDedicatedReportedApproval({ approvalRef: 'synthetic-authorization', actorId: 'synthetic-validator-actor',
    mappingApprovalRef: 'synthetic-map-approval', mappingFingerprint: postgresServiceFactFingerprint(mapping), quoteAddress: quote,
    generationId, validatorId: 'independent-validator', keyId: 'reported-key', providerId: 'rpc-provider',
    sourceApprovalRef: 'approved:reported-source', sourceProofKind: 'approved_reported_market_cap_v1', quality: 'reported',
    conflictState: 'none_observed', validFrom: 0, validUntil: 110000, revokedAt: null }, mapping);
  const sourceProof = { mapping, reportedMarketCap: { marketCapUsd: '100000', fdvUsd: '900000', reportedAt: 95000,
    quoteAddress: quote, quality: 'reported', independence: 'unverified', conflictState: 'unassessed',
    sourceProtocol: 'ave_token_market_cap_v1', sourceEvidence: evidence }, rawEvidence: {
    providerId: 'rpc-provider', protocol: 'ave_token_market_cap_v1', response: evidence, approval } };
  return { type: 'market', market: { generationId, chain: 'solana', tokenAddress: mapping.tokenAddress, sourceEventId: 'reported-event',
    marketCapUsd: '100000', fdvUsd: '900000', occurredAt: 95000, now: 97000, verification: 'validated', evidenceRef: 'source:actual-candle',
    quality: 'reported', independence: 'unverified', conflictState: 'none_observed', source: { providerId: 'rpc-provider',
      approvalRef: 'approved:reported-source', protocol: 'ave_token_market_cap_v1', reportedAt: 95000, quoteAddress: quote } },
    validation: { claims: { generationId, providerId: 'rpc-provider', validatorId: 'independent-validator', keyId: 'reported-key',
      mappingApprovalRef: approval.mappingApprovalRef, validationRef: 'validation:1', checkedAt: 97000, expiresAt: 110000, sourceApprovalRef: 'approved:reported-source',
      sourceBasis: { kind: 'approved_reported_market_cap_v1', providerId: 'rpc-provider', contentFingerprint: postgresServiceFactFingerprint(sourceProof) } }, sourceProof } };
}
describe('durable reported-cap consumer contract', () => {
  it('preserves source/time/reported/FDV audit under the existing attestation and shared lease', async () => {
    const payload = reportedDurablePayload();
    const f = setup(priceHandler([fact('price', payload)])), ports = await f.create();
    const batch = await ports.facts.prices({ generationId, asOf, limit: 1, signal });
    expect(batch.status).toBe('available');
    if (batch.status !== 'available') throw new Error('Expected isolated report consumption');
    expect(batch.peaks).toEqual([]);
    expect(batch.markets).toEqual([{ ...payload.market, now: asOf }]);
    await batch.lease.complete({ query: f.query }, asOf);
    expect(f.queries.some(sql => sql.includes('INSERT INTO wallet_service_price_consumption'))).toBe(true);
  });
  it.each(['conflict', 'upgraded-quality', 'stripped-quality', 'wrong-source', 'wrong-time', 'fdv-substitution', 'revoked', 'candle-authority', 'raw-drift'])('defers %s without ACK', async kind => {
    const payload = reportedDurablePayload();
    if (kind === 'conflict') payload.market.conflictState = 'conflict';
    if (kind === 'upgraded-quality') payload.market.quality = 'independently_verified';
    if (kind === 'stripped-quality') delete (payload.market as { quality?: string }).quality;
    if (kind === 'wrong-source') payload.market.source.providerId = 'other';
    if (kind === 'wrong-time') payload.market.occurredAt = 96000;
    if (kind === 'fdv-substitution') payload.market.marketCapUsd = payload.market.fdvUsd;
    if (kind === 'revoked') Object.assign(payload.validation.sourceProof.rawEvidence.approval, { revokedAt: 99000 });
    if (kind === 'candle-authority') payload.validation.claims.sourceBasis.kind = 'independent_gecko_ohlcv_replay_v1';
    if (kind === 'raw-drift') payload.validation.sourceProof.rawEvidence.response = { ...payload.validation.sourceProof.rawEvidence.response, reportedMarketCap: 1 };
    // Recompute outer fixture hashes to exercise semantic checks, not merely fingerprint rejection.
    payload.validation.claims.sourceBasis.contentFingerprint = postgresServiceFactFingerprint(payload.validation.sourceProof);
    const f = setup(priceHandler([fact('price', payload)])), ports = await f.create();
    expect(await ports.facts.prices({ generationId, asOf, limit: 1, signal })).toMatchObject({ status: 'deferred' });
    expect(f.queries.some(sql => sql.includes('INSERT INTO wallet_service_price_consumption'))).toBe(false);
  });
});

describe('reported source approval is checked on durable read and in the ACK transaction', () => {
  it.each(['revoked','missing','scope','fingerprint'])('defers %s dedicated ledger without returning consumable prices', async fault => {
    const payload = reportedDurablePayload(), base = priceHandler([fact('price',payload)]);
    const f = setup((sql,args) => {
      if (!sql.includes('reported-approval-transaction')) return base(sql);
      if (fault === 'missing') return [];
      return [{ ...dedicatedReportedLedgerRow(payload.validation.sourceProof.rawEvidence.approval),
        ...(fault === 'revoked' ? { revoked_at: asOf } : fault === 'scope' ? { proof_scope: 'provider_contract' } : { source_fingerprint: '0'.repeat(64) }) }];
    });
    const ports = await f.create(); expect(await ports.facts.prices({ generationId, asOf, limit: 1, signal })).toMatchObject({ status: 'deferred' });
    expect(f.queries.some(sql => sql.includes('INSERT INTO wallet_service_price_consumption'))).toBe(false);
  });
  it('refuses a revocation between read and consumption even with a live signature TTL', async () => {
    const payload = reportedDurablePayload(), base = priceHandler([fact('price',payload)]); let revoked = false;
    const f = setup((sql,args) => sql.includes('reported-approval-transaction') && revoked
      ? [{ ...dedicatedReportedLedgerRow(payload.validation.sourceProof.rawEvidence.approval), revoked_at: asOf }]
      : base(sql));
    const ports = await f.create(), batch = await ports.facts.prices({ generationId, asOf, limit: 1, signal });
    if (batch.status !== 'available') throw Error('Expected synthetic available batch');
    revoked = true;
    await expect(batch.lease.assertOwned({ query: f.query },asOf)).rejects.toThrow();
    await expect(batch.lease.complete({ query: f.query },asOf)).rejects.toThrow();
    expect(f.queries.some(sql => sql.includes('INSERT INTO wallet_service_price_consumption'))).toBe(false);
  });
  it('refuses an expired dedicated document even when generic attestation TTL remains live', async () => {
    const payload = reportedDurablePayload(), raw = payload.validation.sourceProof.rawEvidence;
    raw.approval = attachDedicatedReportedApproval({ ...raw.approval, validUntil: asOf },payload.validation.sourceProof.mapping);
    payload.validation.claims.sourceBasis.contentFingerprint = postgresServiceFactFingerprint(payload.validation.sourceProof);
    const f = setup(priceHandler([fact('price',payload)])), ports = await f.create();
    expect(await ports.facts.prices({ generationId, asOf, limit: 1, signal })).toMatchObject({ status: 'deferred' });
    expect(f.queries.some(sql => sql.includes('INSERT INTO wallet_service_price_consumption'))).toBe(false);
  });});


describe("native configured RPC attribution",()=>{
  async function native(chain:"solana"|"base",status:number,cooldown=0,contexts?:unknown) {
    const observer=vi.fn(),state=setup(sql=>sql.includes("service-provider-budget-lock")?[{provider_id:"provider",window_started_at:90000,
      window_ms:60000,maximum_requests:60,requests_used:1,maximum_concurrency:1,active_leases:0,cooldown_until:cooldown}]
      :sql.includes("service-provider-budget-debit")?[{provider_id:"provider"}]
      :sql.includes("service-provider-cooldown")?[{cooldown_until:160000}]:[],
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({jsonrpc:"2.0",error:{code:-32602,message:"private"}}),{status})));
    const ports=await createPostgresServiceFactAdapters({runtime:state.runtime,generationId,maximumProfiles:10,now:()=>asOf,
      sources:{...sources,fetchImpl:state.fetchImpl},sourceRpcContexts:(contexts??[{chain,providerId:"provider",endpoint:"https://rpc.example/native",purpose:"source"}]) as any,
      onSourceRpcDiagnostic:observer});
    return {...state,ports,observer,request:()=>ports.fetch("https://rpc.example/native",{body:JSON.stringify({method:chain==="base"?"eth_getLogs":"getTransaction",params:["private"]})})};
  }
  it.each(["solana","base"] as const)("attributes %s HTTP and RPC failures without changing debit/release",async chain=>{
    for(const status of [429,401,403,200]) {
      const f=await native(chain,status);expect((await f.request()).status).toBe(status);
      expect(f.observer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({chain,providerId:"provider",purpose:"source",httpStatus:status,
        code:status===200?-32602:null,transport:status===200?"rpc":"http",
        subcategory:status===429?"rate_limit":status===401?"authentication_required":status===403?"permission_denied":"invalid_params"}));
      expect(f.queries.filter(sql=>sql.includes("service-provider-budget-debit"))).toHaveLength(1);
      expect(f.queries.filter(sql=>sql.includes("service-provider-release"))).toHaveLength(1);
      expect(f.queries.filter(sql=>sql.includes("service-provider-cooldown"))).toHaveLength(status===429?1:0);
      expect(JSON.stringify(f.observer.mock.calls)).not.toMatch(/private|https:|"params"\s*:/);
    }
  });
  it.each(["solana","base"] as const)("observes %s local cooldown without fetch/status/debit",async chain=>{
    const f=await native(chain,429,160000);await expect(f.request()).rejects.toMatchObject({retryAt:160000,budgetReason:"cooldown"});
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({chain,providerId:"provider",retryAt:160000,budgetReason:"cooldown",transport:"local"}));
    expect(f.observer.mock.calls[0]?.[0]).not.toHaveProperty("httpStatus");expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.queries.some(sql=>sql.includes("service-provider-budget-debit")||sql.includes("service-provider-release")||sql.includes("service-provider-cooldown"))).toBe(false);
  });
  it("rejects ambiguous, provider-mismatched, accessor and proxy context without invoking hooks",async()=>{
    const good={chain:"base",providerId:"provider",endpoint:"https://rpc.example/native",purpose:"source"},getter=vi.fn(()=>"base"),trap=vi.fn();
    const accessor={...good};Object.defineProperty(accessor,"chain",{get:getter});
    for(const contexts of [[good,good],[{...good,providerId:"other"}],[accessor],[new Proxy(good,{get:trap,getOwnPropertyDescriptor:trap})]]) {
      const f=await native("base",429,0,contexts);await f.request();expect(f.observer).not.toHaveBeenCalled();expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    }
    expect(getter).not.toHaveBeenCalled();expect(trap).not.toHaveBeenCalled();
  });
  it("isolates native observer exceptions on successful HTTP transport",async()=>{
    const f=await native("base",429);f.observer.mockImplementation(()=>{throw new Error("observer");});
    expect((await f.request()).status).toBe(429);expect(f.queries.some(sql=>sql.includes("service-provider-release"))).toBe(true);
  });
});

it("preserves a proxied budget rejection without invoking prototype hooks", async () => {
  const trap = vi.fn(() => { throw new Error("Prototype hook must not execute"); });
  const original = new Proxy(new Error("opaque rejection"), { getPrototypeOf: trap });
  const observer = vi.fn(), state = setup(() => { throw original; });
  const ports = await createPostgresServiceFactAdapters({ runtime: state.runtime, generationId,
    maximumProfiles: 10, now: () => asOf, sources: { ...sources, fetchImpl: state.fetchImpl },
    sourceRpcOrigin: "https://rpc.example", onSourceRpcDiagnostic: observer });
  let rejected: unknown;
  try {
    await ports.fetch("https://rpc.example/native", { body: JSON.stringify({ method: "getTransaction" }) });
  } catch (error) { rejected = error; }
  expect(Object.is(rejected, original)).toBe(true);
  expect(trap).not.toHaveBeenCalled();
  expect(observer).not.toHaveBeenCalled();
  expect(state.fetchImpl).not.toHaveBeenCalled();
  expect(state.queries.some(sql => sql.includes("service-provider-budget-debit")
    || sql.includes("service-provider-cooldown") || sql.includes("service-provider-release"))).toBe(false);
});
