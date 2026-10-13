import { createPostgresIndependentExecutionValidator, type PostgresIndependentExecutionValidatorOptions } from "../apps/automation/src/postgres-independent-execution-validator.js";
import type { PostgresRpcDiagnosticContext } from "../apps/automation/src/postgres-wallet-rpc-producer.js";
import { POSTGRES_PROVIDER_BUDGET_REASONS } from "../apps/automation/src/postgres-service-fact-adapters.js";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { hostname } from "node:os";
import { types as utilTypes } from "node:util";
import { pathToFileURL } from "node:url";
import { composePostgresServicePriceDependencies, type PostgresNativePriceAuthorityInput } from './postgres-price-authority.js';
import {
  createPostgresBusinessRuntime, readPrivatePostgresDeployment, POSTGRES_BUSINESS_SERVICES,
  readPostgresForwardTrace, type PostgresBusinessOptions, type PostgresBusinessRuntime,
  type PostgresBusinessService, type ServiceEnvironment,
} from "../packages/database/src/index.js";
import { createPostgresProductionComposition, type PostgresProductionCompositionOptions,
  type PostgresProductionFactAdapters } from "../apps/automation/src/postgres-production-composition.js";
import { createPostgresWalletChannel, type PostgresWalletChannelOptions } from "../apps/wallet-monitor/src/postgres-wallet-channel.js";
import { loadWalletMonitorConfig } from "../apps/wallet-monitor/src/config.js";
import { createConfiguredWalletRpcClient } from "../apps/wallet-monitor/src/rpc.js";
import { createEvmBlockWalletCollector, createSolanaWalletCollector, decodeEvmTransferRangeReceipt } from "../apps/wallet-monitor/src/collectors.js";
import { createEvmTransferRangeWalletCollector } from "../apps/wallet-monitor/src/evm-transfer-range-collector.js";
import type { WalletRpcClient } from "../apps/wallet-monitor/src/rpc.js";
import { createPostgresSolanaExecutionProducer, POSTGRES_EXECUTION_ACQUISITION_TRANSPORT_REASONS,
  POSTGRES_EXECUTION_RPC_METHODS, POSTGRES_EXECUTION_RPC_SUBCATEGORIES,
  type PostgresSolanaExecutionProducerOptions } from "../apps/automation/src/postgres-wallet-rpc-producer.js";
import { createPostgresEvmExecutionProducer, createPostgresEvmExecutionDispatcher, type PostgresEvmExecutionProducerOptions } from "../apps/automation/src/postgres-evm-execution-producer.js";
import { createPostgresWalletExecutionReceiver, type PostgresWalletExecutionReceiverOptions } from "../apps/automation/src/postgres-wallet-execution-receiver.js";
import { createPostgresGeckoTerminalPriceProducer, createPostgresReportedMarketCapProducer, type PostgresReportedMarketCapClient, type PostgresControlledPriceOptions } from "../apps/automation/src/postgres-controlled-price-producer.js";
import { createPostgresPriceCandidateReceiver, type PostgresPriceCandidateReceiverOptions, type PostgresPriceCandidateRequest } from "../apps/automation/src/postgres-price-candidate-receiver.js";
import type { PostgresPricePublication, PostgresPricePublisherOptions } from "../apps/automation/src/postgres-price-fact-publisher.js";
import type { DiscoveryChain, FetchLike } from "../packages/collectors/src/index.js";
import { readPostgresGenerationProgress } from "../apps/console/src/postgres-progress.js";
import {
  createReadOnlyCutoverStartupStore, verifyCommittedPostgresCutover, verifyCommittedPostgresWriterStartup,
  type WriterFencePolicy,
} from "../packages/database/src/migration-cutover-coordinator.js";
import type { FenceClosureTrust } from "../packages/database/src/migration-writer-fence-closure.js";
import {
  readPostgresServiceBudgets, readPostgresExecutionFormat, verifyPostgresServiceRelease, withPostgresDeadline,
  type PostgresDispatchBudgets, type PostgresReleaseLimits, type PostgresServiceLifecycleNotice, type PostgresExecutionFormat,
} from "../packages/database/src/postgres-service-dispatch.js";

import { validateAddressOnlyStartupManifest, verifyAddressOnlyCommittedStartup, type AddressOnlyStartupManifest } from "../apps/automation/src/postgres-address-only-startup.js";
import { readAddressOnlyStartupEvidence, type AddressOnlyStartupEvidence } from "./postgres-address-only-startup-evidence.js";

type DriverSettings = Omit<PostgresBusinessOptions, "connectionString" | "target" | "access" | "maximumConnections">;
import { createPostgresSourceFactRetry, type PostgresSourceFactRetryAuthority,
  type PostgresSourceFactRetryOptions, type PostgresSourceFactRetryReport } from "../apps/automation/src/postgres-source-fact-retry.js";
import { createPostgresExecutionCaptureRetry, type PostgresExecutionCaptureRetryOptions,
  type PostgresExecutionCaptureRetryReport } from "../apps/automation/src/postgres-execution-capture-retry.js";

export interface PostgresRootExecutionRetryConfiguration {
  readonly maximumCaptures: number; readonly maximumPayloadBytes: number; readonly maximumRunMs: number;
}
function validateRootExecutionRetry(config: ConfiguredPostgresServiceDeployment): void {
  const retry = config.executionRetry;
  if (retry === undefined) return;
  executionKeys(retry,["maximumCaptures","maximumPayloadBytes","maximumRunMs"]);
  const receiver = config.walletExecution?.receiver;
  if (!receiver) throw new Error("Execution retry requires the existing execution receiver allocation");
  positive(retry.maximumCaptures,Math.min(1000,receiver.maximumCandidates));
  positive(retry.maximumPayloadBytes,Math.min(2_097_152,receiver.maximumPayloadBytes));
  positive(retry.maximumRunMs,receiver.maximumRunMs);
  const factAge = config.sources.maximumFactAgeMs;
  if (typeof factAge !== "number") throw new Error("Execution retry requires the existing explicit fact age budget");
  positive(factAge);
  const factBytes = config.sources.maximumExecutionFactPayloadBytes ?? config.sources.maximumFactPayloadBytes;
  if (typeof factBytes !== "number") throw new Error("Execution retry requires the existing fact payload budget");
  positive(factBytes,2_097_152);
  if (config.wallet.maximumRunMs + retry.maximumRunMs + (config.sourceRetry?.maximumRunMs ?? 0) > config.lifecycle.pollMs) {
    throw new Error("Execution retry exceeds remaining wallet poll allocation");
  }
}

export interface PostgresRootSourceRetryConfiguration {
  readonly maximumSamples: number;
  readonly maximumPayloadBytes: number;
  readonly maximumRunMs: number;
}

function validateRootSourceRetry(config: ConfiguredPostgresServiceDeployment): void {
  const budget = config.sourceRetry;
  if (budget === undefined) return;
  executionKeys(budget, ["maximumSamples", "maximumPayloadBytes", "maximumRunMs"]);
  positive(budget.maximumSamples, 1000);
  positive(budget.maximumPayloadBytes, 10_000_000);
  positive(budget.maximumRunMs, 60_000);
  if (config.wallet.maximumRunMs + budget.maximumRunMs > config.lifecycle.pollMs) {
    throw new Error("Source retry exceeds remaining wallet poll deadline");
  }
}

/** Reuse committed envelopes and existing native UOWs; execution authority is never promoted to source authority. */
export function createPostgresRootWalletSourcePoll<T extends object>(input: {
  config: PostgresServiceDeployment;
  runtime: Pick<PostgresSourceFactRetryOptions, "run">;
  channel: { pollOnce(signal: AbortSignal): Promise<T> };
  authority?: PostgresSourceFactRetryAuthority;
  executionReceiver?: PostgresExecutionCaptureRetryOptions["receiver"];
  now: () => number;
}) {
  const config = input.config;
  if (!isWaitingDeployment(config)) validateRootSourceRetry(config);
  if (!isWaitingDeployment(config)) validateRootExecutionRetry(config);
  const executionRetry = !isWaitingDeployment(config) && config.executionRetry
    ? createPostgresExecutionCaptureRetry({ ...config.executionRetry,generationId: config.generationId,activatedAt: config.activatedAt,
      maximumFactAgeMs: config.sources.maximumFactAgeMs as number,
      maximumFactPayloadBytes: (config.sources.maximumExecutionFactPayloadBytes ?? config.sources.maximumFactPayloadBytes) as number,
      lookaheadMs: config.lifecycle.pollMs,run: input.runtime.run,now: input.now,receiver: input.executionReceiver }) : undefined;
  const retry = !isWaitingDeployment(config) && config.sourceRetry
    ? createPostgresSourceFactRetry({ ...config.sourceRetry, generationId: config.generationId,
      activatedAt: config.activatedAt, run: input.runtime.run, now: input.now,
      ...(input.authority ? { authority: input.authority } : {}) }) : undefined;
  return async (signal: AbortSignal): Promise<T & { sourceRetry: PostgresSourceFactRetryReport; executionRetry: PostgresExecutionCaptureRetryReport }> => {
    signal.throwIfAborted();
    const wallet = await input.channel.pollOnce(signal);
    signal.throwIfAborted();
    const execution = executionRetry ? await executionRetry.pollOnce(signal) : {
      status: "deferred" as const,reasonCode: "execution_retry_not_configured",scanned: 0,attempted: 0,published: 0,
      deferred: 0,alreadyAvailable: 0,failed: 0,diagnostics: [],diagnosticsDropped: 0 };
    signal.throwIfAborted();
    const sourceRetry: PostgresSourceFactRetryReport = retry ? await retry.pollOnce(signal) : {
      status: "deferred", reasonCode: "source_retry_not_configured", scanned: 0, attempted: 0,
      published: 0, duplicates: 0, deferred: 0, alreadyRecorded: 0, failed: 0,
      diagnostics: [], diagnosticsDropped: 0,
    };
    return { ...wallet, sourceRetry, executionRetry: execution };
  };
}

