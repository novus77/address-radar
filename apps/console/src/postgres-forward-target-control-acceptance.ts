import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyForwardTargetSnapshotReader, migrateAddressRadarDatabase, openAddressRadarDatabase,
  type PostgresTransaction } from "@address-radar/database";
import { createForwardTargetConsoleApplication, type ForwardTargetControlOptions } from "./forward-target-application.js";
import { startAddressRadarConsole } from "./server.js";

const ensure = (value: unknown,message: string): void => { if (!value) throw new Error(message); };
export interface ForwardTargetControlAcceptanceOptions {
  readonly now: number;
  readonly setup: (transaction: PostgresTransaction, now: number) => Promise<string>;
  readonly readAuthorization: ForwardTargetControlOptions["readAuthorization"];
  readonly readRegistry: ForwardTargetControlOptions["readRegistry"];
}
interface AcceptanceRuntime {
  run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T>;
  probe(): Promise<unknown>;
}
export const verifyPostgresForwardTargetControlAcceptance = async (runtime: AcceptanceRuntime,options: ForwardTargetControlAcceptanceOptions) => {
  await runtime.probe();
  const directory = mkdtempSync(join(tmpdir(),"radar-target-control-")),path = join(directory,"identity.sqlite");
  const source = openAddressRadarDatabase(path); migrateAddressRadarDatabase(source);
  const actor = "fixture-authenticated-operator",token = "isolated-control-fixture-token-at-least-32-characters";
  const walletAddress = `0x${"ab".repeat(20)}`;
  const rollback = new Error("Rollback forward target control fixture");
  let now = options.now,counts: Record<string,unknown> = {};
  const entity = (id: string) => {
    source.prepare("INSERT INTO trader_entities(entity_id,lifecycle,manual,locked,created_at,updated_at) VALUES(?,'probation',1,0,?,?)").run(id,now,now);
    source.prepare("INSERT INTO trader_profiles(entity_id,display_name,priority,notes,monitoring_enabled,fomo_monitoring_enabled,onchain_monitoring_enabled,created_at,updated_at) VALUES(?,?,'important','ordinary metadata',1,1,1,?,?)").run(id,id,now,now);
  };
  entity("control-manual"); entity("control-wallet"); entity("control-unverified");
  for (const [id,account,confidence] of [["control-manual","control-account","confirmed"],["control-unverified","unverified-account","high"]]) {
    source.prepare("INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES(?,?,?,?)").run(account!,account!,now,now);
    source.prepare("INSERT INTO entity_accounts(entity_id,account_id,confidence,source,first_observed_at,last_observed_at) VALUES(?,?,?,'manual',?,?)").run(id!,account!,confidence!,now,now);
  }
  source.prepare("INSERT INTO entity_wallet_identities(entity_id,chain_family,address,confidence,source,first_observed_at,last_observed_at) VALUES('control-wallet','evm',?,'confirmed','manual',?,?)").run(walletAddress,now,now);
  try {
    try {
      await runtime.run(async transaction => {
        const generationId = await options.setup(transaction,now);
        const extension = createForwardTargetConsoleApplication({ run: operation => operation(transaction),source: createLegacyForwardTargetSnapshotReader(path),generationId,now: () => now,
          readAuthorization: options.readAuthorization,readRegistry: options.readRegistry });
        const server = await startAddressRadarConsole({ application: { handle: () => ({ status: 404,body: {} }),subscribe: () => () => {},close: () => {} },port: 0,developerToken: token,forwardTargetApplication: extension,
          forwardTargetPrincipal: { actorId: actor,authorizationEvidenceRef: "fixture:validated-bearer",permissions: ["target_registry_write","radar_authorization_write"] } });
        const send = async (method: string,route: string,body?: unknown) => {
          const response = await fetch(`${server.url}/api/v2/forward-targets/${route}`,{ method,headers: { Authorization: `Bearer ${token}`,"Content-Type": "application/json" },...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          return { status: response.status,body: await response.json() as Record<string,unknown> };
        };
        const key = { entityId: "control-manual",channel: "fomo",subjectId: "control-account",walletFamily: null };
        const state = async () => (await send("GET","state?entityId=control-manual&channel=fomo&subjectId=control-account")).body.state as Record<string,unknown>;
        try {
          ensure((await fetch(`${server.url}/api/v2/forward-targets/state`)).status === 401,"Unauthenticated control was accepted");
          ensure((await send("POST","hydrate",{ ...key,associationConfidence: "confirmed",actorId: "forged" })).status === 400,"Client identity proof or actor was accepted");
          ensure((await send("POST","hydrate",key)).status === 200,"Verified legacy target hydration failed");
          ensure((await state()).monitoringEligible && !(await state()).radarEligible,"Default target hydration granted radar");
          now++;
          ensure((await send("POST","hydrate",key)).status === 200,"Identical target hydration was not idempotent");
          const grant = { authorizationId: "control-grant",entityId: key.entityId,action: "grant",basisRef: "fixture:explicit-operator-grant" };
          ensure((await send("POST","manual-authorization",grant)).status === 200,"Explicit authorization failed");
          ensure((await state()).radarEligible,"Explicit authorization did not permit verified FOMO-only target");
          now++;
          ensure((await send("POST","manual-authorization",grant)).status === 200,"Authorization retry was not idempotent");
          ensure((await send("POST","manual-authorization",{ ...grant,basisRef: "different" })).status === 409,"Reused command changed its audit basis");
          const audit = (await transaction.query("SELECT actor_id,actor_authorization_ref FROM forward_manual_radar_authorizations WHERE authorization_id='control-grant'")).rows[0]!;
          ensure(audit.actor_id === actor && audit.actor_authorization_ref === "fixture:validated-bearer","Authorization actor was not server-derived");
          now++; source.prepare("UPDATE trader_profiles SET monitoring_enabled=0,updated_at=? WHERE entity_id='control-manual'").run(now);
          ensure((await send("POST","hydrate",key)).status === 200 && !(await state()).radarEligible,"Manual grant bypassed disabled monitoring");
          now++; source.prepare("UPDATE trader_profiles SET monitoring_enabled=1,updated_at=? WHERE entity_id='control-manual'").run(now);
          ensure((await send("POST","hydrate",key)).status === 200 && (await state()).radarEligible,"Current source re-enable was lost to an old revision");
          now++;
          ensure((await send("POST","manual-authorization",{ ...grant,authorizationId: "control-revoke",action: "revoke" })).status === 200 && !(await state()).radarEligible,"Revocation was not reflected by the actual reader");
          now++; entity("control-other");
          source.prepare("UPDATE entity_accounts SET entity_id='control-other',last_observed_at=? WHERE entity_id='control-manual' AND account_id='control-account'").run(now);
          const conflicting = await send("POST","hydrate",{ ...key,entityId: "control-other" });
          ensure(conflicting.status === 200 && !(conflicting.body.state as Record<string,unknown>).monitoringEligible && !(await state()).monitoringEligible,"Conflicting source ownership revision was not quarantined");
          const wallet = await send("POST","hydrate",{ entityId: "control-wallet",channel: "wallet",subjectId: `0x${"AB".repeat(20)}`,walletFamily: "evm" });
          ensure(wallet.status === 200 && (wallet.body.state as Record<string,unknown>).monitoringEligible,"Wallet-only verified owner was not hydrated");
          const unverified = await send("POST","hydrate",{ entityId: "control-unverified",channel: "fomo",subjectId: "unverified-account" });
          ensure(unverified.status === 200 && !(unverified.body.state as Record<string,unknown>).monitoringEligible,"High confidence without proof was trusted");
          const registry = await send("GET","registry?channel=wallet&limit=1");
          const monitored = registry.body.monitored;
          ensure(registry.status === 200 && registry.body.scanned === 1 && Array.isArray(monitored) && monitored.length === 1
            && monitored[0].entityId === "control-wallet" && monitored[0].subjectId === walletAddress && monitored[0].channel === "wallet",
            "Protected registry did not use the filtered actual reader");
          const denied = await createForwardTargetConsoleApplication({ run: operation => operation(transaction),source: createLegacyForwardTargetSnapshotReader(path),generationId,now: () => now,
            readAuthorization: options.readAuthorization,readRegistry: options.readRegistry }).handle({ method: "POST",url: new URL("http://localhost/api/v2/forward-targets/manual-authorization"),body: grant,
              principal: { actorId: actor,authorizationEvidenceRef: "fixture:read-only",permissions: ["target_registry_write"] } });
          ensure(denied.status === 403,"Operator without grant permission changed authorization");
          counts = (await transaction.query("SELECT (SELECT count(*) FROM forward_target_channel_versions) AS channel_versions,(SELECT count(*) FROM forward_manual_radar_authorizations) AS manual_events")).rows[0]!;
          ensure(Number(counts.channel_versions) === 6 && Number(counts.manual_events) === 2,"Control retries duplicated immutable events");
          throw rollback;
        } finally { await server.close(); }
      });
    } catch (error) { if (error !== rollback) throw error; }
    const cleanup = (await runtime.run(transaction => transaction.query("SELECT to_regclass('pg_temp.forward_target_channel_versions') AS channels,to_regclass('pg_temp.forward_manual_radar_authorizations') AS grants"))).rows[0]!;
    ensure(cleanup.channels === null && cleanup.grants === null,"Control fixture rollback left tables behind");
    return { status: "passed",fixtureScope: "synthetic_http_transaction_rollback",channelVersions: Number(counts.channel_versions),manualEvents: Number(counts.manual_events),
      authenticatedHttpVerified: true,serverDerivedActorVerified: true,clientProofRejected: true,legacySourceReadOnly: true,defaultMonitoringNoGrant: true,
      manualGrantAuditVerified: true,idempotentCommandsVerified: true,sourceDisableAndRevocationVerified: true,ownershipQuarantineVerified: true,
      independentChannelsVerified: true,permissionGuardVerified: true,cleanupVerified: true,businessActivation: false,liveSourceCoverageVerified: false,gatewayDeliveryEnabled: false };
  } finally { source.close(); rmSync(directory,{ recursive: true,force: true }); }
};
