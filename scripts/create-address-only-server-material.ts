import { constants } from 'node:fs';
import { open, lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createAddressOnlyConfiguredDeployment, type AddressOnlyConfiguredDeploymentInput, type AddressOnlySourceChain } from './create-address-only-configured-deployment.js';
import { readPrivateAuthorityPin } from './postgres-service-cli-authority.js';
import type { PostgresCliExecutionAuthorityConfiguration } from './postgres-service-cli-authority.js';
import type { PostgresEvmExecutionProducerOptions } from '../apps/automation/src/postgres-evm-execution-producer.js';

interface Pin { readonly path: string; readonly sha256: string }
interface Identity { readonly username: string; readonly uid: number; readonly gid: number }
interface RpcSelection {
  readonly chain: AddressOnlySourceChain; readonly sourceProviderId: string; readonly replayProviderId: string;
  readonly sourceEnvironmentKey: string; readonly replayEnvironmentKey: string;
  readonly expectedGenesisHash?: string; readonly expectedChainId?: string; readonly expectedGenesisBlockHash?: string;
  readonly stableQuoteTokens?: PostgresEvmExecutionProducerOptions['stableQuoteTokens'];
}
export interface AddressOnlyServerMaterialInput {
  readonly protocol: 'address-only-server-material-input-v1';
  readonly outputDirectory: string; readonly walletMonitorUser: string;
  readonly environmentFiles: readonly Pin[];
  readonly configured: Omit<AddressOnlyConfiguredDeploymentInput, 'sourceRPCRegistry' | 'walletExecution'>;
  readonly rpc: readonly RpcSelection[];
  readonly publisherUsername: string; readonly migrationRole: string;
  readonly validatorId: string; readonly keyId: string;
  readonly actorId: string; readonly authorizationRef: string;
}
const demand = (value: unknown, code: string): void => { if (!value) throw new Error(code); };
const digest = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
const execute = promisify(execFile);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');