export interface PostgresRootWalletExecutionConfiguration {
  readonly receiver: Pick<PostgresWalletExecutionReceiverOptions, "maximumCandidates" | "maximumRunMs" | "maximumPayloadBytes">;
  readonly solana?: Omit<PostgresSolanaExecutionProducerOptions, "generationId" | "activatedAt" | "rpc" | "profiles" | "now"> & {
    readonly endpoint: string; readonly rateLimitCooldownMs: number;
  };
  readonly evm?: Readonly<Partial<Record<PostgresEvmExecutionProducerOptions["chain"],
    Omit<PostgresEvmExecutionProducerOptions, "generationId" | "activatedAt" | "chain" | "fetch" | "profiles" | "now">>>>;
}
/** Range discovery shares the approved execution budgets; it grants no execution authority. */
export function createPostgresRootEvmWalletCollector(config: ConfiguredPostgresServiceDeployment,
  chain: Exclude<DiscoveryChain, "solana">, rpc: WalletRpcClient,
  bootstrap?: { readonly generation: string; readonly fromBlock: number }) {
  if (!config.cutover.addressOnly) return createEvmBlockWalletCollector({ rpc, chain });
  if (chain !== "eth" && chain !== "bsc" && chain !== "base") throw new Error("EVM_RANGE_UNSUPPORTED_CHAIN");
  const source = config.walletExecution?.evm?.[chain];
  if (!source) throw new Error("EVM_RANGE_EXECUTION_BUDGET_REQUIRED");
  if (!bootstrap || bootstrap.generation !== config.generationId
    || !Number.isSafeInteger(bootstrap.fromBlock) || bootstrap.fromBlock <= 0) {
    throw new Error("EVM_RANGE_BOOTSTRAP_FLOOR_REQUIRED");
  }
  return createEvmTransferRangeWalletCollector({ chain, rpc, decodeReceipt: decodeEvmTransferRangeReceipt,
    // Requests include discovery, canonical checks and decoder RPC; never bypass the range budget.
    maximumLogs: source.maximumLogs, maximumRequests: source.maximumRpcRequests,
    maximumPayloadBytes: Math.min(source.maximumPayloadBytes, config.wallet.maximumPayloadBytes),
    maximumRunMs: Math.min(source.maximumRunMs, config.wallet.maximumRunMs), rangeSize: 512,
    bootstrap });
}
export type PostgresRootExecutionAuthority = Pick<PostgresWalletExecutionReceiverOptions, "validator" | "publisher">;
export interface PostgresRootPriceConfiguration {
  readonly protocol?: "independent_candle_v1";
  readonly source: Omit<PostgresControlledPriceOptions, "generationId" | "activatedAt" | "fetch" | "now">;
  readonly receiver: Pick<PostgresPriceCandidateReceiverOptions, "maximumCandidates" | "maximumRunMs" | "maximumPayloadBytes">;
  readonly mappings: PostgresPricePublisherOptions["mappings"];
  readonly retry: { readonly maximumSamples: number; readonly maximumRetryEntries: number; readonly maximumMappings: number;
    readonly maximumPayloadBytes: number; readonly maximumRunMs: number; readonly retryDelayMs: number };
}
export interface PostgresRootReportedPriceConfiguration {
  readonly protocol: "approved_reported_market_cap_v1";
  readonly approval: import('./postgres-reported-market-approval.js').ReportedApprovalPin;
  readonly source: { readonly providerId: string; readonly baseUrl: string; readonly sourceApprovalRef: string;
    readonly maximumRunMs: number; readonly maximumPayloadBytes: number; readonly maximumWindowMs: number; readonly maximumMappingAgeMs: number };
  readonly receiver: PostgresRootPriceConfiguration["receiver"];
  readonly mappings: PostgresRootPriceConfiguration["mappings"];
  readonly retry: PostgresRootPriceConfiguration["retry"];
}
export type PostgresRootPriceAuthority = Pick<PostgresPriceCandidateReceiverOptions, "validator" | "publisher">;
export type PostgresRootWriterFencePolicy = WriterFencePolicy & Readonly<{ version: 2; closureTrust: FenceClosureTrust }>;
export interface ConfiguredPostgresServiceDeployment {
  readonly executionFormat?: PostgresExecutionFormat;
  readonly format: 1; readonly operationId: string; readonly generationId: string; readonly activatedAt: number;
  readonly database: string; readonly schema: string; readonly releaseRoot: string;
  readonly cohortId: string;
  readonly cutover: { readonly expected: PostgresRootWriterFencePolicy; readonly addressOnly?: never } |
    { readonly addressOnly: AddressOnlyStartupManifest; readonly expected?: never };
  readonly lifecycle: Readonly<PostgresDispatchBudgets>;
  readonly execution: Readonly<PostgresReleaseLimits>;
  readonly gatewayDeliveryEnabled: false; readonly fomoEnabled: false; readonly fullHistoricalMiningEnabled: false;
  readonly driver: DriverSettings;
  readonly services: Readonly<Record<PostgresBusinessService, {
    readonly username: string; readonly maximumConnections: number; readonly intervalMs: number;
  }>>;
  readonly composition: Omit<PostgresProductionCompositionOptions, "runtime" | "identity" | "generation" | "ownerId" | "adapters" | "now">;
  readonly wallet: Required<Pick<PostgresWalletChannelOptions, "maximumProfiles" | "maximumEvents" | "collectorQuota" | "leaseMs" | "maximumPayloadBytes" | "maximumRunMs">>;
  readonly walletExecution?: PostgresRootWalletExecutionConfiguration;
  readonly sourceRetry?: PostgresRootSourceRetryConfiguration;
  readonly executionRetry?: PostgresRootExecutionRetryConfiguration;
  readonly priceAcquisition?: PostgresRootPriceConfiguration | PostgresRootReportedPriceConfiguration;
  readonly sources: Readonly<Record<string, unknown>> & { readonly mode?: never;
    readonly maximumExecutionFactPayloadBytes?: number; readonly maximumFactResultBytes?: number };
  readonly console: { readonly host: "127.0.0.1" | "::1"; readonly port: number; readonly maximumTraceRows: number };
}
export type WaitingPostgresServiceDeployment = Omit<ConfiguredPostgresServiceDeployment, "sources" | "wallet" | "composition" | "cutover"> & {
  readonly cutover: { readonly addressOnly: AddressOnlyStartupManifest; readonly expected?: never };
  readonly sources: { readonly mode: "waiting_configuration" };
  readonly wallet?: ConfiguredPostgresServiceDeployment["wallet"];
  readonly composition?: ConfiguredPostgresServiceDeployment["composition"];
};
export type PostgresServiceDeployment = ConfiguredPostgresServiceDeployment | WaitingPostgresServiceDeployment;
function isWaitingDeployment(config: PostgresServiceDeployment): config is WaitingPostgresServiceDeployment {
  return config.sources.mode === "waiting_configuration";
}
function requireConfiguredModules(config: PostgresServiceDeployment): asserts config is ConfiguredPostgresServiceDeployment {
  if (isWaitingDeployment(config) || !config.wallet || !config.composition) {
    throw new Error("Complete configured wallet and composition required");
  }
}

export interface ServiceFactPorts {
  readonly profiles: PostgresWalletChannelOptions["profiles"];
  readonly facts: PostgresProductionFactAdapters;
  readonly fetch: FetchLike;
  readonly withRpcDiagnosticContexts?: (contexts: readonly PostgresRpcDiagnosticContext[]) => FetchLike;
  /** Already guarded, credentialed and contract-bound; no global fetch fallback. */
  readonly reportedMarketCapClient?: PostgresReportedMarketCapClient;
  targetedBackfillPoll(input: { readonly signal: AbortSignal; readonly limit: number }): Promise<unknown>;
}
export interface PostgresServiceDependencies {
  /** Preconstructed independent authority. Root never allocates a publisher pool or borrows a six-service writer. */
  readonly executionAuthority?: PostgresRootExecutionAuthority;
  /** Preconstructed source-purpose reader/validated receiver; owns no additional root pool. */
  readonly sourceAuthority?: PostgresSourceFactRetryAuthority;
  readonly priceAuthority?: PostgresRootPriceAuthority;
  /** Trusted native ports only; never loaded from deployment JSON or synthesized from execution authority. */
  readonly nativePriceAuthority?: Omit<PostgresNativePriceAuthorityInput, 'deployment' | 'signal'>;
  readonly nativeReportedMarketCapAuthority?: Omit<import('./postgres-price-authority.js').PostgresNativeReportedMarketCapAuthorityInput, 'deployment' | 'signal'>;
  readonly createRuntime?: typeof createPostgresBusinessRuntime;
  readonly createFactPorts?: (input: {
    readonly runtime: PostgresBusinessRuntime; readonly generationId: string; readonly maximumProfiles: number;
    readonly now: () => number; readonly sources: Readonly<Record<string, unknown>>;
    readonly signal: AbortSignal;
    readonly sourceRpcOrigin?: string;
    readonly sourceRpcContexts?: readonly PostgresRpcDiagnosticContext[];
    readonly onSourceRpcDiagnostic?: (diagnostic: unknown) => void;
  }) => Promise<ServiceFactPorts>;
  readonly addressOnlyEvidence?: AddressOnlyStartupEvidence;
  readonly stopSignal?: AbortSignal;
  readonly notify?: (notice: PostgresServiceLifecycleNotice) => Promise<void>;
}

