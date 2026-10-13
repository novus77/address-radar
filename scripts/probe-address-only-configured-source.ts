import { createHash, createPublicKey, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readPrivateAuthorityPin, type PostgresCliExecutionAuthorityConfiguration } from "./postgres-service-cli-authority.js";
import { runtimeAuthorityFingerprint, type RuntimeAuthorityJob } from "./provision-address-only-runtime-authority.js";
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import type { PostgresTransaction } from "../packages/database/src/postgres-unit-of-work.js";
import type { FetchLike } from "../packages/collectors/src/types.js";
import { classifyJsonRpcLimit } from "../packages/collectors/src/json-rpc-client.js";
import { createConfiguredWalletRpcClient } from "../apps/wallet-monitor/src/rpc.js";
import type { CapturedPostgresWalletEvent, PostgresWalletChannelOptions } from "../apps/wallet-monitor/src/postgres-wallet-channel.js";
import { createPostgresSolanaExecutionProducer } from "../apps/automation/src/postgres-wallet-rpc-producer.js";
import { createPostgresIndependentExecutionValidator, type PostgresIndependentExecutionValidatorOptions } from "../apps/automation/src/postgres-independent-execution-validator.js";
import { executionValidationSigningPayload } from "../apps/automation/src/postgres-execution-fact-publisher.js";

