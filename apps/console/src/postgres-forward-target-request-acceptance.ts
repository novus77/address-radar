import { createPostgresForwardTargetAuthorizationRepository, type PostgresTransaction } from "@address-radar/database";
import type { ForwardTargetPrincipal } from "@address-radar/domain";
import { createForwardTargetConsoleApplication, type ForwardTargetControlOptions } from "./forward-target-application.js";
import { startAddressRadarConsole } from "./server.js";

interface AcceptanceRuntime {
  run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T>;
  probe(): Promise<unknown>;
}
interface RequestAcceptanceOptions {
  readonly now: number;
  readonly setup: (transaction: PostgresTransaction, now: number) => Promise<string>;
  readonly readAuthorization: ForwardTargetControlOptions["readAuthorization"];
  readonly readRegistry: ForwardTargetControlOptions["readRegistry"];
}
function requireProof(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
const temporaryTables = async (transaction: PostgresTransaction): Promise<string[]> =>
  (await transaction.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r' ORDER BY relname")).rows.map(row => String(row.relname));
const counts = async (transaction: PostgresTransaction) => {
  const row = (await transaction.query("SELECT (SELECT count(*) FROM forward_manual_radar_authorizations)::int AS events,(SELECT count(*) FROM forward_target_authorization_intents WHERE kind='manual_changed')::int AS intents")).rows[0];
  requireProof(row, "Missing audit counts"); return { events: Number(row.events), intents: Number(row.intents) };
};
const eligible = (value: unknown): boolean => Boolean(value && typeof value === "object" && "radarEligible" in value && value.radarEligible === true);

export async function verifyPostgresForwardTargetRequestAcceptance(runtime: AcceptanceRuntime, options: RequestAcceptanceOptions) {
  requireProof(Number.isSafeInteger(options.now) && options.now > 0, "Invalid acceptance clock");
  await runtime.probe();
  const principal: ForwardTargetPrincipal = { actorId: "request-acceptance-operator", authorizationEvidenceRef: "request-acceptance-permission", permissions: ["target_registry_write", "radar_authorization_write"] };
  const key = { entityId: "request-acceptance-entity", channel: "fomo" as const, subjectId: "request-acceptance-account", walletFamily: null };
  const token = "request-acceptance-operator-token-0000000000000000";
  let backendPid = 0, clock = options.now, ownedTables: string[] = [], cleanupVerified = false;
  let failNextIntent = false, faultObserved = false, committedCommands = 0;
  const requestTransactions = new Set<string>();
  let server: Awaited<ReturnType<typeof startAddressRadarConsole>> | null = null;
  const assertSession = async (transaction: PostgresTransaction) => {
    const row = (await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0];
    requireProof(Number(row?.pid) === backendPid, "Acceptance session changed; temporary fixture is no longer authoritative");
  };
  try {
    const generationId = await runtime.run(async transaction => {
      requireProof((await temporaryTables(transaction)).length === 0, "Acceptance requires an empty dedicated temporary namespace");
      backendPid = Number((await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      requireProof(Number.isSafeInteger(backendPid) && backendPid > 0, "Missing acceptance backend PID");
      const generation = await options.setup(transaction, options.now);
      await createPostgresForwardTargetAuthorizationRepository(transaction, principal).recordChannel({ ...key,
        versionId: "request-acceptance-target-v1", effectiveAt: options.now, knownAt: options.now,
        associationConfidence: "confirmed", associationSource: "request_acceptance_fixture", ownerCount: 1,
        walletConfidence: null, walletSource: null, identityEvidenceRef: "request-fixture-identity", ownershipEvidenceRef: "request-fixture-ownership",
        monitoringEnabled: true, suspended: false,
      });
      ownedTables = await temporaryTables(transaction);
      requireProof(ownedTables.length > 0 && ownedTables.every(name => /^[a-z_][a-z0-9_]*$/.test(name)), "Invalid temporary fixture inventory");
      return generation;
    });
    const application = createForwardTargetConsoleApplication({ generationId, now: () => clock, source: { read: () => null },
      readAuthorization: options.readAuthorization, readRegistry: options.readRegistry,
      run: operation => runtime.run(async transaction => {
        await assertSession(transaction);
        const identifier = String((await transaction.query("SELECT txid_current()::text AS transaction_id")).rows[0]?.transaction_id);
        requireProof(identifier !== "undefined", "Missing request transaction ID"); requestTransactions.add(identifier);
        return operation({ query: async (sql, values) => {
          if (failNextIntent && /INSERT/i.test(sql) && sql.includes("forward_target_authorization_intents")) {
            failNextIntent = false; faultObserved = true; throw new Error("Injected intent failure after authorization writes");
          }
          return transaction.query(sql, values);
        } });
      }),
    });
    const legacyApplication = { handle: () => ({ status: 404, body: { error: "fixture_only" } }), subscribe: () => () => {}, close: () => {} } as unknown as Parameters<typeof startAddressRadarConsole>[0]["application"];
    server = await startAddressRadarConsole({ application: legacyApplication, developerToken: token, host: "127.0.0.1", port: 0,
      forwardTargetApplication: application, forwardTargetPrincipal: principal });
    const request = async (body: Record<string, unknown>, authenticated = true) => {
      const response = await fetch(`${server!.url}/api/v2/forward-targets/manual-authorization`, { method: "POST", headers: {
        "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const readState = () => runtime.run(async transaction => { await assertSession(transaction); return options.readAuthorization(transaction, { ...key, generationId, asOf: clock }); });
    const command = (authorizationId: string, action: "grant" | "revoke", basisRef = "request-fixture-approval") => ({ authorizationId, entityId: key.entityId, action, basisRef });
    requireProof(!eligible(await readState()), "Default monitoring unexpectedly grants radar eligibility");
    clock += 1;
    requireProof((await request(command("request-grant", "grant"))).status === 200, "Grant request failed"); committedCommands += 1;
    requireProof(eligible(await readState()), "Committed grant is invisible to a later independent transaction");
    clock += 1;
    requireProof((await request(command("request-grant", "grant"))).status === 200, "Idempotent retry failed");
    const firstCounts = await runtime.run(counts);
    requireProof(firstCounts.events === 1 && firstCounts.intents === 1, "Retry duplicated authorization or intent");
    requireProof((await request(command("request-grant", "grant", "changed-basis"))).status === 409, "Conflicting immutable command was accepted");
    clock += 1;
    requireProof((await request(command("request-revoke", "revoke"))).status === 200, "Revoke request failed"); committedCommands += 1;
    requireProof(!eligible(await readState()), "Committed revocation is invisible to a later transaction");
    const beforeFailure = await runtime.run(counts);
    clock += 1; failNextIntent = true;
    const failed = await request(command("request-recovered", "grant"));
    requireProof(failed.status === 500 && failed.body.error === "forward_target_control_failed" && faultObserved, "Failure injection did not reach the transaction boundary");
    const afterFailure = await runtime.run(counts);
    requireProof(afterFailure.events === beforeFailure.events && afterFailure.intents === beforeFailure.intents && !eligible(await readState()), "Failed request partially committed audit, intent or authorization head");
    const absent = await runtime.run(transaction => transaction.query("SELECT 1 FROM forward_manual_radar_authorizations WHERE authorization_id=$1", ["request-recovered"]));
    requireProof(absent.rows.length === 0, "Failed command left an immutable event behind");
    clock += 1;
    requireProof((await request(command("request-recovered", "grant"))).status === 200 && eligible(await readState()), "Retry after rollback did not commit correctly"); committedCommands += 1;
    const beforeUnauthorized = await runtime.run(counts);
    requireProof((await request(command("request-unauthorized", "revoke"), false)).status === 401, "Anonymous mutation was accepted");
    const afterUnauthorized = await runtime.run(counts);
    requireProof(beforeUnauthorized.events === 3 && afterUnauthorized.events === 3 && afterUnauthorized.intents === 3, "Unauthorized request changed the audit ledger");
    requireProof(requestTransactions.size >= 6, "HTTP commands did not use independent transactions");
    const page = await fetch(`${server.url}/forward-targets`, { signal: AbortSignal.timeout(5000) });
    requireProof(page.status === 200 && (await page.text()).includes('src="/forward-targets.js"'), "Operator page is missing from the acceptance server");
  } finally {
    if (server) await server.close();
    if (ownedTables.length > 0) await runtime.run(async transaction => {
      await assertSession(transaction);
      const actual = await temporaryTables(transaction);
      requireProof(actual.length === ownedTables.length && actual.every(name => ownedTables.includes(name)), "Temporary fixture ownership inventory changed");
      await transaction.query(`DROP TABLE ${ownedTables.map(name => `pg_temp."${name}"`).join(",")} CASCADE`);
      cleanupVerified = (await temporaryTables(transaction)).length === 0;
      requireProof(cleanupVerified, "Temporary fixture cleanup failed");
    });
  }
  return { status: "passed", fixtureScope: "synthetic_http_per_request_temp_session", committedCommands,
    independentRequestTransactions: requestTransactions.size, perRequestCommitVerified: true, commandRollbackVerified: true,
    retryIdempotencyVerified: true, unauthorizedNoMutationVerified: true, operatorAssetsServed: true, cleanupVerified,
    businessActivation: false, liveSourceCoverageVerified: false, gatewayDeliveryEnabled: false } as const;
}