function positive(value: number, maximum = 2_147_483_647): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Explicit bounded service budget required");
}
function executionKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid explicit execution configuration");
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.some(key => typeof key !== "string" || !Object.hasOwn(descriptors[key]!, "value") || !descriptors[key]!.enumerable
    || !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))) {
    throw new Error("Unknown or missing execution configuration field");
  }
}
function requireRootStartupPolicyV2(policy: PostgresRootWriterFencePolicy): void {
  const version: unknown = policy.version;
  if (version !== 2) throw new Error("V1_AUDIT_ONLY_NO_POSTGRES_CAPABILITY");
  executionKeys(policy.closureTrust, ["authorizationPublicKeyPem", "observerPublicKeyPem", "snapshotPublicKeyPem",
    "independentCompatibilityPublicKeyPem", "expectedBinding", "expectedScopesSha256", "expectedTableNames",
    "expectedRollbackRelease", "expectedRollbackArtifactSha256", "maximumEvidenceAgeMs", "maximumMaintenanceWindowMs"]);
  // Key membership, policy pinning and measured evidence belong to the committed verifier, not this shape check.
}
function priceTime(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))) throw new Error("Invalid price sample time");
  const at = Number(value);
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Invalid price sample time");
  return at;
}
function priceConfigurationTime(value: unknown): number {
  if (typeof value !== "number") throw new Error("Exact numeric price configuration time required");
  return priceTime(value);
}
function priceIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("://")) throw new Error("Explicit price identity required");
}
function validateRootPriceConfiguration(config: ConfiguredPostgresServiceDeployment): void {
  const p = config.priceAcquisition;
  if (p === undefined) return;
  const reported = p.protocol === "approved_reported_market_cap_v1";
  if (p.protocol !== undefined && p.protocol !== "independent_candle_v1" && !reported) throw new Error("Unknown explicit price protocol");
  if (reported) {
    if (!config.cutover.addressOnly) throw new Error("Reported price requires address-only protocol");
    executionKeys(p, ["protocol", "approval", "source", "receiver", "mappings", "retry"]);
    executionKeys(p.approval, ["path", "sha256"]);
    if (typeof p.approval.path !== "string" || !isAbsolute(p.approval.path) || resolve(p.approval.path) !== p.approval.path || !/^[a-f0-9]{64}$/.test(p.approval.sha256)) throw new Error("Pinned dedicated reported approval required");
    executionKeys(p.source, ["providerId", "baseUrl", "sourceApprovalRef", "maximumRunMs", "maximumPayloadBytes", "maximumWindowMs", "maximumMappingAgeMs"]);
    priceIdentity(p.source.sourceApprovalRef);
  } else {
    executionKeys(p, ["source", "receiver", "mappings", "retry"], ["protocol"]);
    executionKeys(p.source, ["providerId", "baseUrl", "timeoutMs", "minimumRequestIntervalMs", "rateLimitCooldownMs", "maximumRunMs",
    "maximumPayloadBytes", "maximumCandles", "maximumWindowMs", "maximumMappingAgeMs", "timeframe", "aggregate"]);
  }
  executionKeys(p.receiver, ["maximumCandidates", "maximumRunMs", "maximumPayloadBytes"]);
  executionKeys(p.retry, ["maximumSamples", "maximumRetryEntries", "maximumMappings", "maximumPayloadBytes", "maximumRunMs", "retryDelayMs"]);
  priceIdentity(p.source.providerId);
  if (typeof p.source.baseUrl !== "string") throw new Error("Explicit price origin required");
  const origin = new URL(p.source.baseUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) throw new Error("Credential-free approved price origin required");
  positive(config.composition.maximumSamples, 1000); positive(config.composition.maximumPayloadBytes);
  positive(config.composition.maximumRunMs, config.lifecycle.pollMs);
  positive(p.retry.maximumSamples, config.composition.maximumSamples); positive(p.retry.maximumRetryEntries, 10000);
  if (p.retry.maximumRetryEntries < p.retry.maximumSamples) throw new Error("Price retry admission smaller than page");
  positive(p.retry.maximumMappings, 1000); positive(p.retry.retryDelayMs);
  positive(p.retry.maximumRunMs, config.lifecycle.pollMs);
  if (p.retry.maximumRunMs + config.composition.maximumRunMs > config.lifecycle.pollMs) throw new Error("Price and composition exceed explicit poll allocation");
  positive(p.retry.maximumPayloadBytes, Math.min(10_000_000, config.composition.maximumPayloadBytes));
  positive(p.receiver.maximumCandidates, 1000);
  if (p.retry.maximumSamples > p.receiver.maximumCandidates) throw new Error("Price page exceeds receiver allocation");
  positive(p.receiver.maximumRunMs, p.retry.maximumRunMs); positive(p.receiver.maximumPayloadBytes, p.retry.maximumPayloadBytes);
  positive(p.source.maximumRunMs, p.receiver.maximumRunMs);
  if (!reported) { positive(p.source.timeoutMs, p.source.maximumRunMs); positive(p.source.rateLimitCooldownMs); } positive(p.source.maximumPayloadBytes, p.receiver.maximumPayloadBytes);
  positive(p.source.maximumWindowMs, Number.MAX_SAFE_INTEGER);
  positive(p.source.maximumMappingAgeMs, Number.MAX_SAFE_INTEGER);
  let candleMs = 0;
  if (!reported) {
  positive(p.source.maximumCandles, 1000); positive(p.source.aggregate);
  priceConfigurationTime(p.source.minimumRequestIntervalMs);
  if (!["minute", "hour", "day"].includes(p.source.timeframe)) throw new Error("Exact price timeframe required");
  candleMs = ({ minute: 60000, hour: 3600000, day: 86400000 })[p.source.timeframe] * p.source.aggregate;
  if (!Number.isSafeInteger(candleMs) || candleMs > p.source.maximumWindowMs) throw new Error("Invalid explicit candle window");
  }
  if (!Array.isArray(p.mappings) || p.mappings.length > p.retry.maximumMappings || reported && p.mappings.length !== 1) throw new Error("Bounded explicit price mappings required");
  for (const pin of p.mappings) {
    executionKeys(pin, ["mapping", "providerId", "mappingApprovalRef", "sourceApprovalRef", "sourceProofKind", "candleMs", "validFrom", "validUntil"], reported ? ["quoteAddress"] : []);
    if (reported && (pin.sourceProofKind !== p.protocol || pin.sourceApprovalRef !== p.source.sourceApprovalRef
      || !("quoteAddress" in pin) || typeof pin.quoteAddress !== "string" || !pin.quoteAddress)) throw new Error("Dedicated reported source mapping required");
    executionKeys(pin.mapping, ["chain", "tokenAddress", "poolAddress", "tokenSide", "network", "evidenceRef", "knownAt"]);
    for (const value of [pin.providerId, pin.mappingApprovalRef, pin.sourceApprovalRef, pin.sourceProofKind,
      pin.mapping.tokenAddress, pin.mapping.poolAddress, pin.mapping.network, pin.mapping.evidenceRef]) priceIdentity(value);
    if (pin.providerId !== p.source.providerId || pin.candleMs !== candleMs || !["solana", "eth", "bsc", "base"].includes(pin.mapping.chain)
      || !["base", "quote"].includes(pin.mapping.tokenSide) || priceConfigurationTime(pin.validUntil) <= priceConfigurationTime(pin.validFrom)) throw new Error("Exact reviewed price mapping scope required");
    priceConfigurationTime(pin.mapping.knownAt);
  }
}

