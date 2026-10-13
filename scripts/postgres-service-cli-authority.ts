import { isDeepStrictEqual } from 'node:util';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import { createIndependentPostgresPublisherRuntime } from '../packages/database/src/postgres-independent-publisher-runtime.js';
import { createPostgresExecutionFactPublisher, type PostgresExecutionPublisherOptions } from '../apps/automation/src/postgres-execution-fact-publisher.js';
import { createPostgresIndependentExecutionValidator, type PostgresIndependentExecutionValidatorOptions } from '../apps/automation/src/postgres-independent-execution-validator.js';
import type { ConfiguredPostgresServiceDeployment, ServiceFactPorts } from './postgres-service-entry.js';
import type { ServiceEnvironment } from '../packages/database/src/postgres-service-dispatch.js';

interface PrivatePin { readonly path: string; readonly sha256: string }
export interface PostgresCliExecutionAuthorityConfiguration {
  readonly protocol: 'address-only-cli-execution-authority-v1';
  readonly operationId: string; readonly generationId: string; readonly releaseSha256: string;
  readonly username: string; readonly migrationRole: string;
  readonly credential: PrivatePin; readonly privateKey: PrivatePin;
  readonly validator: Omit<PostgresIndependentExecutionValidatorOptions,
    'generationId' | 'activatedAt' | 'signingKey' | 'fetch' | 'profiles' | 'now' | 'nonce' | 'onRpcDiagnostic'>;
  readonly publisher: Pick<PostgresExecutionPublisherOptions,
    'validators' | 'maximumValidationAgeMs' | 'maximumPayloadBytes' | 'statementTimeoutMs' | 'lockTimeoutMs'>;
}
const demand = (value: unknown, reason: string): void => { if (!value) throw new Error(reason); };
const sha = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');

/** No dynamic code paths: all validator/publisher implementations belong to the sealed release. */
export async function readPrivateAuthorityPin(pin: PrivatePin): Promise<Buffer> {
  demand(isAbsolute(pin.path) && resolve(pin.path) === pin.path && /^[a-f0-9]{64}$/.test(pin.sha256), 'AUTHORITY_PIN_INVALID');
  for (let parent = dirname(pin.path);;) {
    const info = await lstat(parent);
    demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022), 'AUTHORITY_PARENT_UNSAFE');
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  const file = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    const stamp = (s: typeof before) => [s.dev,s.ino,s.size,s.uid,s.gid,s.mode,s.nlink,s.ctimeNs,s.mtimeNs].join(':');
    demand(before.isFile() && before.nlink === 1n && [0n,BigInt(process.geteuid!())].includes(before.uid)
      && !(before.mode & 0o077n) && before.size > 0n && before.size <= 524288n, 'AUTHORITY_FILE_UNSAFE');
    const bytes = Buffer.alloc(Number(before.size) + 1); let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, null); if (!result.bytesRead) break; offset += result.bytesRead;
    }
    const raw = bytes.subarray(0,offset);
    demand(offset === Number(before.size) && stamp(before) === stamp(await file.stat({ bigint: true }))
      && stamp(before) === stamp(await lstat(pin.path, { bigint: true })) && sha(raw) === pin.sha256, 'AUTHORITY_PIN_CHANGED');
    return raw;
  } finally { await file.close(); }
}
export interface PostgresCliAuthorityPorts {
  readonly readPin?: typeof readPrivateAuthorityPin;
  readonly openRuntime?: typeof createIndependentPostgresPublisherRuntime;
  readonly createValidator?: typeof createPostgresIndependentExecutionValidator;
  readonly createPublisher?: typeof createPostgresExecutionFactPublisher;
  readonly now?: () => number;
}