export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
interface ProbeContract {
  readonly providerId: string; readonly endpoint: string; readonly importId: string; readonly sourceFingerprint: string;
  readonly windowMs: number; readonly maximumRequests: number; readonly maximumConcurrency: number;
}
export interface ConfiguredSourceProbeOptions {
  readonly schema: string; readonly generationId: string; readonly activatedAt: number;
  readonly source: ProbeContract; readonly replay: ProbeContract;
  readonly authority: {
    readonly pin: { readonly path: string; readonly sha256: string };
    readonly operationId: string; readonly releaseSha256: string;
    readonly actorId: string; readonly authorizationRef: string;
  };
  readonly validatorImport: {
    readonly importId: string; readonly sourceFingerprint: string;
    /** Import-ledger approval, distinct from the validator actor's authorizationRef. */
    readonly approvalRef: string;
    readonly configuration: RuntimeAuthorityJob["validators"][number];
  };
  /** Explicit local ceilings; these never increase the durable provider allocations. */
  readonly maximumRunMs: number; readonly maximumRequests: number; readonly maximumBodyBytes: number;
  readonly ports: {
    /** Existing durable-budget/lease guarded port. Never global fetch or a fresh RPC pool. */
    readonly readPin?: typeof readPrivateAuthorityPin;
    readonly fetch: FetchLike; readonly profiles: PostgresWalletChannelOptions["profiles"];
    readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  };
  /** Already pinned execution-purpose authority material and server-local signing-key port. */
  readonly validator: Omit<PostgresIndependentExecutionValidatorOptions,"fetch" | "profiles" | "now" | "onRpcDiagnostic">;
  readonly now: () => number;
}
export interface ConfiguredSourceProbeReceipt {
  readonly status: "verified" | "deferred";
  readonly reasonCode?: string;
  /** Guarded fetch invocations, including attempts rejected before HTTP by the shared budget. */
  readonly sourceRequests: number; readonly replayRequests: number; readonly responseBytes: number;
  readonly mainnetGenesisVerified: boolean; readonly sourceVersion1Verified: boolean;
  readonly replayVersion1Verified: boolean; readonly independentSignatureVerified: boolean;
  readonly bindingSha256?: string;
}
const methods = new Set(["getGenesisHash","getSignatureStatuses","getTransaction","getBlock"]);
const positive = (value: number,max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;
const identity = (value: string) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const hash = (value: string) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
class ProbeStopped extends Error { constructor(readonly reason: string) { super(reason); } }

/** Injected native maintenance entry only: no CLI credentials, connection construction, publisher or deployment writes. */
export function createConfiguredSourceProbe(options: ConfiguredSourceProbeOptions) {
  const endpoint = (value: string): URL => {
    try { return new URL(value); } catch { throw new Error("probe_configuration_invalid"); }
  };
  const source = endpoint(options.source.endpoint), replay = endpoint(options.replay.endpoint);
  const binding = options.validator.reviewedProviderBindings.filter(pair=>pair.chain === "solana");
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema) || options.schema.startsWith("pg_") || options.schema === "public"
    || !identity(options.generationId) || !Number.isSafeInteger(options.activatedAt) || options.activatedAt < 0
    || !positive(options.maximumRunMs,60_000) || !positive(options.maximumRequests,8) || !positive(options.maximumBodyBytes,2_097_152)
    || source.protocol !== "https:" || !(source.hostname === "publicnode.com" || source.hostname.endsWith(".publicnode.com"))
    || replay.href !== "https://api.mainnet-beta.solana.com/" || source.search || source.hash || source.username || source.password
    || source.origin === replay.origin || options.source.providerId === options.replay.providerId
    || [options.source,options.replay].some(c => !identity(c.providerId) || !identity(c.importId) || !hash(c.sourceFingerprint)
      || c.windowMs !== 60_000 || c.maximumRequests !== 60 || c.maximumConcurrency !== 1)
    || !identity(options.validatorImport.importId) || !hash(options.validatorImport.sourceFingerprint)
    || options.validator.generationId !== options.generationId || options.validator.activatedAt !== options.activatedAt
    || binding.length !== 1 || binding[0]?.chain !== "solana" || binding[0].sourceProviderId !== options.source.providerId
    || binding[0].sourceEndpoint !== options.source.endpoint || binding[0].replayProviderId !== options.replay.providerId
    || binding[0].replayEndpoint !== options.replay.endpoint || binding[0].expectedGenesisHash !== SOLANA_MAINNET_GENESIS
    || typeof options.ports.fetch !== "function" || typeof options.ports.run !== "function" || typeof options.ports.profiles.load !== "function") {
    throw new Error("probe_configuration_invalid");
  }
  const schema = `"${options.schema}"`;
  let busy = false;
  return Object.freeze({ async probe(input: { readonly payload: CapturedPostgresWalletEvent; readonly signal: AbortSignal }): Promise<ConfiguredSourceProbeReceipt> {
    const receipt = { sourceRequests:0,replayRequests:0,responseBytes:0,mainnetGenesisVerified:false,
      sourceVersion1Verified:false,replayVersion1Verified:false,independentSignatureVerified:false };
    const deferred = (reasonCode: string): ConfiguredSourceProbeReceipt => ({status:"deferred",reasonCode,...receipt});
    if (busy) return deferred("probe_busy");
    if (input.signal.aborted) return deferred("probe_aborted_or_timed_out");
    busy = true;
    const controller = new AbortController(), abort = () => controller.abort(), pending = new Set<Promise<unknown>>();
    const started = performance.now(), at = options.now(); let lastAt = at, failure: string | undefined;
    const stop: (reason: string) => never = (reason: string): never => { failure ??= reason; throw new ProbeStopped(reason); };
    const check = () => {
      const now = options.now();
      if (controller.signal.aborted || performance.now()-started >= options.maximumRunMs) stop("probe_aborted_or_timed_out");
      if (!Number.isSafeInteger(now) || now < lastAt) stop("probe_clock_invalid");
      lastAt = now; return now;
    };
    function track<T>(operation: () => Promise<T>): Promise<T> {
      const work = Promise.resolve().then(operation); pending.add(work);
      void work.then(()=>pending.delete(work),()=>pending.delete(work)); return work;
    }
    input.signal.addEventListener("abort",abort,{once:true});if(input.signal.aborted)abort();
    const timer = setTimeout(abort,options.maximumRunMs);
    let onAbort = () => {};
    const cancelled = new Promise<ConfiguredSourceProbeReceipt>(resolve => {
      onAbort = () => resolve(deferred("probe_aborted_or_timed_out"));
      controller.signal.addEventListener("abort",onAbort,{once:true});if(controller.signal.aborted)onAbort();
    });
    const operation = track(async (): Promise<ConfiguredSourceProbeReceipt> => {
      check();
      if (Buffer.byteLength(JSON.stringify(input.payload)) > options.maximumBodyBytes) stop("probe_payload_budget_exceeded");
      // The ledger fingerprints the approved validator record, not the runtime authority file bytes.
      let signingKey: ReturnType<typeof options.validator.signingKey.loadPrivateKey>;
      try {
        const authority=options.authority;
        if(!authority || !identity(authority.actorId) || !identity(authority.authorizationRef)
          || !hash(authority.pin.sha256) || !identity(options.validatorImport.approvalRef))stop("probe_authority_unavailable");
        const raw=await track(()=>(options.ports.readPin??readPrivateAuthorityPin)(authority.pin));check();
        if(raw.length>524288 || createHash("sha256").update(raw).digest("hex")!==authority.pin.sha256)stop("probe_authority_unavailable");
        const material=JSON.parse(raw.toString("utf8")) as PostgresCliExecutionAuthorityConfiguration;
        if(material.protocol!=="address-only-cli-execution-authority-v1" || material.operationId!==authority.operationId
          || material.generationId!==options.generationId || material.releaseSha256!==authority.releaseSha256)stop("probe_authority_unavailable");
        const {generationId: _generation,activatedAt: _activation,signingKey: _signing,nonce: _nonce,...validator}=options.validator;
        if(!isDeepStrictEqual(material.validator,validator))stop("probe_authority_unavailable");
        const pins=material.publisher.validators.filter(pin=>pin.validatorId===validator.validatorId && pin.keyId===validator.keyId);
        const pin=pins[0];
        if(pins.length!==1 || !pin || pin.publicKey!==validator.publicKey || pin.actorId!==authority.actorId
          || pin.authorizationRef!==authority.authorizationRef || pin.actorId===options.source.providerId
          || !pin.reviewedSourceProviders.includes(options.replay.providerId))stop("probe_authority_unavailable");
        const approved=options.validatorImport.configuration;
        if(!approved || approved.kind!=="execution" || approved.importId!==options.validatorImport.importId
          || approved.validatorId!==pin.validatorId || approved.keyId!==pin.keyId || approved.publicKey!==pin.publicKey
          || approved.actorId!==pin.actorId || approved.authorizationRef!==pin.authorizationRef
          || !isDeepStrictEqual(approved.reviewedSourceProviders,pin.reviewedSourceProviders)
          || !hash(approved.evidenceSha256)
          || ![approved.importedAt,approved.validFrom,approved.validUntil].every(value=>Number.isSafeInteger(value) && value>=0)
          || approved.importedAt>approved.validFrom || approved.validFrom>at
          || approved.validUntil<=at+options.maximumRunMs+options.validator.validationTtlMs
          || runtimeAuthorityFingerprint({approvalRef:options.validatorImport.approvalRef,proofScope:"validator_authority",configuration:approved})
            !==options.validatorImport.sourceFingerprint)stop("probe_authority_unavailable");
        signingKey=options.validator.signingKey.loadPrivateKey();
        const expected=createPublicKey(pin.publicKey);
        if(expected.asymmetricKeyType!=="ed25519" || !createPublicKey(signingKey).export({type:"spki",format:"der"})
          .equals(expected.export({type:"spki",format:"der"})))stop("probe_authority_unavailable");
      } catch { stop("probe_authority_unavailable"); }
      check();
      const payload = structuredClone(input.payload);
      const wanted = [options.source,options.replay].map(c=>({...c,origin:new URL(c.endpoint).origin}));
      const approved = await track(()=>options.ports.run(tx=>tx.query(`/* configured-source-probe-approval: read only */ WITH wanted AS (
        SELECT * FROM jsonb_to_recordset($3::jsonb) AS w("providerId" text,origin text,"importId" text,"sourceFingerprint" text,
          "windowMs" integer,"maximumRequests" integer,"maximumConcurrency" integer)
      ) SELECT (SELECT count(*)=1 AND coalesce(bool_and(g.activated_at=$2),false)
          FROM ${schema}.forward_strategy_generations g WHERE g.generation_id=$1)
        AND (SELECT count(*)=2 AND coalesce(bool_and((SELECT count(*)=1 AND coalesce(bool_and(
          b.origin=w.origin AND b.import_id=w."importId" AND l.source_fingerprint=w."sourceFingerprint"
          AND b.window_ms=w."windowMs" AND b.maximum_requests=w."maximumRequests" AND b.maximum_concurrency=w."maximumConcurrency"
          AND l.proof_scope='provider_contract' AND l.imported_at<=$4 AND l.revoked_at IS NULL),false)
          FROM (SELECT * FROM ${schema}.wallet_service_provider_budgets WHERE generation_id=$1 AND provider_id=w."providerId" LIMIT 2) b
          JOIN ${schema}.wallet_service_import_ledger l ON l.generation_id=b.generation_id AND l.import_id=b.import_id)),false) FROM wanted w)
        AND (SELECT count(*)=1 AND coalesce(bool_and(v.import_id=$6 AND l.source_fingerprint=$7
          AND l.proof_scope='validator_authority' AND l.approval_ref=$9 AND l.imported_at=$12
          AND v.valid_from=$10 AND v.valid_until=$11 AND l.imported_at<=$4 AND l.revoked_at IS NULL AND v.revoked_at IS NULL
          AND v.valid_from<=$4 AND v.valid_until>$4::bigint+$8::bigint),false)
          FROM (SELECT * FROM ${schema}.wallet_service_fact_validators
            WHERE generation_id=$1 AND kind='execution' AND validator_id=$5 LIMIT 2) v
          JOIN ${schema}.wallet_service_import_ledger l ON l.generation_id=v.generation_id AND l.import_id=v.import_id) approved`,
        [options.generationId,options.activatedAt,JSON.stringify(wanted),at,options.validator.validatorId,
          options.validatorImport.importId,options.validatorImport.sourceFingerprint,options.maximumRunMs+options.validator.validationTtlMs,options.validatorImport.approvalRef,
          options.validatorImport.configuration.validFrom,options.validatorImport.configuration.validUntil,options.validatorImport.configuration.importedAt])));
      check();
      if (approved.rows.length !== 1 || approved.rows[0]?.approved !== true) stop("probe_approval_unavailable");
      const fetch: FetchLike = (url,init) => track(async()=>{
        check();
        const target = new URL(String(url));
        const purpose = target.href === source.href ? "source" : target.href === replay.href ? "replay" : null;
        if (!purpose || init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body)>options.maximumBodyBytes) stop("probe_request_not_allowed");
        const body = JSON.parse(init.body) as {method?:unknown};
        if (typeof body.method !== "string" || !methods.has(body.method)) stop("probe_request_not_allowed");
        if (receipt.sourceRequests+receipt.replayRequests >= options.maximumRequests) stop("probe_request_budget_exceeded");
        if (purpose === "source") receipt.sourceRequests++; else receipt.replayRequests++;
        let response: Response;
        try { response = await options.ports.fetch(url,{...init,signal:controller.signal,redirect:"error"}); }
        catch(error) {
          const name = utilTypes.isNativeError(error) && !utilTypes.isProxy(error) ? Object.getOwnPropertyDescriptor(error,"name")?.value : undefined;
          stop(name === "PostgresProviderBudgetError" ? "probe_provider_budget_unavailable" : "probe_transport_unavailable");
        }
        check();
        if (response.redirected || response.url && new URL(response.url).href !== target.href) { void response.body?.cancel(); stop("probe_redirect_rejected"); }
        if (response.status===403 || response.status===401 || response.status===429) {
          void response.body?.cancel(); stop(response.status===429?"probe_rate_limited":"probe_access_denied");
        }
        if (!response.ok) { void response.body?.cancel(); stop("probe_http_error"); }
        const reader = response.body?.getReader(); if (!reader) stop("probe_response_missing");
        const chunks: Uint8Array[] = [];
        const cancelRead=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener("abort",cancelRead,{once:true});
        try { for (;;) {
          check();const chunk=await reader.read();check();if(chunk.done)break;
          receipt.responseBytes+=chunk.value.byteLength;
          if(receipt.responseBytes>options.maximumBodyBytes)stop("probe_response_budget_exceeded");chunks.push(chunk.value);
        } } finally {controller.signal.removeEventListener("abort",cancelRead);cancelRead();reader.releaseLock();}
        const bytes=Buffer.concat(chunks),rpc=JSON.parse(bytes.toString("utf8")) as {error?:{code?:unknown;message?:unknown};result?:unknown};
        if(rpc.error){const category=classifyJsonRpcLimit({method:body.method,code:rpc.error.code,message:rpc.error.message,httpStatus:response.status});
          if(category==="rate_limit"||category==="ambiguous_limit")stop("probe_rate_limited");}
        if(body.method==="getTransaction"){
          if(!rpc.result || typeof rpc.result!=="object" || (rpc.result as {version?:unknown}).version!==1)stop("probe_version1_unavailable");
          if(purpose==="source")receipt.sourceVersion1Verified=true;else receipt.replayVersion1Verified=true;
        }
        return new Response(bytes,{status:response.status,headers:{"content-type":"application/json"}});
      });
      const profiles: PostgresWalletChannelOptions["profiles"]={load:request=>track(async()=>{check();const result=await options.ports.profiles.load(request);check();return result;})};
      const producer=createPostgresSolanaExecutionProducer({generationId:options.generationId,activatedAt:options.activatedAt,
        providerId:options.source.providerId,expectedGenesisHash:SOLANA_MAINNET_GENESIS,profiles,rpc:createConfiguredWalletRpcClient({
          endpoints:{solana:{primary:options.source.endpoint}},fetch}),maximumProfiles:options.validator.maximumProfiles,
        maximumPayloadBytes:Math.min(options.maximumBodyBytes,options.validator.maximumPayloadBytes),maximumRunMs:options.maximumRunMs,now:check});
      const acquired=await producer.acquire({payload,signal:controller.signal});check();
      if(acquired.status!=="acquired")return deferred(failure??"probe_source_acquisition_unavailable");
      receipt.mainnetGenesisVerified=acquired.candidate.genesisHash===SOLANA_MAINNET_GENESIS;
      const validator=createPostgresIndependentExecutionValidator({...options.validator,signingKey:{loadPrivateKey:()=>signingKey},fetch,profiles,now:check,
        maximumRunMs:Math.min(options.maximumRunMs,options.validator.maximumRunMs)});
      const result=await validator.validateExecution({candidate:acquired.candidate,signal:controller.signal});check();
      if(result.status!=="verified")return deferred(failure??"probe_independent_replay_unavailable");
      const {claims,signature}=result.validation;
      receipt.independentSignatureVerified=claims.generationId===options.generationId && claims.providerId===options.source.providerId
        && claims.sourceBasis.providerId===options.replay.providerId && claims.candidateFingerprint===acquired.candidate.contentFingerprint
        && claims.checkedAt<=check() && claims.expiresAt>check()
        && verify(null,executionValidationSigningPayload(claims),createPublicKey(options.validator.publicKey),Buffer.from(signature,"base64"));
      if(!receipt.independentSignatureVerified || !receipt.sourceVersion1Verified || !receipt.replayVersion1Verified)stop("probe_signature_or_version_unavailable");
      return {status:"verified",...receipt,bindingSha256:createHash("sha256").update(executionValidationSigningPayload(claims)).digest("hex")};
    }).catch(()=>deferred(failure??"probe_validation_unavailable"));
    try { return await Promise.race([operation,cancelled]); }
    finally {
      controller.abort();clearTimeout(timer);input.signal.removeEventListener("abort",abort);controller.signal.removeEventListener("abort",onAbort);
      // Deadline does not prove a native SQL/transport port drained. Refuse reentry until all tracked work settles.
      if(pending.size)void Promise.allSettled([...pending]).then(()=>{busy=false;});else busy=false;
    }
  } });
}