/** Fair bounded retry, not a durable completion/coverage checkpoint. All UOWs finish before external acquisition. */
export function createPostgresRootPriceRetry(input: {
  config: PostgresServiceDeployment; runtime: Pick<PostgresBusinessRuntime, "run">; ports: Pick<ServiceFactPorts, "fetch" | "reportedMarketCapClient">;
  authority?: PostgresRootPriceAuthority; now: () => number; pending: Set<Promise<unknown>>; onTimeout: () => void;
}) {
  if (isWaitingDeployment(input.config)) return undefined;
  validateRootPriceConfiguration(input.config);
  if (!input.config.priceAcquisition) return undefined;
  const p = structuredClone(input.config.priceAcquisition), generationId = input.config.generationId, activatedAt = input.config.activatedAt;
  const reportedProducers = new Map<string, ReturnType<typeof createPostgresReportedMarketCapProducer>>();
  if (p.protocol === "approved_reported_market_cap_v1" && input.ports.reportedMarketCapClient) {
    for (const pin of p.mappings) {
      if (!("quoteAddress" in pin) || typeof pin.quoteAddress !== "string") throw new Error("Reported quote mapping required");
      reportedProducers.set(JSON.stringify(pin.mapping),createPostgresReportedMarketCapProducer({ ...p.source,
        generationId,activatedAt,client:input.ports.reportedMarketCapClient,now:input.now,
        identity:{chain:pin.mapping.chain,token:pin.mapping.tokenAddress,pool:pin.mapping.poolAddress,quote:pin.quoteAddress} }));
    }
  }
  const producer = p.protocol === "approved_reported_market_cap_v1" ? {
    async acquire(request: Parameters<ReturnType<typeof createPostgresReportedMarketCapProducer>["acquire"]>[0]) {
      const bound = reportedProducers.get(JSON.stringify(request.mapping));
      if (!bound) return {status:"deferred" as const,reasonCode:"reported_price_provider_credentials_or_budget_unavailable"};
      return bound.acquire(request);
    }
  } : createPostgresGeckoTerminalPriceProducer({ ...p.source, generationId, activatedAt, fetch: input.ports.fetch, now: input.now });
  const publications = new Set<Promise<PostgresPricePublication>>();
  let publicationFailed = false;
  const nativePublisher = input.authority?.publisher;
  const publisher = nativePublisher ? {
    async publish(request: Parameters<typeof nativePublisher.publish>[0]): Promise<PostgresPricePublication> {
      const work = Promise.resolve().then(() => nativePublisher.publish(request));
      publications.add(work); input.pending.add(work);
      try { return await work; }
      catch (error) { publicationFailed = true; throw error; }
      finally { publications.delete(work); input.pending.delete(work); }
    },
  } : undefined;
  const receiver = createPostgresPriceCandidateReceiver({ ...p.receiver, generationId, producer, now: input.now,
    ...(input.authority?.validator ? { validator: input.authority.validator } : {}), ...(publisher ? { publisher } : {}) });
  let cursor: { createdAt: number; sampleId: string } | null = null, busy = false, lastAsOf = activatedAt;
  const cooldowns = new Map<string, number>();
  return Object.freeze({ async pollOnce(signal: AbortSignal) {
    signal.throwIfAborted();
    if (busy) throw new Error("Root price retry already running");
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    return withPostgresDeadline(async () => {
      busy = true;
      publicationFailed = false;
      try {
        controller.signal.throwIfAborted();
        const asOf = priceTime(input.now());
        if (asOf < lastAsOf) throw new Error("Price retry clock regressed");
        lastAsOf = asOf;
        for (const [key, next] of cooldowns) if (next <= asOf) cooldowns.delete(key);
        const page = await input.runtime.run(tx => tx.query(`SELECT /* root-price-retry-samples */
          s.sample_id,s.generation_id,s.execution_fingerprint,s.chain,s.token_address,s.occurred_at,s.expires_at,s.created_at,
          g.activated_at,r.state AS revision_state,t.original_fingerprint
          FROM forward_purchase_samples s JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
          JOIN forward_economic_trades t ON t.trade_id=s.trade_id AND t.original_fingerprint=s.execution_fingerprint
          JOIN forward_strategy_generations g ON g.generation_id=s.generation_id
          WHERE s.generation_id=$1 AND g.activated_at=$3 AND s.occurred_at>=g.activated_at AND s.occurred_at<$2
            AND s.created_at<=$2 AND r.recorded_at<=$2 AND s.expires_at>$2 AND s.state='observing' AND r.state='original'
            AND s.chain=t.chain AND s.entity_id=r.entity_id AND s.token_address=r.token_address AND s.occurred_at=r.occurred_at
            AND s.chain IN ('solana','eth','bsc','base')
            AND NOT EXISTS(SELECT 1 FROM forward_trade_revisions conflict WHERE conflict.trade_id=s.trade_id
              AND conflict.state='pending_review' AND conflict.recorded_at<=$2)
            AND ($4::bigint IS NULL OR (s.created_at,s.sample_id COLLATE "C")>($4,$5::text COLLATE "C"))
          ORDER BY s.created_at,s.sample_id COLLATE "C" LIMIT $6`,
        [generationId, asOf, activatedAt, cursor?.createdAt ?? null, cursor?.sampleId ?? null, p.retry.maximumSamples]));
        controller.signal.throwIfAborted();
        if (page.rows.length > p.retry.maximumSamples || Buffer.byteLength(JSON.stringify(page.rows)) > p.retry.maximumPayloadBytes) throw new Error("Price retry page exceeded budget");
        const requests: PostgresPriceCandidateRequest[] = [], keys: string[] = [];
        let nextCursor = cursor;
        for (const row of page.rows) {
          priceIdentity(row.sample_id); priceIdentity(row.chain); priceIdentity(row.token_address);
          const boughtAt = priceTime(row.occurred_at), expiresAt = priceTime(row.expires_at), createdAt = priceTime(row.created_at);
          if (row.generation_id !== generationId || priceTime(row.activated_at) !== activatedAt || row.revision_state !== "original"
            || typeof row.execution_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.execution_fingerprint)
            || row.original_fingerprint !== row.execution_fingerprint || boughtAt < activatedAt || boughtAt >= asOf || expiresAt <= asOf || createdAt > asOf
            || !["solana", "eth", "bsc", "base"].includes(row.chain)
            || nextCursor && (createdAt < nextCursor.createdAt || createdAt === nextCursor.createdAt
              && Buffer.compare(Buffer.from(row.sample_id), Buffer.from(nextCursor.sampleId)) <= 0)) throw new Error("Invalid current price sample revision");
          nextCursor = { createdAt, sampleId: row.sample_id };
          const windowEnd = boughtAt + p.source.maximumWindowMs;
          if (!Number.isSafeInteger(windowEnd)) throw new Error("Unsafe price observation window");
          const pins = p.mappings.filter(pin => pin.mapping.chain === row.chain && pin.mapping.tokenAddress === row.token_address);
          const pin = pins.length === 1 && pins[0]!.validFrom <= asOf && asOf < pins[0]!.validUntil
            && pins[0]!.mapping.knownAt <= asOf && asOf - pins[0]!.mapping.knownAt <= p.source.maximumMappingAgeMs ? pins[0] : undefined;
          const key = JSON.stringify([generationId, row.sample_id, row.execution_fingerprint, p.source.providerId,
            pin ?? "approved-mapping-unavailable", boughtAt, Math.min(expiresAt, windowEnd)]);
          if (cooldowns.has(key) || cooldowns.size + keys.length >= p.retry.maximumRetryEntries) continue;
          keys.push(key);
          requests.push({ generationId, sampleId: row.sample_id, executionFingerprint: row.execution_fingerprint, boughtAt,
            until: Math.min(asOf, expiresAt, windowEnd), ...(pin ? { mapping: pin.mapping } : {}) });
        }
        if (Buffer.byteLength(JSON.stringify(requests)) > p.retry.maximumPayloadBytes) throw new Error("Price retry requests exceeded budget");
        const result = requests.length ? await receiver.receive({ requests, signal: controller.signal }) : { published: 0, duplicates: 0, results: [] };
        // Receiver deadlines cannot acknowledge a native commit whose completion is still unknown.
        if (publications.size || publicationFailed) {
          await Promise.allSettled([...publications]);
          throw new Error("PRICE_PUBLICATION_COMPLETION_UNCERTAIN");
        }
        controller.signal.throwIfAborted();
        const completedAt = priceTime(input.now()), nextAttemptAt = completedAt + p.retry.retryDelayMs;
        if (completedAt < asOf || !Number.isSafeInteger(nextAttemptAt)) throw new Error("Invalid price retry completion clock");
        for (const key of keys) cooldowns.set(key, nextAttemptAt);
        cursor = page.rows.length ? nextCursor : null;
        return { ...result, sampled: page.rows.length, requested: requests.length, scanWrapped: page.rows.length === 0,
          durableCheckpoint: false as const, coverageVerified: false as const, gatewayDeliveryEnabled: false as const };
      } finally { busy = false; controller.abort(); signal.removeEventListener("abort", abort); }
    }, { maximumMs: p.retry.maximumRunMs, signal, pending: input.pending, onTimeout: () => { controller.abort(); input.onTimeout(); } });
  } });
}
function validateRootWalletExecution(config: ConfiguredPostgresServiceDeployment): void {
  const value = config.walletExecution;
  if (value === undefined) return;
  executionKeys(value, ["receiver"], ["solana", "evm"]);
  executionKeys(value.receiver, ["maximumCandidates", "maximumRunMs", "maximumPayloadBytes"]);
  positive(value.receiver.maximumCandidates, Math.min(1000, config.wallet.maximumEvents));
  positive(value.receiver.maximumRunMs, config.wallet.maximumRunMs);
  positive(value.receiver.maximumPayloadBytes, Math.min(10_000_000, config.wallet.maximumPayloadBytes));
  const text = (value: unknown) => { if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error("Explicit execution source pin required"); };
  const budgets = (source: { maximumProfiles: number; maximumRunMs: number; maximumPayloadBytes: number }) => {
    positive(source.maximumProfiles, config.wallet.maximumProfiles);
    positive(source.maximumRunMs, value.receiver.maximumRunMs);
    positive(source.maximumPayloadBytes, value.receiver.maximumPayloadBytes);
  };
  if (value.solana !== undefined) {
    executionKeys(value.solana, ["providerId", "expectedGenesisHash", "endpoint", "rateLimitCooldownMs", "maximumProfiles", "maximumRunMs", "maximumPayloadBytes"]);
    for (const pin of [value.solana.providerId, value.solana.expectedGenesisHash, value.solana.endpoint]) text(pin);
    positive(value.solana.rateLimitCooldownMs); budgets(value.solana);
  }
  if (value.evm !== undefined) {
    executionKeys(value.evm, [], ["eth", "bsc", "base"]);
    if (Object.keys(value.evm).length === 0) throw new Error("Explicit EVM registry required");
    for (const source of Object.values(value.evm)) {
      executionKeys(source, ["providerId", "expectedChainId", "expectedGenesisBlockHash", "endpoint", "stableQuoteTokens", "maximumProfiles",
        "maximumLogs", "maximumDecimalsReads", "maximumRpcRequests", "maximumRunMs", "maximumPayloadBytes"]);
      for (const pin of [source.providerId, source.expectedChainId, source.expectedGenesisBlockHash, source.endpoint]) text(pin);
      budgets(source); positive(source.maximumLogs, 10000); positive(source.maximumDecimalsReads, 1000); positive(source.maximumRpcRequests, 10000);
      if (!Array.isArray(source.stableQuoteTokens) || !source.stableQuoteTokens.length || source.stableQuoteTokens.length > 2) throw new Error("Explicit bounded stable quote mapping required");
      for (const token of source.stableQuoteTokens) {
        executionKeys(token, ["address", "symbol"]); text(token.address);
        if (token.symbol !== "USDC" && token.symbol !== "USDT") throw new Error("Explicit nominal stable quote required");
      }
    }
  }
  if (value.solana === undefined && value.evm === undefined) throw new Error("Explicit execution producer registry required");
}

/** Acquisition wiring only. Startup authorization remains the committed cutover gate. */
const rootExecutionDiagnosticReasons = new Set([
  ...POSTGRES_EXECUTION_ACQUISITION_TRANSPORT_REASONS,
  "unsupported_or_wrong_generation_capture", "execution_producer_unavailable_for_chain",
  "solana_execution_not_explicitly_configured", "independent_validator_or_publisher_unavailable",
  "execution_validation_or_publication_unavailable", "receiver_aborted_or_timed_out", "producer_busy",
  "producer_aborted_or_timed_out", "execution_acquisition_unavailable", "rpc_payload_missing",
  "capture_generation_or_chain_mismatch", "outside_forward_generation", "execution_reference_missing",
  "execution_reference_invalid", "profile_cohort_unavailable", "profile_cohort_overflow",
  "current_wallet_owner_unavailable", "execution_payload_budget_exceeded", "rpc_chain_identity_mismatch",
  "signature_status_missing", "execution_not_finalized", "execution_transaction_mismatch", "execution_time_mismatch",
  "canonical_block_membership_missing", "capture_block_mismatch", "actual_trade_basis_unavailable",
  "capture_execution_quantities_mismatch", "capture_execution_basis_mismatch", "producer_clock_regressed",
  "profile_changed_during_acquisition", "nominal_execution_purchase_unavailable", "capture_purchase_mismatch",
  "validator_busy", "validator_aborted_or_timed_out", "validator_clock_or_deadline", "validator_candidate_binding_mismatch",
  "validator_candidate_clock_or_fingerprint", "validator_candidate_chain_pin_mismatch", "validator_rpc_request_budget",
  "validator_rpc_redirect_refused", "validator_rpc_body_missing", "validator_rpc_content_budget",
  "validator_independent_replay_mismatch", "validator_replay_unavailable",
]);

