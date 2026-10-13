import { createHash, createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { readPrivateAuthorityPin } from './postgres-service-cli-authority.js';
import { createSourceReplacementPlan, prepareAddressOnlySourceReplacement,
  type SourceReplacementInput, type SourceReplacementMaterial } from './prepare-address-only-source-replacement.js';
import { migrationCutoverCanonicalJson } from '../packages/database/src/migration-cutover-coordinator.js';
interface Pin { path: string; sha256: string }
interface Approval {
  protocol: string; expiresAtMs: number; expectedValidatorConfigurationSha256: string;
  expectedValidatorApprovalRefSha256: string; expectedValidatorLedgerFingerprint: string;
}
export interface SourceRootPreparationJob extends Approval {
  outputDirectory: string; review: Pin; sourcePins: Record<keyof SourceReplacementMaterial, Pin>;
  trustedValidatorJob: Pin; trustedValidatorApplyReceipt: Pin;
  expectedReplacementSha256: string; expectedMaterialSha256: string;
}
interface TrustedValidator {
  kind: string; validatorId: string; keyId: string; publicKey: string; actorId: string; authorizationRef: string;
  reviewedSourceProviders: string[]; validUntil: number;
}
interface TrustedJob { approvalRef: string; validators: TrustedValidator[] }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = (v: unknown) => sha(Buffer.from(migrationCutoverCanonicalJson(v)));
function demand(v: unknown, reason: string): asserts v { if (!v) throw new Error('SOURCE_ROOT_PREPARE_' + reason); }
function normalizedEd25519Key(value: unknown): Buffer {
  demand(typeof value === 'string' && value.length > 0 && value.length <= 16384, 'PUBLIC_KEY');
  try {
    const key = createPublicKey(value);
    demand(key.asymmetricKeyType === 'ed25519', 'PUBLIC_KEY');
    return key.export({ type: 'spki', format: 'der' });
  } catch { throw new Error('SOURCE_ROOT_PREPARE_PUBLIC_KEY'); }
}
function difference(a: unknown, b: unknown, path = ''): string[] {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => difference(left[key], right[key], path + '/' + key));
  }
  return [path];
}
export function validateSourcePreparationJob(job: Approval, input: SourceReplacementInput, trusted: TrustedJob,
  receipt: { status: string; approvedConfigSha256: string }) {
  const now = Date.now();
  demand(job.protocol === 'address-only-source-root-prepare-job-v1' && Number.isSafeInteger(job.expiresAtMs)
    && now < job.expiresAtMs && job.expiresAtMs <= now + 240000, 'DEADLINE');
  demand(receipt.status === 'provisioned' && receipt.approvedConfigSha256 === digest(trusted), 'TRUSTED_JOB_RECEIPT');
  const plan = createSourceReplacementPlan(input);
  const authority = input.material.authority;
  const selected = trusted.validators.filter(v => v.kind === 'execution' && v.validatorId === authority.validator.validatorId);
  demand(selected.length === 1, 'TRUSTED_VALIDATOR');
  const v = selected[0]!;
  demand(digest(v) === job.expectedValidatorConfigurationSha256 && digest(trusted.approvalRef) === job.expectedValidatorApprovalRefSha256
    && digest({ approvalRef: trusted.approvalRef, proofScope: 'validator_authority', configuration: v }) === job.expectedValidatorLedgerFingerprint
    && v.validUntil > now + 65000, 'VALIDATOR_APPROVAL');
  demand([v.validatorId, v.keyId, v.actorId, v.authorizationRef].every(value =>
    typeof value === 'string' && value.trim().length > 0), 'VALIDATOR_IDENTITY');
  demand(authority.validator.keyId === v.keyId, 'READER_IDENTITY');
  const trustedKey = normalizedEd25519Key(v.publicKey);
  demand(normalizedEd25519Key(authority.validator.publicKey).equals(trustedKey), 'READER_IDENTITY');
  const publisher = authority.publisher as { validators: TrustedValidator[] };
  const pins = publisher.validators.filter(p => p.validatorId === v.validatorId && p.keyId === v.keyId);
  demand(pins.length === 1 && ['actorId', 'authorizationRef', 'reviewedSourceProviders'].every(key =>
    isDeepStrictEqual((pins[0] as unknown as Record<string, unknown>)[key], (v as unknown as Record<string, unknown>)[key])), 'PUBLISHER_PIN');
  demand(normalizedEd25519Key(pins[0]!.publicKey).equals(trustedKey), 'PUBLISHER_PIN');
  const pair = authority.validator.reviewedProviderBindings.find(p => p.chain === 'solana')!;
  demand(pair.replayEndpoint === 'https://api.mainnet-beta.solana.com' && v.reviewedSourceProviders.includes(pair.replayProviderId), 'REPLAY_APPROVAL');
  const ai = authority.validator.reviewedProviderBindings.indexOf(pair);
  const si = input.material.settings.providerContracts.findIndex(p => p.providerId === input.oldProviderId);
  const expected = ['/authority/validator/reviewedProviderBindings/' + ai + '/sourceProviderId',
    '/authority/validator/reviewedProviderBindings/' + ai + '/sourceEndpoint', '/deployment/walletExecution/solana/providerId',
    '/deployment/walletExecution/solana/endpoint', '/environment/RADAR_RPC_SOLANA_HTTP_URL',
    ...['providerId', 'origin', 'importId', 'sourceFingerprint'].map(key => '/settings/providerContracts/' + si + '/' + key)].sort();
  demand(isDeepStrictEqual(difference(input.material, plan.material).sort(), expected), 'CLOSED_DIFF');
  return plan;
}
async function currentFile(pin: Pin): Promise<Buffer> {
  demand(pin.path.startsWith('/etc/address-radar/') || pin.path.startsWith('/var/lib/address-radar-maintenance-tools/'), 'CURRENT_PATH');
  const handle = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    demand(before.isFile() && before.nlink === 1n && !(before.mode & 0o077n) && before.size > 0n && before.size <= 524288n, 'CURRENT_FILE');
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    demand(bytes.length === Number(before.size) && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs
      && before.ino === after.ino && sha(bytes) === pin.sha256, 'CURRENT_PIN');
    return bytes;
  } finally { await handle.close(); }
}
async function verifyCurrent(material: SourceReplacementMaterial) {
  for (const service of ['scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console']) {
    const result = await promisify(execFile)('/usr/bin/systemctl', ['show', 'address-radar-' + service + '.service', '--property=EnvironmentFiles', '--value'],
      { timeout: 3000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    const match = /^(\/etc\/address-radar\/[^\s]+) \(ignore_errors=no\)$/.exec(result.stdout.trim());
    demand(match, 'CURRENT_ENVIRONMENT');
    // Controller-owned EnvironmentFile is the anchor for service-owned read-only copies.
    const handle = await open(match[1]!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      const s = await handle.stat(); demand(s.isFile() && s.uid === 0 && s.nlink === 1 && !(s.mode & 0o077) && s.size <= 524288, 'CURRENT_ENVIRONMENT');
      text = await handle.readFile('ascii');
    } finally { await handle.close(); }
    const env: Record<string, string> = {};
    for (const line of text.trim().split('\n')) {
      const i = line.indexOf('='); demand(i > 0 && /^[A-Z][A-Z0-9_]*$/.test(line.slice(0, i)) && !(line.slice(0, i) in env), 'CURRENT_ENVIRONMENT');
      const value: unknown = JSON.parse(line.slice(i + 1)); demand(typeof value === 'string', 'CURRENT_ENVIRONMENT'); env[line.slice(0, i)] = value;
    }
    demand(env.RADAR_RPC_SOLANA_HTTP_URL === material.environment.RADAR_RPC_SOLANA_HTTP_URL, 'CURRENT_COLLECTOR');
    for (const [name, key] of [['deployment', 'DEPLOYMENT'], ['settings', 'CONFIGURED_PREFLIGHT']] as const) {
      const pin = { path: env['ADDRESS_RADAR_POSTGRES_' + key + '_FILE']!, sha256: env['ADDRESS_RADAR_POSTGRES_' + key + '_SHA256']! };
      demand(isDeepStrictEqual(JSON.parse((await currentFile(pin)).toString('utf8')), material[name]), 'CURRENT_MATERIAL');
    }
    const authorityKey = 'ADDRESS_RADAR_POSTGRES_AUTHORITY';
    if (service !== 'wallet-monitor') demand(!(authorityKey + '_FILE' in env) && !(authorityKey + '_SHA256' in env), 'CURRENT_AUTHORITY_SCOPE');
    else {
      const actual = JSON.parse((await currentFile({ path: env[authorityKey + '_FILE']!, sha256: env[authorityKey + '_SHA256']! })).toString('utf8')) as SourceReplacementMaterial['authority'];
      const normalized = structuredClone(actual) as unknown as { credential: Pin; privateKey: Pin };
      const expected = material.authority as unknown as { credential: Pin; privateKey: Pin };
      demand(normalized.credential.sha256 === expected.credential.sha256 && normalized.privateKey.sha256 === expected.privateKey.sha256, 'CURRENT_AUTHORITY_KEYS');
      normalized.credential.path = expected.credential.path; normalized.privateKey.path = expected.privateKey.path;
      demand(isDeepStrictEqual(normalized, material.authority), 'CURRENT_AUTHORITY');
    }
  }
}
export async function runSourceRootPreparation(jobPin: Pin) {
  demand(process.platform === 'linux' && process.geteuid?.() === 0, 'NATIVE_ROOT_REQUIRED');
  const read = async <T>(pin: Pin) => JSON.parse((await readPrivateAuthorityPin(pin)).toString('utf8')) as T;
  const job = await read<SourceRootPreparationJob>(jobPin);
  demand(/^\/var\/lib\/address-radar-maintenance-tools\/source-replacement-[A-Za-z0-9_-]{1,96}$/.test(job.outputDirectory), 'OUTPUT_SCOPE');
  const material = {} as SourceReplacementMaterial;
  for (const key of ['authority', 'deployment', 'settings', 'environment'] as const) Object.assign(material, { [key]: await read(job.sourcePins[key]) });
  const review = await read<SourceReplacementInput['review']>(job.review);
  const pair = material.authority.validator.reviewedProviderBindings.find(p => p.chain === 'solana'); demand(pair, 'SOURCE_PAIR');
  const input: SourceReplacementInput = { material, review, trustedReviewSha256: digest(review), oldProviderId: pair.sourceProviderId,
    oldOrigin: new URL(pair.sourceEndpoint).origin, oldOperator: 'Helius', newOperator: 'Allnodes/PublicNode' };
  const trusted = await read<TrustedJob>(job.trustedValidatorJob);
  const receipt = await read<{ status: string; approvedConfigSha256: string }>(job.trustedValidatorApplyReceipt);
  const plan = validateSourcePreparationJob(job, input, trusted, receipt);
  demand(plan.replacementSha256 === job.expectedReplacementSha256 && digest(plan.material) === job.expectedMaterialSha256, 'REVIEWED_PLAN');
  demand(plan.seed.generationId === 'production-20261006-v1', 'GENERATION');
  await verifyCurrent(material);
  for (const pin of [jobPin, job.review, job.trustedValidatorJob, job.trustedValidatorApplyReceipt, ...Object.values(job.sourcePins)]) await readPrivateAuthorityPin(pin);
  validateSourcePreparationJob(job, input, trusted, receipt);
  const prepared = await prepareAddressOnlySourceReplacement({ ...input, outputDirectory: job.outputDirectory, pins: job.sourcePins });
  const environment = await read<Record<string, string>>(prepared.files.environment!);
  const expectedEnvironment = { ...plan.material.environment };
  for (const [name, key] of [['authority', 'AUTHORITY'], ['deployment', 'DEPLOYMENT'], ['settings', 'CONFIGURED_PREFLIGHT']] as const) {
    expectedEnvironment['ADDRESS_RADAR_POSTGRES_' + key + '_FILE'] = prepared.files[name]!.path;
    expectedEnvironment['ADDRESS_RADAR_POSTGRES_' + key + '_SHA256'] = prepared.files[name]!.sha256;
    demand(isDeepStrictEqual(await read(prepared.files[name]!), plan.material[name]), 'PUBLISHED_MATERIAL');
  }
  demand(isDeepStrictEqual(environment, expectedEnvironment), 'PUBLISHED_ENVIRONMENT');
  return { status: 'PREPARED_NOT_IMPORTED_NOT_ACTIVATED', files: prepared.files, audit: prepared.audit,
    replacementSha256: plan.replacementSha256, materialSha256: digest(plan.material), closedSourceFields: 9,
    environmentArtifactPinFields: 6, validatorLedgerFingerprint: job.expectedValidatorLedgerFingerprint,
    validatorConfigurationUnchanged: true, oldSourceReferencesAbsent: true, databaseWritten: false, servicesStopped: false };
}
export async function main(args: string[]) {
  demand(args.length === 4 && args[0] === '--job' && args[2] === '--job-sha256', 'ARGUMENTS');
  const result = await runSourceRootPreparation({ path: args[1]!, sha256: args[3]! });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('SOURCE_ROOT_PREPARE_REFUSED_PRESERVED\n'); process.exitCode = 1; });
}
