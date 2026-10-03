import { afterEach, expect, it } from "vitest";
import { startAddressRadarConsole } from "../src/server.js";
import type { ForwardTargetConsoleExtension } from "../src/forward-target-application.js";
const token = "forward-control-test-token-at-least-32-characters";
const principal = { actorId: "configured-operator",authorizationEvidenceRef: "server:validated-token",permissions: ["target_registry_write","radar_authorization_write"] as const };
const application = () => ({ handle: () => ({ status: 200,body: { legacy: true } }),subscribe: () => () => {},close: () => {} });
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
const extension: ForwardTargetConsoleExtension = { handle: async input => ({ status: 200,body: { actorId: input.principal.actorId } }) };
it("requires authentication when forward controls are installed", async () => {
  await expect(startAddressRadarConsole({ application: application(),port: 0,forwardTargetApplication: extension,forwardTargetPrincipal: principal })).rejects.toThrow("authenticated operator");
});
it("requires a server-configured principal rather than only a token", async () => {
  await expect(startAddressRadarConsole({ application: application(),port: 0,developerToken: token,forwardTargetApplication: extension })).rejects.toThrow("authenticated operator");
});
it("rejects missing and incorrect bearer tokens before calling the extension", async () => {
  let calls = 0;
  const server = await startAddressRadarConsole({ application: application(),port: 0,developerToken: token,forwardTargetPrincipal: principal,
    forwardTargetApplication: { handle: async () => { calls++; return { status: 200,body: {} }; } } }); servers.push(server);
  expect((await fetch(`${server.url}/api/v2/forward-targets/state`)).status).toBe(401);
  expect((await fetch(`${server.url}/api/v2/forward-targets/state`,{ headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  expect(calls).toBe(0);
});
it("derives the actor from authenticated server context, not JSON", async () => {
  const server = await startAddressRadarConsole({ application: application(),port: 0,developerToken: token,forwardTargetApplication: extension,forwardTargetPrincipal: principal }); servers.push(server);
  const response = await fetch(`${server.url}/api/v2/forward-targets/hydrate`,{ method: "POST",headers: { Authorization: `Bearer ${token}`,"Content-Type": "application/json" },body: JSON.stringify({ actorId: "forged" }) });
  expect(await response.json()).toEqual({ actorId: "configured-operator" });
});
it("leaves legacy loopback behavior unchanged but reserves disabled forward routes", async () => {
  const server = await startAddressRadarConsole({ application: application(),port: 0 }); servers.push(server);
  expect((await fetch(`${server.url}/api/v1/traders`)).status).toBe(200);
  const response = await fetch(`${server.url}/api/v2/forward-targets/hydrate`,{ method: "POST" });
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "forward_target_controls_disabled" });
});
it("does not expose extension failures or credentials in HTTP responses", async () => {
  const server = await startAddressRadarConsole({ application: application(),port: 0,developerToken: token,forwardTargetPrincipal: principal,
    forwardTargetApplication: { handle: async () => { throw new Error("postgresql://secret-connection"); } } }); servers.push(server);
  const response = await fetch(`${server.url}/api/v2/forward-targets/state`,{ headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "forward_target_control_failed" });
});