/** Log only closed-set codes. Never log payloads, signatures, endpoints or exception text. */
export function createPostgresRootWalletExecutionVerifier(receiver: {
  verifyPurchase: NonNullable<PostgresWalletChannelOptions["verifyPurchase"]>;
}): NonNullable<PostgresWalletChannelOptions["verifyPurchase"]> {
  return async input => {
    const result = await receiver.verifyPurchase(input);
    if (result.status === "deferred") {
      const chain = input.event.chain;
      try {
        console.error(JSON.stringify({ event: "postgres_wallet_execution_deferred",
          chain: chain === "solana" || chain === "eth" || chain === "bsc" || chain === "base" ? chain : "other",
          reasonCode: rootExecutionDiagnosticReasons.has(result.reasonCode) ? result.reasonCode : "execution_proof_unavailable" }));
      } catch { /* Diagnostics must not change capture or publication semantics. */ }
    }
    return result;
  };
}

/** Revalidate the observer boundary and reconstruct the exact safe log shape. */
export function logPostgresRootExecutionRpcDiagnostic(diagnostic: unknown, sink: (line: string) => void = line => console.error(line), purpose?: "source" | "replay"): void {
  try {
    if (!diagnostic || typeof diagnostic !== "object" || utilTypes.isProxy(diagnostic) || Array.isArray(diagnostic)) return;
    const descriptors = ["method","code","subcategory","reasonCode"].map(key => Object.getOwnPropertyDescriptor(diagnostic,key));
    if (descriptors.some(descriptor => descriptor === undefined || !("value" in descriptor))) return;
    const [method,rawCode,subcategory,reasonCode] = descriptors.map(descriptor => descriptor!.value as unknown);
    if (typeof method !== "string" || typeof subcategory !== "string" || typeof reasonCode !== "string"
      || !POSTGRES_EXECUTION_RPC_METHODS.some(allowed => allowed === method)
      || !POSTGRES_EXECUTION_RPC_SUBCATEGORIES.some(allowed => allowed === subcategory)
      || !POSTGRES_EXECUTION_ACQUISITION_TRANSPORT_REASONS.some(allowed => allowed === reasonCode)) return;
    const code = typeof rawCode === "number" && Number.isSafeInteger(rawCode) ? rawCode : null;
    const details: Record<string,string | number> = {};
    for (const [key,allowed] of [["purpose",["source","replay"]], ["budgetReason",POSTGRES_PROVIDER_BUDGET_REASONS],
      ["transport",["local","http","rpc","unknown"]]] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(diagnostic,key);
      if (!descriptor) { if (key in diagnostic) return; continue; }
      if (!("value" in descriptor)) return;
      const value: unknown = descriptor.value;
      if (typeof value !== "string" || !allowed.some(item => item === value)) return;
      details[key] = value;
    }
    for (const key of ["chain","providerId","httpStatus","retryAt"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(diagnostic,key);
      if (!descriptor) { if (key in diagnostic) return; continue; }
      if (!("value" in descriptor)) return;
      const value: unknown = descriptor.value;
      if (key === "chain") {
        if (typeof value !== "string" || !["solana","eth","bsc","base"].includes(value)) return;
      } else if (key === "providerId") {
        if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) return;
      } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (key === "httpStatus" ? 100 : 0)
        || (key === "httpStatus" && value > 599)) return;
      details[key] = value;
    }
    if (details.chain === undefined && method.startsWith("eth_")) return;
    if (details.chain !== undefined && (method.startsWith("eth_") === (details.chain === "solana"))) return;
    if (purpose !== undefined) details.purpose = purpose;
    sink(JSON.stringify({ event: "postgres_wallet_execution_rpc_failure",chain: details.chain ?? "solana",method,code,subcategory,reasonCode,...details }));
  } catch { /* Diagnostics must not change capture, retry, budget or publication semantics. */ }
}

/** One runtime observer: bounded unique closed diagnostics per minute, never raw objects. */
export function createPostgresRootExecutionRpcDiagnosticLogger() {
  let windowStart = Date.now();
  const seen = new Set<string>();
  return (diagnostic: unknown,purpose?: "source" | "replay") => logPostgresRootExecutionRpcDiagnostic(diagnostic,line => {
    const at = Date.now();
    if (at - windowStart >= 60_000) { seen.clear(); windowStart = at; }
    if (seen.has(line) || seen.size >= 32) return;
    seen.add(line); console.error(line);
  },purpose);
}

/** Called only with the existing validated deployment. Endpoint material stays inside transport binding. */
export function postgresRootSourceRpcDiagnosticContexts(config: PostgresServiceDeployment): readonly PostgresRpcDiagnosticContext[] {
  if (isWaitingDeployment(config) || !config.walletExecution) return [];
  const contexts: PostgresRpcDiagnosticContext[] = [];
  for (const chain of ["solana","eth","bsc","base"] as const) {
    const source = chain === "solana" ? config.walletExecution.solana : config.walletExecution.evm?.[chain];
    if (source) contexts.push({ chain,providerId: source.providerId,endpoint: source.endpoint,purpose: "source" });
  }
  return contexts;
}

/** CLI authority invokes this after its existing source/replay and durable ledger validation. */
export function postgresRootReplayRpcDiagnosticFetch(options: PostgresIndependentExecutionValidatorOptions,
  ports: Pick<ServiceFactPorts,"fetch" | "withRpcDiagnosticContexts">): FetchLike {
  return ports.withRpcDiagnosticContexts?.(options.reviewedProviderBindings.map(binding => ({
    chain: binding.chain,providerId: binding.replayProviderId,endpoint: binding.replayEndpoint,purpose: "replay" as const,
  }))) ?? ports.fetch;
}