export async function createPostgresCliExecutionAuthority(input: {
  config: ConfiguredPostgresServiceDeployment; env: ServiceEnvironment;
  facts: Pick<ServiceFactPorts, 'fetch' | 'profiles'>;
  onRpcDiagnostic?: PostgresIndependentExecutionValidatorOptions['onRpcDiagnostic'];
}, ports: PostgresCliAuthorityPorts = {}) {
  const now = ports.now ?? Date.now, read = ports.readPin ?? readPrivateAuthorityPin;
  const path = input.env.ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE, digest = input.env.ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256;
  demand(path && digest && input.config.cutover.addressOnly && input.config.walletExecution, 'EXECUTION_CLI_AUTHORITY_REQUIRED');
  const settings = JSON.parse((await read({ path: path!, sha256: digest! })).toString('utf8')) as PostgresCliExecutionAuthorityConfiguration;
  demand(settings.protocol === 'address-only-cli-execution-authority-v1' && settings.operationId === input.config.operationId
    && settings.generationId === input.config.generationId && settings.releaseSha256 === input.env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256,
    'EXECUTION_AUTHORITY_DEPLOYMENT_MISMATCH');
  const forbiddenRoles = [...Object.values(input.config.services).map(service => service.username), settings.migrationRole];
  demand(/^[a-z_][a-z0-9_]{0,62}$/.test(settings.username) && /^[a-z_][a-z0-9_]{0,62}$/.test(settings.migrationRole)
    && new Set(forbiddenRoles).size === 7 && !forbiddenRoles.includes(settings.username), 'INDEPENDENT_PUBLISHER_ROLE_REQUIRED');
  const credential = JSON.parse((await read(settings.credential)).toString('utf8')) as {
    connectionString: string; username: string; gatewayDeliveryEnabled: boolean;
  };
  const url = new URL(credential.connectionString);
  demand(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port === '5432'
    && url.pathname === '/' + input.config.database && decodeURIComponent(url.username) === settings.username
    && credential.username === settings.username && credential.gatewayDeliveryEnabled === false
    && url.password.length > 0 && !url.search && !url.hash, 'PUBLISHER_CREDENTIAL_BINDING_REJECTED');
  const validator = settings.validator, publisher = settings.publisher;
  demand(validator && publisher && Array.isArray(validator.reviewedProviderBindings)
    && validator.reviewedProviderBindings.length > 0 && validator.reviewedProviderBindings.length <= 100, 'REPLAY_BINDINGS_REQUIRED');
  const origins = new Map<string,string>();
  for (const binding of validator.reviewedProviderBindings) {
    const source = binding.chain === 'solana' ? input.config.walletExecution!.solana : input.config.walletExecution!.evm?.[binding.chain];
    demand(source && source.providerId === binding.sourceProviderId && source.endpoint === binding.sourceEndpoint,
      'REPLAY_SOURCE_CONFIGURATION_MISMATCH');
    if (binding.chain === 'solana') {
      demand(source && 'expectedGenesisHash' in source && source.expectedGenesisHash === binding.expectedGenesisHash,
        'REPLAY_SOURCE_CONFIGURATION_MISMATCH');
    } else {
      demand(source && 'expectedChainId' in source && source.expectedChainId === binding.expectedChainId
        && source.expectedGenesisBlockHash === binding.expectedGenesisBlockHash
        && isDeepStrictEqual(source.stableQuoteTokens, binding.stableQuoteTokens), 'REPLAY_SOURCE_CONFIGURATION_MISMATCH');
    }
    for (const [providerId,endpoint] of [[binding.sourceProviderId,binding.sourceEndpoint],[binding.replayProviderId,binding.replayEndpoint]]) {
      const origin = new URL(endpoint!).origin;
      demand(!origins.has(providerId!) || origins.get(providerId!) === origin, 'PROVIDER_ORIGIN_BINDING_AMBIGUOUS');
      origins.set(providerId!,origin);
    }
  }
  for (const chain of ['solana','eth','bsc','base'] as const) {
    if (chain === 'solana' ? input.config.walletExecution!.solana : input.config.walletExecution!.evm?.[chain]) {
      demand(validator.reviewedProviderBindings.some(binding => binding.chain === chain), 'REPLAY_CHAIN_COVERAGE_REQUIRED');
    }
  }
  demand(publisher.validators.some(key => key.validatorId === validator.validatorId && key.keyId === validator.keyId
    && key.publicKey === validator.publicKey && validator.reviewedProviderBindings.every(binding => key.reviewedSourceProviders.includes(binding.replayProviderId))),
    'PUBLISHER_VALIDATOR_KEY_BINDING_REQUIRED');
  const privateKey = createPrivateKey(await read(settings.privateKey));
  const runtime = (ports.openRuntime ?? createIndependentPostgresPublisherRuntime)({ connectionString: credential.connectionString,
    schema: input.config.schema, statementTimeoutMs: publisher.statementTimeoutMs, lockTimeoutMs: publisher.lockTimeoutMs });
  try {
    const at = now(); demand(Number.isSafeInteger(at) && at >= 0, 'AUTHORITY_CLOCK_INVALID');
    await runtime.run(async tx => {
      const identity = (await tx.query(`/* cli-authority-cluster */ SELECT current_database() AS database,
        current_user AS username,session_user AS session_username,host(inet_server_addr()) AS address,
        inet_server_port() AS port,system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system()`)).rows;
      const target = input.config.cutover.addressOnly!.target;
      demand(identity.length === 1 && identity[0]!.database === target.database && identity[0]!.username === settings.username
        && identity[0]!.session_username === settings.username && identity[0]!.address === target.serverAddress
        && identity[0]!.port === target.serverPort && identity[0]!.system_identifier === target.systemIdentifier,
        'PUBLISHER_CLUSTER_IDENTITY_REJECTED');
      const approved = (await tx.query(`/* cli-authority-validator */ SELECT v.validator_id FROM wallet_service_fact_validators v
        JOIN wallet_service_import_ledger l USING(generation_id,import_id)
        WHERE v.generation_id=$1 AND v.validator_id=$2 AND v.kind='execution' AND v.valid_from<=$3 AND v.valid_until>=$4
          AND v.revoked_at IS NULL AND l.revoked_at IS NULL AND l.proof_scope='validator_authority' AND l.imported_at<=$3`,
      [input.config.generationId,validator.validatorId,at,at + validator.validationTtlMs])).rows;
      demand(approved.length === 1, 'ACTUAL_VALIDATOR_LEDGER_REQUIRED');
      const providers = (await tx.query(`/* cli-authority-providers */ SELECT b.provider_id,b.origin FROM wallet_service_provider_budgets b
        JOIN wallet_service_import_ledger l USING(generation_id,import_id)
        WHERE b.generation_id=$1 AND b.provider_id=ANY($2::text[]) AND l.proof_scope='provider_contract'
          AND l.revoked_at IS NULL AND l.imported_at<=$3 AND b.window_ms>0 AND b.maximum_requests>0 AND b.maximum_concurrency>0`,
      [input.config.generationId,[...origins.keys()],at])).rows;
      demand(providers.length === origins.size && providers.every(row => origins.get(String(row.provider_id)) === row.origin)
        && new Set(providers.map(row => row.provider_id)).size === origins.size, 'ACTUAL_PROVIDER_LEDGER_REQUIRED');
    });
    const independentValidator = (ports.createValidator ?? createPostgresIndependentExecutionValidator)({ ...validator,
      generationId: input.config.generationId, activatedAt: input.config.activatedAt,
      signingKey: { loadPrivateKey: () => privateKey }, fetch: input.facts.fetch, profiles: input.facts.profiles, now, nonce: randomUUID,
      ...(input.onRpcDiagnostic ? { onRpcDiagnostic: input.onRpcDiagnostic } : {}) });
    const independentPublisher = await (ports.createPublisher ?? createPostgresExecutionFactPublisher)({ ...publisher,
      run: runtime.run, target: { database: input.config.database, schema: input.config.schema, username: settings.username,
        serverAddress: targetAddress(input.config), serverPort: 5432, generationId: input.config.generationId,
        schemaVersion: input.config.driver.schemaVersion, schemaFingerprint: input.config.driver.schemaFingerprint },
      forbiddenRoles, now });
    return { executionAuthority: { validator: independentValidator, publisher: independentPublisher }, close: runtime.close };
  } catch (error) { await runtime.close(); throw error; }
}
function targetAddress(config: ConfiguredPostgresServiceDeployment): string {
  return config.cutover.addressOnly!.target.serverAddress;
}