/** Strict EnvironmentFile subset. Never executes shell, expands variables or prints values. */
export function parseServerRpcEnvironment(raw: Buffer): Readonly<Record<string,string>> {
  demand(raw.length <= 524288, 'ENVIRONMENT_BYTE_BUDGET');
  const values: Record<string,string> = {};
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    demand(match, 'ENVIRONMENT_ASSIGNMENT_UNSUPPORTED');
    const key = match![1]!; let value = match![2]!;
    if (!/^RADAR_RPC_(SOLANA|ETH|BSC|BASE)_(FALLBACK_)?HTTP_URL$/.test(key)) continue;
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { throw new Error('ENVIRONMENT_QUOTE_UNSUPPORTED'); } }
    else if (value.startsWith("'")) {
      demand(value.endsWith("'") && !value.slice(1,-1).includes("'"), 'ENVIRONMENT_QUOTE_UNSUPPORTED'); value = value.slice(1,-1);
    } else demand(!/[\s\\'"`]/.test(value), 'ENVIRONMENT_QUOTE_UNSUPPORTED');
    demand(typeof value === 'string' && !/[\x00-\x20\x7f]/.test(value), 'RPC_ENDPOINT_INVALID');
    demand(!Object.hasOwn(values,key) || values[key] === value, 'RPC_ENVIRONMENT_DUPLICATE'); values[key] = value;
  }
  return values;
}
async function protectedParent(path: string): Promise<void> {
  demand(isAbsolute(path) && resolve(path) === path, 'MATERIAL_PATH_INVALID');
  for (let parent = dirname(path);;) {
    const info = await lstat(parent);
    demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022)
      && !!(info.mode & 0o001), 'MATERIAL_ROOT_PARENT_UNSAFE_OR_UNSEARCHABLE');
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function publishFile(path: string, raw: Buffer, owner: Identity | undefined): Promise<Pin> {
  demand(raw.length > 0 && raw.length <= 524288, 'MATERIAL_FILE_BYTE_BUDGET');
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(raw); await file.chown(owner?.uid ?? 0, owner?.gid ?? 0);
    await file.chmod(owner ? 0o400 : 0o600); await file.sync();
  } finally { await file.close(); }
  await syncDirectory(dirname(path)); return { path, sha256: digest(raw) };
}
async function resolveUser(username: string): Promise<Identity> {
  demand(/^[a-z_][a-z0-9_-]{0,31}$/.test(username), 'MATERIAL_OS_USER_INVALID');
  const { stdout } = await execute('/usr/bin/getent', ['passwd', username], { timeout: 5000, maxBuffer: 4096 });
  const fields = stdout.trim().split(':'); const uid = Number(fields[2]), gid = Number(fields[3]);
  demand(fields.length === 7 && fields[0] === username && Number.isSafeInteger(uid) && uid > 0
    && Number.isSafeInteger(gid) && gid >= 0, 'MATERIAL_NONROOT_OS_USER_REQUIRED');
  return { username, uid, gid };
}
export interface AddressOnlyServerMaterialPorts {
  readonly requireRoot?: () => void;
  readonly readPin?: typeof readPrivateAuthorityPin;
  readonly resolveUser?: typeof resolveUser;
  readonly consumerUser?: (service: string) => Promise<string>;
  readonly createDirectory?: (path: string) => Promise<void>;
  readonly publishFile?: typeof publishFile;
  readonly finishDirectory?: (path: string) => Promise<void>;
  readonly verifyAccess?: (identity: Identity, pins: readonly Pin[]) => Promise<void>;
  readonly now?: () => number;
}
/** Root-only preparation. Does not alter units, roles, ledgers, release pins or monitoring status. */
export async function createAddressOnlyServerMaterials(input: AddressOnlyServerMaterialInput,
  ports: AddressOnlyServerMaterialPorts = {}) {
  (ports.requireRoot ?? (() => demand(process.platform === 'linux' && process.geteuid?.() === 0, 'NATIVE_ROOT_REQUIRED')))();
  const read = ports.readPin ?? readPrivateAuthorityPin, user = ports.resolveUser ?? resolveUser;
  const publish = ports.publishFile ?? publishFile, now = ports.now ?? Date.now;
  demand(input.protocol === 'address-only-server-material-input-v1' && isAbsolute(input.outputDirectory)
    && resolve(input.outputDirectory) === input.outputDirectory, 'MATERIAL_INPUT_INVALID');
  demand(Array.isArray(input.environmentFiles) && input.environmentFiles.length > 0 && input.environmentFiles.length <= 16,
    'PINNED_EXISTING_ENVIRONMENT_REQUIRED');
  demand(Array.isArray(input.rpc) && input.rpc.length > 0 && input.rpc.length <= 4, 'EXPLICIT_RPC_SELECTION_REQUIRED');
  demand(/^[a-z_][a-z0-9_]{0,62}$/.test(input.publisherUsername)
    && /^[a-z_][a-z0-9_]{0,62}$/.test(input.migrationRole)
    && !Object.values(input.configured.roles).includes(input.publisherUsername) && input.publisherUsername !== input.migrationRole,
    'INDEPENDENT_PUBLISHER_ROLE_REQUIRED');
  for (const value of [input.validatorId,input.keyId,input.actorId,input.authorizationRef]) {
    demand(typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x20]/.test(value)
      && !value.includes('://'), 'EXPLICIT_AUTHORITY_IDENTITIES_REQUIRED');
  }
  const identity = await user(input.walletMonitorUser);
  demand(Number.isSafeInteger(identity.uid) && identity.uid > 0, 'WALLET_MONITOR_NONROOT_UID_REQUIRED');
  const consumerUser = ports.consumerUser ?? (async service => {
    const { stdout } = await execute('/usr/bin/systemctl', ['show', 'address-radar-' + service + '.service', '--property=User', '--value'],
      { timeout: 5000, maxBuffer: 4096 }); return stdout.trim();
  });
  for (const service of Object.keys(input.configured.roles)) {
    if (service === 'wallet-monitor') continue;
    const other = await user(await consumerUser(service));
    demand(other.uid > 0 && other.uid !== identity.uid, 'WALLET_MONITOR_UID_SHARED_WITH_CONSUMER');
  }
  const environment: Record<string,string> = {};
  for (const pin of input.environmentFiles) {
    demand(pin.path.startsWith('/etc/') && resolve(pin.path) === pin.path, 'EXISTING_ETC_ENVIRONMENT_REQUIRED');
    for (const [key,value] of Object.entries(parseServerRpcEnvironment(await read(pin)))) {
      demand(!Object.hasOwn(environment,key) || environment[key] === value, 'RPC_ENVIRONMENT_DUPLICATE'); environment[key] = value;
    }
  }
  const pairs = input.rpc.map(selection => {
    demand(selection.sourceEnvironmentKey === `RADAR_RPC_${selection.chain.toUpperCase()}_HTTP_URL`
      && /^RADAR_RPC_(SOLANA|ETH|BSC|BASE)_(FALLBACK_)?HTTP_URL$/.test(selection.replayEnvironmentKey), 'RPC_ENVIRONMENT_SELECTION_INVALID');
    const sourceEndpoint = environment[selection.sourceEnvironmentKey], replayEndpoint = environment[selection.replayEnvironmentKey];
    demand(sourceEndpoint && replayEndpoint, 'ACTUAL_SOURCE_AND_REPLAY_ENDPOINTS_REQUIRED');
    const source = new URL(sourceEndpoint!), replay = new URL(replayEndpoint!);
    demand(source.protocol === 'https:' && replay.protocol === 'https:' && !source.username && !source.password
      && !replay.username && !replay.password && !source.hash && !replay.hash && source.hostname !== replay.hostname
      && selection.sourceProviderId !== selection.replayProviderId, 'INDEPENDENT_HTTPS_RPC_ENDPOINTS_REQUIRED');
    for (const [id,origin] of [[selection.sourceProviderId,source.origin],[selection.replayProviderId,replay.origin]]) {
      const contract = input.configured.budgetContracts.find(item => item.providerId === id && item.origin === origin);
      demand(contract && contract.windowMs === 60000 && contract.maximumRequests === 60 && contract.maximumConcurrency === 1,
        'ACTUAL_ORIGIN_APPROVED_60_PER_MINUTE_CONTRACT_REQUIRED');
    }
    const common = { chain: selection.chain, sourceProviderId: selection.sourceProviderId, sourceEndpoint: sourceEndpoint!,
      replayProviderId: selection.replayProviderId, replayEndpoint: replayEndpoint! };
    if (selection.chain === 'solana') {
      demand(typeof selection.expectedGenesisHash === 'string' && selection.expectedGenesisHash.length > 0, 'ACTUAL_SOLANA_GENESIS_REQUIRED');
      return { ...common, chain: 'solana' as const, expectedGenesisHash: selection.expectedGenesisHash! };
    }
    demand(['eth','bsc','base'].includes(selection.chain) && /^0x[0-9a-f]{1,64}$/.test(selection.expectedChainId ?? '')
      && /^0x[0-9a-f]{64}$/.test(selection.expectedGenesisBlockHash ?? '') && selection.stableQuoteTokens?.length,
      'ACTUAL_EVM_CHAIN_GENESIS_AND_STABLE_QUOTES_REQUIRED');
    return { ...common, chain: selection.chain as 'eth' | 'bsc' | 'base', expectedChainId: selection.expectedChainId!,
      expectedGenesisBlockHash: selection.expectedGenesisBlockHash!, stableQuoteTokens: selection.stableQuoteTokens! };
  });
  const walletExecution: NonNullable<AddressOnlyConfiguredDeploymentInput['walletExecution']> = {
    receiver: { maximumCandidates: 32, maximumRunMs: 12000, maximumPayloadBytes: 2097152 },
    ...(pairs.some(pair => pair.chain !== 'solana') ? { evm: {} } : {}),
  };
  for (const pair of pairs) {
    const common = { providerId: pair.sourceProviderId, endpoint: pair.sourceEndpoint,
      maximumProfiles: 256, maximumRunMs: 5000, maximumPayloadBytes: 2097152 };
    if (pair.chain === 'solana') Object.assign(walletExecution, { solana: { ...common, expectedGenesisHash: pair.expectedGenesisHash, rateLimitCooldownMs: 30000 } });
    else Object.assign(walletExecution.evm!, { [pair.chain]: { ...common, expectedChainId: pair.expectedChainId,
      expectedGenesisBlockHash: pair.expectedGenesisBlockHash, stableQuoteTokens: pair.stableQuoteTokens,
      maximumLogs: 32, maximumDecimalsReads: 8, maximumRpcRequests: 32 } });
  }
  const configuredInput: AddressOnlyConfiguredDeploymentInput = { ...structuredClone(input.configured), walletExecution,
    sourceRPCRegistry: pairs.map(pair => ({ chain: pair.chain, providerId: pair.sourceProviderId,
      origin: new URL(pair.sourceEndpoint).origin, endpointEnvironmentKey: `RADAR_RPC_${pair.chain.toUpperCase()}_HTTP_URL` })) };
  const configured = createAddressOnlyConfiguredDeployment(configuredInput, { now });
  const proof = input.configured.authorityProofs.find(item => item.kind === 'execution');
  demand(proof?.validatorId === input.validatorId && proof.publisherRole === input.publisherUsername, 'EXECUTION_AUTHORITY_METADATA_MISMATCH');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const password = randomBytes(32).toString('hex');
  const url = new URL('postgresql://127.0.0.1:5432/' + input.configured.manifest.target.database);
  url.username = input.publisherUsername; url.password = password;
  await (ports.createDirectory ?? (async path => {
    await protectedParent(path); await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path));
  }))(input.outputDirectory);
  const credential = await publish(join(input.outputDirectory,'publisher.json'), encode({ connectionString: url.href,
    username: input.publisherUsername, service: 'execution-publisher', gatewayDeliveryEnabled: false }), identity);
  const key = await publish(join(input.outputDirectory,'validator.pem'), Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })), identity);
  const authority: PostgresCliExecutionAuthorityConfiguration = {
    protocol: 'address-only-cli-execution-authority-v1', operationId: configuredInput.manifest.operationId,
    generationId: configuredInput.manifest.generationId, releaseSha256: configuredInput.manifest.releaseSha256,
    username: input.publisherUsername, migrationRole: input.migrationRole, credential, privateKey: key,
    validator: { validatorId: input.validatorId, keyId: input.keyId, publicKey: publicPem, reviewedProviderBindings: pairs,
      maximumProfiles: 256, maximumRpcRequests: 32, maximumLogs: 32, maximumDecimalsReads: 8,
      maximumPayloadBytes: 2097152, maximumRunMs: 5000, validationTtlMs: 60000, maximumNonces: 64 },
    publisher: { validators: [{ validatorId: input.validatorId, keyId: input.keyId, publicKey: publicPem,
      actorId: input.actorId, authorizationRef: input.authorizationRef, reviewedSourceProviders: pairs.map(pair => pair.replayProviderId) }],
      maximumValidationAgeMs: 60000, maximumPayloadBytes: 2097152, statementTimeoutMs: 5000, lockTimeoutMs: 1000 },
  };
  const authorityPin = await publish(join(input.outputDirectory,'execution-authority.json'), encode(authority), identity);
  // Audit material only: never use this mixed primary/replay file as a service EnvironmentFile.
  // Collector fallback lacks a matching producer; controller environments must contain source primaries only.
  const rpcEnvironment = pairs.flatMap(pair => [`RADAR_RPC_${pair.chain.toUpperCase()}_HTTP_URL=${JSON.stringify(pair.sourceEndpoint)}`,
    `RADAR_RPC_${pair.chain.toUpperCase()}_FALLBACK_HTTP_URL=${JSON.stringify(pair.replayEndpoint)}`]).join('\n') + '\n';
  const rpcPin = await publish(join(input.outputDirectory,'wallet-monitor-rpc.env'), Buffer.from(rpcEnvironment), identity);
  const inputPin = await publish(join(input.outputDirectory,'configured-input.json'), encode(configuredInput), undefined);
  const deploymentPin = await publish(join(input.outputDirectory,'configured-deployment.json'), encode(configured.deployment), undefined);
  await (ports.finishDirectory ?? (async path => {
    const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await file.chmod(0o711); await file.sync(); } finally { await file.close(); }
    await syncDirectory(dirname(path));
  }))(input.outputDirectory);
  await (ports.verifyAccess ?? (async (owner,pins) => {
    const program = 'import os,sys,hashlib\nfor p,h in zip(sys.argv[1::2],sys.argv[2::2]):\n f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);r=os.read(f,524289);os.close(f)\n if hashlib.sha256(r).hexdigest()!=h:raise SystemExit(1)';
    await execute('/usr/bin/python3',['-I','-B','-c',program,...pins.flatMap(pin => [pin.path,pin.sha256])],
      { uid: owner.uid, gid: owner.gid, timeout: 5000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  }))(identity,[credential,key,authorityPin,rpcPin]);
  // Public receipt only. None of the secret-bearing in-memory structures are returned.
  const receipt = { protocol: 'address-only-server-material-receipt-v1', walletMonitorIdentity: identity,
    walletMonitorUnitUserMustEqual: identity.username, authority: authorityPin, credential, privateKey: key,
    rpcEnvironment: rpcPin,
    rpcEnvironmentUsage: {
      purpose: 'audit-material-only', serviceEnvironmentFileAllowed: false,
      controllerEnvironmentPolicy: 'source-primary-only',
      sourcePrimaryEnvironmentKeys: pairs.map(pair => `RADAR_RPC_${pair.chain.toUpperCase()}_HTTP_URL`),
      replayConfigurationLocation: 'execution-authority.json',
      configuredChains: pairs.map(pair => pair.chain),
      unconfiguredChains: (['solana','eth','bsc','base'] as const).filter(chain => !pairs.some(pair => pair.chain === chain)),
    },
    configuredInput: inputPin, configuredDeployment: deploymentPin,
    publicKey: publicPem, validatorId: input.validatorId, keyId: input.keyId, resources: configured.resources,
    requiredEnvironment: { ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE: authorityPin.path,
      ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256: authorityPin.sha256 },
    publisherRoleProvisioned: false, ledgersProvisioned: false, productionConfigured: false, monitoringCompleted: false,
    outstandingGaps: configured.preflight.gaps } as const;
  await publish(join(input.outputDirectory,'material-receipt.json'), encode(receipt), undefined);
  return receipt;
}

/** Import-only entry: pin the root-owned input; never execute a bundled service CLI. */
export async function createAddressOnlyServerMaterialsFromPin(pin: Pin) {
  demand(process.platform === 'linux' && process.geteuid?.() === 0, 'NATIVE_ROOT_REQUIRED');
  const raw = await readPrivateAuthorityPin(pin);
  return createAddressOnlyServerMaterials(JSON.parse(raw.toString('utf8')) as AddressOnlyServerMaterialInput);
}