export function createPostgresRootWalletExecutionReceiver(input: {
  config: PostgresServiceDeployment; ports: Pick<ServiceFactPorts, "fetch" | "profiles">;
  authority?: PostgresRootExecutionAuthority; now: () => number;
  onRpcDiagnostic?: (diagnostic: unknown) => void;
}) {
  if (isWaitingDeployment(input.config)) return undefined;
  validateRootWalletExecution(input.config);
  const settings = input.config.walletExecution;
  if (!settings) return undefined;
  const shared = { generationId: input.config.generationId, activatedAt: input.config.activatedAt, profiles: input.ports.profiles, now: input.now };
  const producer = settings.solana ? createPostgresSolanaExecutionProducer({ ...settings.solana, ...shared,
    onRpcDiagnostic: diagnostic => (input.onRpcDiagnostic ?? logPostgresRootExecutionRpcDiagnostic)({ ...diagnostic,purpose: "source" }),
    rpc: createConfiguredWalletRpcClient({ endpoints: { solana: { primary: settings.solana.endpoint } }, fetch: input.ports.fetch,
      rateLimitCooldownMs: settings.solana.rateLimitCooldownMs }) }) : {
      async acquire() { return { status: "deferred" as const, reasonCode: "solana_execution_not_explicitly_configured" }; },
    };
  const producers: Partial<Record<PostgresEvmExecutionProducerOptions["chain"], ReturnType<typeof createPostgresEvmExecutionProducer>>> = {};
  for (const chain of ["eth", "bsc", "base"] as const) {
    const source = settings.evm?.[chain];
    if (source) producers[chain] = createPostgresEvmExecutionProducer({ ...source, ...shared, chain, fetch: input.ports.fetch });
  }
  const evmProducer = Object.keys(producers).length ? createPostgresEvmExecutionDispatcher({ generationId: shared.generationId, producers }) : undefined;
  return createPostgresWalletExecutionReceiver({ ...settings.receiver, generationId: shared.generationId, now: input.now, producer,
    ...(evmProducer ? { evmProducer } : {}), ...(input.authority?.validator ? { validator: input.authority.validator } : {}),
    ...(input.authority?.publisher ? { publisher: input.authority.publisher } : {}) });
}
export type LegacyPostgresServiceDeployment = Omit<ConfiguredPostgresServiceDeployment, "cutover"> & {
  readonly cutover: { readonly expected: PostgresRootWriterFencePolicy; readonly addressOnly?: never };
};
export function validatePostgresServiceDeployment(value: { cutover: { expected: unknown } }, env?: ServiceEnvironment): LegacyPostgresServiceDeployment;
export function validatePostgresServiceDeployment(value: unknown, env?: ServiceEnvironment): PostgresServiceDeployment;
export function validatePostgresServiceDeployment(value: unknown, env: ServiceEnvironment = {}): PostgresServiceDeployment {

  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PostgreSQL service deployment");
  const config = value as PostgresServiceDeployment;
  if (config.format !== 1 || !config.operationId || !config.generationId || !config.database || !config.schema
    || !Number.isSafeInteger(config.activatedAt) || config.activatedAt < 0
    || config.gatewayDeliveryEnabled !== false || config.fomoEnabled !== false || config.fullHistoricalMiningEnabled !== false
    || !config.driver || !config.services || !config.sources
    || typeof config.cohortId !== "string" || !config.cohortId.trim()
    || !config.cutover || !config.lifecycle || !config.execution) {
    throw new Error("Incomplete PostgreSQL service deployment");
  }
  const modes = Object.keys(config.cutover);
  if (modes.length !== 1) throw new Error("Exactly one PostgreSQL startup protocol required");
  readPostgresExecutionFormat(config, env);
  if (config.cutover.addressOnly !== undefined) {
    const manifest = validateAddressOnlyStartupManifest(config.cutover.addressOnly);
    if (manifest.operationId !== config.operationId || manifest.generationId !== config.generationId
      || manifest.importId !== config.cohortId || manifest.activatedAt !== config.activatedAt
      || manifest.target.database !== config.database || manifest.target.schema !== config.schema) {
      throw new Error("Address-only deployment binding mismatch");
    }
  } else {
    if (!config.cutover.expected) throw new Error("Incomplete PostgreSQL service deployment");
    requireRootStartupPolicyV2(config.cutover.expected);
  }

  if (Object.hasOwn(config.sources, "mode")) {
    executionKeys(config.sources, ["mode"]);
    if (config.sources.mode !== "waiting_configuration" || config.cutover.addressOnly === undefined) {
      throw new Error("Explicit address-only waiting configuration required");
    }
  }
  if (!isWaitingDeployment(config)) {
    requireConfiguredModules(config);
    if (Object.hasOwn(config.sources,"maximumExecutionFactPayloadBytes") || Object.hasOwn(config.sources,"maximumFactResultBytes")) {
      const single = config.sources.maximumExecutionFactPayloadBytes, page = config.sources.maximumFactResultBytes;
      if (typeof single !== "number" || typeof page !== "number") throw new Error("Paired explicit execution fact budgets required");
      positive(single,2_097_152); positive(page,2_097_152);
      positive(config.composition.maximumPayloadBytes);
      positive(config.composition.factLimit,1000);
      if (single > page || page > config.composition.maximumPayloadBytes) {
        throw new Error("Execution fact page exceeds explicit composition memory budget");
      }
    }
    if (config.cutover.addressOnly !== undefined) {
    const composition = config.composition;
    for (const value of [composition.maximumRunMs, composition.leaseMs, composition.retryDelayMs,
      composition.maximumPayloadBytes, composition.reconcileIntervalMs]) positive(value);
    for (const value of [composition.maximumClaims, composition.admissionLimit, composition.maximumSamples, composition.factLimit]) positive(value, 1000);
    if (composition.maximumRunMs > config.lifecycle.pollMs || !composition.quotas || !composition.principal
      || typeof composition.principal.actorId !== "string" || !composition.principal.actorId.trim()
      || typeof composition.principal.authorizationEvidenceRef !== "string" || !composition.principal.authorizationEvidenceRef.trim()
      || !Array.isArray(composition.principal.permissions) || !composition.principal.permissions.includes("target_registry_write")) {
      throw new Error("Explicit reviewed composition configuration required");
    }
    let claims = 0;
    for (const stage of ["normalization", "token", "purchase", "fanout", "opportunity", "capability", "signal"] as const) {
      positive(composition.quotas[stage], 1000); claims += composition.quotas[stage];
    }
    if (claims > composition.maximumClaims) throw new Error("Composition claim allocation exceeded");
    }
  }
  if (Object.keys(config.services).length !== POSTGRES_BUSINESS_SERVICES.length) throw new Error("Complete six-service budget required");
  const roles = new Set<string>();
  for (const name of POSTGRES_BUSINESS_SERVICES) {
    const service = config.services[name];
    if (!service || typeof service.username !== "string" || !service.username.trim() || roles.has(service.username)) throw new Error("Distinct six-service roles required");
    roles.add(service.username); positive(service.maximumConnections, 64); positive(service.intervalMs);
    if (config.driver.serviceConnectionBudgets[name] !== service.maximumConnections) throw new Error("Global service pool allocation mismatch");
  }
  if (!isWaitingDeployment(config)) {
  for (const budget of [config.wallet.maximumProfiles, config.wallet.maximumEvents, config.wallet.collectorQuota,
    config.wallet.leaseMs, config.wallet.maximumPayloadBytes, config.wallet.maximumRunMs]) positive(budget);
  if (config.wallet.maximumRunMs > config.lifecycle.pollMs) throw new Error("Wallet run exceeds explicit poll deadline");
  validateRootSourceRetry(config);
  validateRootWalletExecution(config);
  validateRootExecutionRetry(config);
  validateRootPriceConfiguration(config);
  }
  for (const budget of [config.lifecycle.startupMs, config.lifecycle.pollMs, config.lifecycle.shutdownMs, config.lifecycle.killMs]) positive(budget, 60_000);
  positive(config.execution.maximumEntries, Number.MAX_SAFE_INTEGER); positive(config.execution.maximumBytes, Number.MAX_SAFE_INTEGER);
  if (!config.console || !["127.0.0.1", "::1"].includes(config.console.host)) throw new Error("Console must remain loopback-only");
  positive(config.console.port, 65535); positive(config.console.maximumTraceRows, 1000);
  return config;
}

const workerStages = {
  scanner: ["token"], automation: ["normalization", "purchase", "fanout", "signal"],
  "wallet-analysis": ["opportunity", "capability"],
} as const;

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve(); };
    const timer = setTimeout(stop, milliseconds); signal.addEventListener("abort", stop, { once: true });
  });
}

export async function readPostgresServiceProgress(
  transaction: Parameters<typeof readPostgresGenerationProgress>[0],
  input: Parameters<typeof readPostgresGenerationProgress>[1],
) {
  const progress = await readPostgresGenerationProgress(transaction, input);
  return { ...progress, sampledAt: progress.asOf, legacyTotalsIncluded: false as const };
}

const consoleClosures = new WeakMap<Server, Promise<void>>();

async function startConsole(runtime: PostgresBusinessRuntime, config: PostgresServiceDeployment, signal: AbortSignal,
  pending: Set<Promise<unknown>>): Promise<Server> {
  if (signal.aborted) throw new Error("POSTGRES_OPERATION_ABORTED");
  const server = createServer((request, response) => {
    const task = (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      if (request.method !== "GET") { response.writeHead(405); response.end('{"error":"read_only_console"}'); return; }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const assets: Readonly<Record<string, readonly [string, string]>> = {
        "/": ["postgres.html", "text/html; charset=utf-8"],
        "/postgres.css": ["postgres.css", "text/css; charset=utf-8"],
        "/postgres.js": ["postgres.js", "text/javascript; charset=utf-8"],
      };
      const asset = assets[url.pathname];
      if (asset) {
        const body = await readFile(join(config.releaseRoot, "apps", "console", "public", asset[0]));
        response.setHeader("Content-Type", asset[1]);
        response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
        response.setHeader("X-Content-Type-Options", "nosniff"); response.end(body); return;
      }
      if (url.pathname === "/healthz") {
        response.end(JSON.stringify({ backend: "postgresql", generationId: config.generationId, gatewayDeliveryEnabled: false })); return;
      }
      if (url.pathname === "/api/v2/operations/forward-trace") {
        const entityId = url.searchParams.get("entityId");
        if (!entityId || entityId.length > 512) { response.writeHead(400); response.end('{"error":"entity_id_required"}'); return; }
        const trace = await runtime.run(transaction => readPostgresForwardTrace(transaction, {
          generationId: config.generationId, entityId, asOf: Date.now(), limit: config.console.maximumTraceRows, after: null,
        })); response.end(JSON.stringify(trace)); return;
      }
      if (url.pathname === "/api/v2/operations/closed-loop") {
        const progress = await runtime.run(transaction => readPostgresServiceProgress(transaction, {
          generationId: config.generationId, asOf: Date.now(),
        }));
        response.end(JSON.stringify(progress)); return;
      }
      response.writeHead(404); response.end('{"error":"legacy_route_not_available_on_postgres"}');
    })().catch(() => { if (!response.headersSent) response.writeHead(503); response.end('{"error":"postgres_read_unavailable"}'); });
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  });
  consoleClosures.set(server, new Promise(resolve => server.once("close", resolve)));
  const stop = () => { server.closeAllConnections(); server.close(); };
  signal.addEventListener("abort", stop, { once: true });
  server.once("close", () => signal.removeEventListener("abort", stop));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(config.console.port, config.console.host, () => {
      server.removeListener("error", reject);
      if (signal.aborted) { stop(); reject(new Error("POSTGRES_OPERATION_ABORTED")); }
      else resolve();
    });
  });
  return server;
}

