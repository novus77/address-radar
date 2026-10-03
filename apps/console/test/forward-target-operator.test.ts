import { describe, expect, it } from "vitest";
import { startAddressRadarConsole } from "../src/server.js";

describe("forward target operator interface", () => {
  it("serves a separate operator page without enabling business controls", async () => {
    const application = {
      handle: () => ({ status: 404, body: { error: "fixture_only" } }),
      subscribe: () => () => {}, close: () => {},
    } as unknown as Parameters<typeof startAddressRadarConsole>[0]["application"];
    const server = await startAddressRadarConsole({ application, host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.url}/forward-targets`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(await response.text()).toContain('src="/forward-targets.js"');
      const controls = await fetch(`${server.url}/api/v2/forward-targets/registry?channel=fomo`);
      expect(controls.status).toBe(503);
    } finally { await server.close(); }
  });
});

import { createForwardTargetOperatorClient } from "../public/forward-targets.js";
const target = { entityId: "operator-entity", channel: "fomo" as const, subjectId: "stable-account", walletFamily: null };
const success = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
describe("operator command client", () => {
  it("requires a memory-only credential before any request", async () => {
    let called = false;
    const client = createForwardTargetOperatorClient({ fetch: async () => { called = true; return success({}); } });
    await expect(client.state(target)).rejects.toThrow("operator_token_required"); expect(called).toBe(false);
  });
  it("sends only identity keys when hydrating and uses authenticated read routes", async () => {
    const requests: { url: string; options: RequestInit | undefined }[] = [];
    const client = createForwardTargetOperatorClient({ fetch: async (url, options) => { requests.push({ url: String(url), options }); return success({ state: {} }); } });
    client.setToken("operator-token"); await client.hydrate(target); await client.state(target);
    expect(JSON.parse(String(requests[0]!.options!.body))).toEqual(target);
    expect(requests[0]!.options!.headers).toMatchObject({ authorization: "Bearer operator-token" });
    expect(requests[0]!.options!.credentials).toBe("omit");
    expect(requests[1]!.url).toContain("/state?"); expect(requests[1]!.url).not.toContain("operator-token");
  });
  it("reuses the immutable command ID after an uncertain transport outcome", async () => {
    const bodies: Record<string, unknown>[] = []; let identifiers = 0;
    const client = createForwardTargetOperatorClient({ id: () => `operator-command-${++identifiers}`, fetch: async (_url, options) => {
      bodies.push(JSON.parse(String(options!.body))); if (bodies.length === 1) throw new Error("connection_lost"); return success({ writeResult: "duplicate" });
    } });
    client.setToken("operator-token"); const command = { entityId: target.entityId, action: "grant" as const, basisRef: "approval-ref" };
    await expect(client.authorize(command)).rejects.toThrow("request_outcome_unknown"); await client.authorize(command);
    expect(bodies[0]).toEqual(bodies[1]); expect(identifiers).toBe(1);
    expect(Object.keys(bodies[0]!)).toEqual(["authorizationId", "entityId", "action", "basisRef"]);
  });
  it("reuses a command after a server failure but allocates a new ID after acknowledgement", async () => {
    const ids: unknown[] = []; let identifiers = 0;
    const client = createForwardTargetOperatorClient({ id: () => `operator-command-${++identifiers}`, fetch: async (_url, options) => {
      ids.push(JSON.parse(String(options!.body)).authorizationId);
      return ids.length === 1 ? new Response(JSON.stringify({ error: "forward_target_control_failed" }), { status: 500 }) : success({ writeResult: "inserted" });
    } });
    client.setToken("operator-token"); const command = { entityId: target.entityId, action: "revoke" as const, basisRef: "revoke-ref" };
    await expect(client.authorize(command)).rejects.toThrow("forward_target_control_failed"); await client.authorize(command); await client.authorize(command);
    expect(ids).toEqual(["operator-command-1", "operator-command-1", "operator-command-2"]);
  });
  it("reads bounded cursor pages without claiming a total", async () => {
    let requested = "";
    const client = createForwardTargetOperatorClient({ fetch: async url => { requested = String(url); return success({ scanned: 1, monitored: [], nextCursor: null }); } });
    client.setToken("operator-token"); await client.registry("wallet", { entityId: "entity+one", subjectKey: '["wallet","evm","address"]' });
    const url = new URL(requested, "http://127.0.0.1"); expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("afterEntityId")).toBe("entity+one"); expect(url.searchParams.get("afterSubjectKey")).toBe('["wallet","evm","address"]');
  });
  it("clears the operator credential explicitly", async () => {
    let requests = 0;
    const client = createForwardTargetOperatorClient({ fetch: async () => { requests += 1; return success({}); } });
    client.setToken("operator-token"); await client.state(target); client.setToken("");
    await expect(client.state(target)).rejects.toThrow("operator_token_required"); expect(requests).toBe(1);
  });
  it("rejects incompatible identity keys before requesting a source write", () => {
    const client = createForwardTargetOperatorClient({ fetch: async () => { throw new Error("unexpected_request"); } });
    expect(() => client.hydrate({ ...target, walletFamily: "evm" })).toThrow("invalid_target_family");
  });
});

import * as operatorModule from "../public/forward-targets.js";
describe("operator request revision fence", () => {
  it("provides a target revision fence for outstanding responses", () => {
    expect(typeof (operatorModule as unknown as Record<string, unknown>).createOperatorRequestFence).toBe("function");
  });
  it("discards an old target response after selection or session changes", async () => {
    const fence = operatorModule.createOperatorRequestFence();
    const oldRevision = fence.capture(); let resolveResponse!: (value: string) => void;
    const response = new Promise<string>(resolve => { resolveResponse = resolve; });
    let rendered = "new-target";
    const pending = response.then(value => { if (fence.isCurrent(oldRevision)) rendered = value; });
    fence.invalidate(); resolveResponse("old-target"); await pending;
    expect(rendered).toBe("new-target"); expect(fence.isCurrent(fence.capture())).toBe(true);
  });
  it("fences registry responses independently of target selection", () => {
    const targetFence = operatorModule.createOperatorRequestFence(), registryFence = operatorModule.createOperatorRequestFence();
    const targetRevision = targetFence.capture(), registryRevision = registryFence.capture();
    registryFence.invalidate(); expect(registryFence.isCurrent(registryRevision)).toBe(false);
    expect(targetFence.isCurrent(targetRevision)).toBe(true);
  });
});