export async function verifyPostgresServiceStartup(input: {
  service: PostgresBusinessService; config: PostgresServiceDeployment;
  runtime: PostgresBusinessRuntime; identity: Awaited<ReturnType<PostgresBusinessRuntime["probe"]>>;
  releaseSha256: string; deadline: string; signal?: AbortSignal;
  addressOnlyEvidence?: AddressOnlyStartupEvidence;
}) {
  const { config, identity } = input;
  if (config.cutover.addressOnly !== undefined) {
    const manifest = validateAddressOnlyStartupManifest(config.cutover.addressOnly);
    const evidence = input.addressOnlyEvidence;
    if (!evidence || manifest.operationId !== config.operationId || manifest.importId !== config.cohortId
      || manifest.generationId !== config.generationId || manifest.activatedAt !== config.activatedAt
      || manifest.target.database !== config.database || manifest.target.schema !== config.schema
      || evidence.operationId !== config.operationId || evidence.importId !== manifest.importId
      || evidence.generationId !== config.generationId || evidence.releaseSha256 !== input.releaseSha256
      || evidence.sourceSealed !== true || evidence.importCommitted !== true
      || config.gatewayDeliveryEnabled !== false || config.fomoEnabled !== false || config.fullHistoricalMiningEnabled !== false) {
      throw new Error("ADDRESS_ONLY_NATIVE_STARTUP_REQUIRED");
    }
    return verifyAddressOnlyCommittedStartup({ manifest, runtime: input.runtime, identity,
      releaseSha256: input.releaseSha256, backupSha256: evidence.backupSha256, fenceSha256: evidence.fenceSha256,
      disabledFlags: evidence, deadline: input.deadline, ...(input.signal ? { signal: input.signal } : {}) });
  }
  const expected = config.cutover.expected;
  if (!expected) throw new Error("Incomplete PostgreSQL service deployment");

  requireRootStartupPolicyV2(expected);
  const originalTarget = expected.binding?.target;
  // Choose by the sealed executable identity, never by a submitted or configured phase.
  const target = originalTarget?.releaseSha256 === input.releaseSha256 ? originalTarget : expected.binding?.rollbackTarget;
  if (!target || expected.evidenceMode !== "production-observation"
    || target.database !== config.database || target.schema !== config.schema
    || target.generation !== config.generationId || expected.binding.generation !== config.generationId
    || expected.binding.cohortId !== config.cohortId || target.releaseSha256 !== input.releaseSha256
    || identity.database !== target.database || identity.schema !== target.schema
    || identity.generation !== target.generation || identity.schemaFingerprint !== target.schemaSha256
    || identity.serverAddress !== target.serverAddress || identity.serverPort !== target.serverPort) {
    throw new Error("POSTGRES_COMMITTED_RUNTIME_IDENTITY_REQUIRED");
  }
  const clock = () => new Date().toISOString();
  const store = createReadOnlyCutoverStartupStore({ runtime: input.runtime, target, clock });
  const options = { expected, runtime: { target, cohortId: config.cohortId },
    store, clock, deadline: input.deadline, ...(input.signal ? { signal: input.signal } : {}) };
  const selection = input.service === "console" ? await verifyCommittedPostgresCutover(options)
    : await verifyCommittedPostgresWriterStartup(options);
  if (selection.protocolVersion !== 2 || typeof selection.closureSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(selection.closureSha256)) throw new Error("COMMITTED_POSTGRES_V2_CLOSURE_REQUIRED");
  if (selection.evidenceMode !== "production-observation" || selection.activationEnabled !== false
    || selection.writeAuthorized !== false) throw new Error("POSTGRES_SELECTION_IS_NOT_WRITE_AUTHORITY");
  if (input.service === "console" && !["postgres-selected", "postgres-written", "postgres-rollback-selected"].includes(selection.phase)) {
    throw new Error("COMMITTED_POSTGRES_READ_ONLY_PHASE_REQUIRED");
  }
  if (input.service !== "console") {
    if (!["postgres-written", "postgres-rollback-selected"].includes(selection.phase) || selection.firstPostgresWrite === null
      || selection.firstPostgresWrite === undefined) throw new Error("COMMITTED_POSTGRES_FIRST_WRITE_REQUIRED");
    // Consume the dedicated writer verifier, not selection.writeAuthorized or a configuration boolean.
    const proof = selection.rollbackReadiness;
    if (!proof || proof.strategy !== "compatible-postgres-release" || proof.recoveryMode !== "retain-live-postgres-data"
      || proof.mutableJournalVerified !== false || !/^[a-f0-9]{64}$/.test(proof.catalogSha256)
      || !/^[a-f0-9]{64}$/.test(proof.proofSha256) || !Array.isArray(selection.writerStartupBlockers)
      || selection.writerStartupBlockers.length !== 0
      || (["database", "schema", "schemaSha256", "releaseSha256", "generation", "serverAddress", "serverPort", "systemIdentifier"] as const)
        .some(key => proof.target[key] !== expected.binding.rollbackTarget[key])) {
      throw new Error("VERIFIED_POSTGRES_WRITER_STARTUP_REQUIRED");
    }
  }
  return selection;
}

async function sendLifecycleNotice(notice: PostgresServiceLifecycleNotice): Promise<void> {
  if (!process.send || !process.connected) throw new Error("PostgreSQL dispatcher IPC required");
  await new Promise<void>((resolve, reject) => process.send!(notice, error => error ? reject(error) : resolve()));
}

/** Closed reason vocabulary only; never serialize native messages, SQL, URLs or stacks. */
export function classifyPostgresServiceFailure(error: unknown): string {
  const messages: Readonly<Record<string, string>> = {
    POSTGRES_OPERATION_DEADLINE_EXCEEDED: 'operation_deadline_exceeded',
    POSTGRES_OPERATION_ABORTED: 'operation_aborted',
    POSTGRES_SHUTDOWN_DRAIN_NOT_VERIFIED: 'shutdown_drain_not_verified',
    'PostgreSQL business pending operation budget exhausted': 'pending_operation_budget_exhausted',
    'PostgreSQL business runtime is closing or closed': 'runtime_closing_or_closed',
    'PostgreSQL dispatcher IPC required': 'dispatcher_ipc_unavailable',
  };
  if (error instanceof Error && Object.hasOwn(messages, error.message)) return messages[error.message]!;
  const codes: Readonly<Record<string, string>> = {
    '42501': 'pg_insufficient_privilege', '57014': 'pg_query_cancelled', '55P03': 'pg_lock_unavailable',
    '53300': 'pg_too_many_connections', '40001': 'pg_serialization_failure', '40P01': 'pg_deadlock',
    '42P01': 'pg_undefined_table', '42703': 'pg_undefined_column', '23505': 'pg_unique_violation',
    '23503': 'pg_foreign_key_violation', '25P02': 'pg_transaction_aborted',
    '08006': 'pg_connection_failure', '57P01': 'pg_admin_shutdown',
  };
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' && Object.hasOwn(codes, code) ? codes[code]! : 'unclassified_failure';
}
function reportPostgresServiceFailure(service: PostgresBusinessService, phase: string, error: unknown): void {
  process.stderr.write(JSON.stringify({ event: 'postgres_service_failure', service, phase,
    reasonCode: classifyPostgresServiceFailure(error) }) + '\n');
}

/** No DDL, import, generation creation, historical seeding, or delivery occurs here. */
export async function runPostgresServiceEntrypoint(service: PostgresBusinessService, env: ServiceEnvironment,
  dependencies: PostgresServiceDependencies = {}): Promise<void> {
  if (!POSTGRES_BUSINESS_SERVICES.includes(service)) throw new Error("Unknown PostgreSQL service");
  const budgets = readPostgresServiceBudgets(env);
  if (!/^[a-f0-9]{32}$/.test(env.ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE ?? "")) throw new Error("Pinned dispatcher launch identity required");
  const controller = new AbortController();
  let externalStop = false, operationFailed = false, ready = false;
  const onStop = () => { externalStop = true; controller.abort(); };
  dependencies.stopSignal?.addEventListener("abort", onStop, { once: true });
  if (dependencies.stopSignal?.aborted) onStop();
  process.once("SIGINT", onStop); process.once("SIGTERM", onStop);
  const pending = new Set<Promise<unknown>>();
  let runtime: PostgresBusinessRuntime | undefined, consoleServer: Server | undefined;
  let cliAuthority: Awaited<ReturnType<typeof import('./postgres-service-cli-authority.js')['createPostgresCliExecutionAuthority']>> | undefined;
  let cliPriceAuthority: Awaited<ReturnType<typeof import('./postgres-reported-price-cli-authority.js')['createPostgresCliReportedPriceAuthority']>> | undefined;
  let lifecycleIdentity: Omit<PostgresServiceLifecycleNotice, "type"> | undefined;
  const notify = dependencies.notify ?? sendLifecycleNotice;
  const active = () => { if (controller.signal.aborted) throw new Error("POSTGRES_OPERATION_ABORTED"); };
  const rejectWork = () => { operationFailed = true; };
  let phase = 'startup';
  const startupDeadline = Date.now() + budgets.startupMs;
  try {
    const poll = await withPostgresDeadline(async () => {
      const config = validatePostgresServiceDeployment(await readPrivatePostgresDeployment(env), env); active();
      for (const key of ["startupMs", "pollMs", "shutdownMs", "killMs"] as const) {
        if (config.lifecycle[key] !== budgets[key]) throw new Error("Pinned PostgreSQL lifecycle allocation mismatch");
      }
      const sealed = await verifyPostgresServiceRelease(config, env, controller.signal); active();
      lifecycleIdentity = { service, operationId: config.operationId, generationId: config.generationId,
        releaseSha256: sealed.releaseSha256, nonce: env.ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE! };
      const selected = config.services[service];
      const currentRuntime = (dependencies.createRuntime ?? createPostgresBusinessRuntime)({ ...config.driver,
        connectionString: env.ADDRESS_RADAR_POSTGRES_URL!, target: { database: config.database, username: selected.username,
          schema: config.schema, generation: config.generationId, service },
        maximumConnections: selected.maximumConnections, access: service === "console" ? "read" : "runtime" });
      runtime = currentRuntime;
      const identity = await currentRuntime.probe(); active();
      const addressOnlyEvidence = config.cutover.addressOnly === undefined ? undefined
        : dependencies.addressOnlyEvidence ?? await readAddressOnlyStartupEvidence(env, config.cutover.addressOnly, controller.signal);
      active();
      await verifyPostgresServiceStartup({ service, config, runtime: currentRuntime, identity,
        ...(addressOnlyEvidence ? { addressOnlyEvidence } : {}),

        releaseSha256: sealed.releaseSha256,
        deadline: new Date(Math.min(startupDeadline, Date.now() + (config.cutover.expected?.deadlines.maximumOperationMs ?? config.lifecycle.startupMs))).toISOString(),
        signal: controller.signal }); active();
      const generation = await currentRuntime.run(transaction => transaction.query(
        "SELECT activated_at FROM forward_strategy_generations WHERE generation_id=$1", [config.generationId])); active();
      if (generation.rows.length !== 1 || Number(generation.rows[0]!.activated_at) !== config.activatedAt
        || config.activatedAt > Date.now()) throw new Error("Approved generation has not been installed");
      if (service === "console") {
        consoleServer = await startConsole(currentRuntime, config, controller.signal, pending); active();
        return { config, execute: null };
      }
      if (isWaitingDeployment(config)) {
        return { config, execute: async (signal: AbortSignal) => {
          signal.throwIfAborted();
          return { status: "deferred" as const, reasonCode: "sources_waiting_configuration",
            providerRequests: 0, monitoringCompleted: false as const };
        } };
      }
      const makePorts = dependencies.createFactPorts ?? (async (input: Parameters<NonNullable<PostgresServiceDependencies["createFactPorts"]>>[0]) => {
        const module = await import("../apps/automation/src/postgres-service-fact-adapters.js");
        return module.createPostgresServiceFactAdapters(input);
      });
      const rpcDiagnostic = createPostgresRootExecutionRpcDiagnosticLogger();
      const sourceRpcContexts = service === "wallet-monitor" ? postgresRootSourceRpcDiagnosticContexts(config) : undefined;
      const ports = await makePorts({ runtime: currentRuntime, generationId: config.generationId,
        ...(sourceRpcContexts ? { sourceRpcContexts,
          onSourceRpcDiagnostic: (diagnostic: unknown) => rpcDiagnostic(diagnostic) } : {}),
        maximumProfiles: config.wallet.maximumProfiles, now: Date.now, sources: config.sources, signal: controller.signal }); active();
      let execute: (signal: AbortSignal) => Promise<unknown>;
      if (service === "wallet-monitor") {
        if (config.cutover.addressOnly && config.walletExecution && !dependencies.executionAuthority) {
          const module = await import('./postgres-service-cli-authority.js');
          cliAuthority = await module.createPostgresCliExecutionAuthority({ config, env, facts: ports,
            onRpcDiagnostic: diagnostic => rpcDiagnostic(diagnostic,"replay") }, {
              createValidator: options => createPostgresIndependentExecutionValidator({ ...options,
                fetch: postgresRootReplayRpcDiagnosticFetch(options,ports) }),
            }); active();
        }
        const executionReceiver = createPostgresRootWalletExecutionReceiver({ config, ports, onRpcDiagnostic: rpcDiagnostic,
          ...((dependencies.executionAuthority ?? cliAuthority?.executionAuthority)
            ? { authority: dependencies.executionAuthority ?? cliAuthority!.executionAuthority } : {}), now: Date.now });
        const wallet = loadWalletMonitorConfig(env);
        const rpc = createConfiguredWalletRpcClient({ endpoints: wallet.endpoints, fetch: ports.fetch, rateLimitCooldownMs: wallet.solanaRateLimitCooldownMs });
        const collectors = (Object.keys(wallet.endpoints) as DiscoveryChain[]).map(chain => {
          if (config.cutover.addressOnly && chain !== "solana" && chain !== "eth" && chain !== "bsc" && chain !== "base") {
            throw new Error("EVM_RANGE_UNSUPPORTED_CHAIN");
          }
          const bootstrap = config.cutover.addressOnly && (chain === "eth" || chain === "bsc" || chain === "base")
            ? Object.freeze({ generation: config.generationId, fromBlock: wallet.evmBootstrapFloors[chain] }) : undefined;
          if (bootstrap && (!Number.isSafeInteger(bootstrap.fromBlock) || bootstrap.fromBlock! <= 0)) {
            throw new Error("EVM_RANGE_BOOTSTRAP_FLOOR_REQUIRED");
          }
          const boundBootstrap = bootstrap as { readonly generation: string; readonly fromBlock: number } | undefined;
          return ({
          collector: chain === "solana" ? createSolanaWalletCollector({ rpc, batchSize: wallet.solanaBatchSize, signatureLimit: wallet.solanaSignatureLimit,
            ...(config.cutover.addressOnly ? { activatedAt: config.activatedAt } : {}) }) : createPostgresRootEvmWalletCollector(config, chain, rpc, boundBootstrap),
          executionTrust: "rpc_execution" as const,
          ...(boundBootstrap ? { bootstrap: boundBootstrap } : {}),
        }); });
        const channel = createPostgresWalletChannel({ ...config.wallet, run: currentRuntime.run, generationId: config.generationId,
          ownerId: `${service}:${hostname()}:${process.pid}`, sessionId: `${config.operationId}:${process.pid}`,
          collectors, profiles: ports.profiles, now: Date.now,
          ...(executionReceiver ? { verifyPurchase: createPostgresRootWalletExecutionVerifier(executionReceiver) } : {}) });
        execute = createPostgresRootWalletSourcePoll({ config, runtime: currentRuntime, channel, now: Date.now,
          ...((dependencies.executionAuthority ?? cliAuthority?.executionAuthority)?.validator
            && (dependencies.executionAuthority ?? cliAuthority?.executionAuthority)?.publisher && executionReceiver
            ? { executionReceiver } : {}),
          ...(dependencies.sourceAuthority ? { authority: dependencies.sourceAuthority } : {}) });
      } else if (service === "historical-backfill") {
        execute = signal => ports.targetedBackfillPoll({ signal, limit: config.composition.factLimit });
      } else {
        let selectedDependencies=dependencies;
        if(service==='scanner' && config.priceAcquisition?.protocol==='approved_reported_market_cap_v1' && !dependencies.nativeReportedMarketCapAuthority) {
          const module=await import('./postgres-reported-price-cli-authority.js');
          cliPriceAuthority=await module.createPostgresCliReportedPriceAuthority({config,env,facts:ports,signal:controller.signal}); active();
          selectedDependencies={...dependencies,nativeReportedMarketCapAuthority:cliPriceAuthority.native};
        }
        const priceDependencies = await composePostgresServicePriceDependencies({ service, deployment: config, dependencies:selectedDependencies, signal: controller.signal }); active();
        if (service === 'scanner' && config.cutover.addressOnly && config.priceAcquisition
          && (!priceDependencies.priceAuthority?.validator || !priceDependencies.priceAuthority.publisher)) {
          throw new Error('INDEPENDENT_PRICE_VALIDATOR_CLI_PORT_REQUIRED');
        }
        const priceRetry = service === "scanner" ? createPostgresRootPriceRetry({ config, runtime: currentRuntime, ports: { ...ports,
          ...(config.priceAcquisition?.protocol === "approved_reported_market_cap_v1" && priceDependencies.nativeReportedMarketCapAuthority
            ? { reportedMarketCapClient: priceDependencies.nativeReportedMarketCapAuthority.validator.client } : {}) },
          ...(priceDependencies.priceAuthority ? { authority: priceDependencies.priceAuthority } : {}), now: Date.now, pending,
          onTimeout: () => controller.abort() }) : undefined;
        const composition = await createPostgresProductionComposition({ ...config.composition, runtime: currentRuntime, identity,
          generation: { generationId: config.generationId, activatedAt: config.activatedAt },
          ownerId: `${service}:${hostname()}:${process.pid}`, adapters: ports.facts, now: Date.now,
          activeStages: workerStages[service], includePrices: service === "scanner" }); active();
        execute = async signal => {
          const priceAcquisition = priceRetry ? await priceRetry.pollOnce(signal) : undefined;
          signal.throwIfAborted();
          const work = await composition.runOnce(signal);
          return priceAcquisition ? { priceAcquisition, composition: work } : work;
        };
      }
      return { config, execute };
    }, { maximumMs: budgets.startupMs, signal: controller.signal, pending,
      onTimeout: () => controller.abort(), onWorkRejected: rejectWork });
    active();
    phase = 'ready-notification';
    await withPostgresDeadline(() => notify({ ...lifecycleIdentity!, type: "postgres-service-ready" }), {
      maximumMs: Math.floor(startupDeadline - Date.now()), signal: controller.signal, pending,
      onTimeout: () => controller.abort(), onWorkRejected: rejectWork,
    });
    ready = true; phase = 'poll';
    if (poll.execute === null) {
      await new Promise<void>(resolve => controller.signal.aborted ? resolve() : controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    } else {
      while (!controller.signal.aborted) {
        try {
          const result = await withPostgresDeadline(() => poll.execute!(controller.signal), {
            maximumMs: budgets.pollMs, signal: controller.signal, pending,
            onTimeout: () => controller.abort(), onWorkRejected: rejectWork,
          });
          active(); process.stdout.write(JSON.stringify({ service, result }) + "\n");
        } catch (error) {
          if (externalStop && controller.signal.aborted) break;
          operationFailed = true; throw error;
        }
        await wait(poll.config.services[service].intervalMs, controller.signal);
      }
    }
  } catch (error) {
    operationFailed = true; reportPostgresServiceFailure(service, phase, error); throw error;
  }
  finally {
    controller.abort();
    process.removeListener("SIGINT", onStop); process.removeListener("SIGTERM", onStop);
    dependencies.stopSignal?.removeEventListener("abort", onStop);
    await withPostgresDeadline(async () => {
      // Drain reported transport/lease release before closing its scanner-owned guarded fetch UOW.
      if(cliPriceAuthority)await cliPriceAuthority.close();
      const close = runtime?.close();
      const serverClose = consoleServer ? consoleClosures.get(consoleServer) : Promise.resolve();
      if (consoleServer) { consoleServer.closeAllConnections(); if (consoleServer.listening) consoleServer.close(); }
      const results = await Promise.allSettled([close ?? Promise.resolve(), serverClose ?? Promise.resolve(), cliAuthority?.close() ?? Promise.resolve(), ...pending]);
      if (results.some(result => result.status === "rejected") || pending.size !== 0) {
        throw new Error("POSTGRES_SHUTDOWN_DRAIN_NOT_VERIFIED");
      }
      if (!operationFailed && ready && externalStop && lifecycleIdentity) await notify({ ...lifecycleIdentity, type: "postgres-service-drained" });
    }, { maximumMs: budgets.shutdownMs }).catch(error => {
      reportPostgresServiceFailure(service, 'shutdown', error); throw error;
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = process.argv[2];
  if (!POSTGRES_BUSINESS_SERVICES.includes(service as PostgresBusinessService)) {
    process.stderr.write("Explicit PostgreSQL business service required\n"); process.exitCode = 1;
  } else await runPostgresServiceEntrypoint(service as PostgresBusinessService, process.env).catch(error => {
    reportPostgresServiceFailure(service as PostgresBusinessService, "cli-exit", error); process.exitCode = 1;
  });
}
