/** Preparation only: preserve existing authority and render the validator's closed transformation. */
import { createHash } from 'node:crypto';
import { isAbsolute, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createSourceReplacementPlan, type SourceReplacementInput } from './prepare-address-only-source-replacement.js';
import { validateProductionSourceMaterial } from './validate-production-source-material.js';
import { runtimeAuthorityFingerprint } from './provision-address-only-runtime-authority.js';

const REFUSAL = 'FINAL_SOURCE_MATERIAL_REFUSED';
const LIMIT = 2 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
interface Pin { path: string; sha256: string }
export interface GeneratedFinalSourceMaterial {
  files: Record<string, { raw: string; sha256: string }>;
  summary: ReturnType<typeof validateProductionSourceMaterial>;
}
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
function demand(value: unknown): asserts value { if (!value) throw new Error(REFUSAL); }
function object(value: unknown): ObjectValue {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
function exact(value: unknown, keys: string[]): ObjectValue {
  const result = object(value);
  demand(isDeepStrictEqual(Object.keys(result).sort(), [...keys].sort()));
  return result;
}
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function path(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && normalize(value) === value
    && !value.includes('//') && !/[\x00-\x1f\x7f]/.test(value);
}
function pin(value: unknown): Pin {
  const result = object(value);
  demand(path(result.path) && hash(result.sha256));
  return { path: result.path, sha256: result.sha256 };
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function interval(value: ObjectValue, now: number) {
  demand(timestamp(value.validFrom) && timestamp(value.validUntil)
    && value.validFrom <= now && now < value.validUntil);
}

export function generateFinalSourceMaterial(value: unknown): GeneratedFinalSourceMaterial {
  try {
    const request = exact(value, ['input', 'review', 'currentMaterial', 'originPins', 'node', 'outputDirectory',
      'nowMs', 'manifestSha256', 'configuredManifestSha256', 'transitionId', 'walletServiceUser',
      'runtimeAuthority', 'origin', 'evidence', 'stage']);
    demand(timestamp(request.nowMs)); const now = request.nowMs;
    demand(path(request.outputDirectory) && /^\/var\/lib\/address-radar-maintenance-tools\/final-source-materials-[A-Za-z0-9_-]{1,64}$/.test(request.outputDirectory));
    demand(typeof request.transitionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(request.transitionId));
    const input = request.input as SourceReplacementInput;
    const review = object(request.review);
    demand(isDeepStrictEqual(input.review, review) && isDeepStrictEqual(input.material, request.currentMaterial)
      && review.generationId === 'production-20261006-v1'
      && timestamp(review.importedAt) && review.importedAt <= now && now-review.importedAt <= 86400000);
    const plan = createSourceReplacementPlan(input);
    const evidence = exact(request.evidence, ['protocol', 'purpose', 'approvalRef', 'generationId',
      'trustedReviewSha256', 'replacementSha256', 'validFrom', 'validUntil', 'revoked']);
    demand(evidence.protocol === 'address-only-final-source-material-approval-v1'
      && evidence.purpose === 'source_material_preparation' && evidence.revoked === false
      && evidence.approvalRef === review.approvalRef && evidence.generationId === review.generationId
      && evidence.trustedReviewSha256 === input.trustedReviewSha256
      && evidence.replacementSha256 === plan.replacementSha256);
    interval(evidence, now);
    // Validity belongs to the independently pinned import configuration, not publisher keys.
    const runtime = object(request.runtimeAuthority), runtimeTarget = object(runtime.target);
    const publisher = object(input.material.authority.publisher), validator = object(input.material.authority.validator);
    demand(typeof runtime.approvalRef === 'string' && runtime.approvalRef.length > 0
      && runtimeTarget.database === 'address_radar' && runtimeTarget.schema === 'address_radar_business'
      && runtimeTarget.systemIdentifier === '7693392208475083526' && runtimeTarget.generationId === review.generationId
      && Array.isArray(runtime.validators) && Array.isArray(publisher.validators)
      && Array.isArray(input.material.settings.validators)
      && timestamp(validator.validationTtlMs) && validator.validationTtlMs > 0 && validator.validationTtlMs <= 60000);
    const imports = runtime.validators.map(object).filter(item => item.kind === 'execution' && item.validatorId === validator.validatorId);
    const keys = publisher.validators.map(object).filter(item => item.validatorId === validator.validatorId && item.keyId === validator.keyId);
    const settings = (input.material.settings.validators as unknown[]).map(object)
      .filter(item => item.kind === 'execution' && item.validatorId === validator.validatorId);
    demand(imports.length === 1 && keys.length === 1 && settings.length === 1);
    const approved = imports[0]!, key = keys[0]!, binding = settings[0]!;
    demand(hash(approved.evidenceSha256) && timestamp(approved.importedAt) && timestamp(approved.validFrom) && timestamp(approved.validUntil)
      && approved.importedAt <= approved.validFrom && approved.validFrom <= now
      && approved.validUntil > now + validator.validationTtlMs + 5000
      && ['validatorId','keyId','publicKey','actorId','authorizationRef','reviewedSourceProviders']
        .every(name => isDeepStrictEqual(approved[name], key[name]))
      && approved.keyId === validator.keyId && approved.publicKey === validator.publicKey
      && binding.importId === approved.importId
      && binding.sourceFingerprint === runtimeAuthorityFingerprint({ approvalRef: runtime.approvalRef,
        proofScope: 'validator_authority', configuration: approved }));
    if ('approvedAt' in runtime || 'expiresAt' in runtime) {
      demand(timestamp(runtime.approvedAt) && timestamp(runtime.expiresAt)
        && runtime.approvedAt <= now && now < runtime.expiresAt);
    }
    const origin = exact(request.origin, ['waitingState', 'configuredState', 'configuredReceipt', 'manifest']);
    const waiting = object(origin.waitingState), state = object(origin.configuredState);
    const receipt = object(origin.configuredReceipt), manifest = object(origin.manifest);
    const target = object(manifest.target), currentDeployment = input.material.deployment;
    const safety = ['gatewayDeliveryEnabled','fomoEnabled','fullHistoricalMiningEnabled'];
    demand(manifest.protocol === 'address-only-v1' && safety.every(name => manifest[name] === false)
      && target.database === 'address_radar' && target.schema === 'address_radar_business'
      && target.systemIdentifier === '7693392208475083526' && manifest.generationId === review.generationId
      && typeof manifest.operationId === 'string' && waiting.operationId === manifest.operationId
      && waiting.phase === 'COMPLETE' && waiting.pending == null
      && object(waiting.receipt).sourceMonitoring === 'waiting_configuration'
      && hash(request.manifestSha256) && waiting.manifestSha256 === request.manifestSha256);
    const waitingBinding = object(object(waiting.measurement).binding);
    demand(['target','operationId','generationId','importId','planSha256'].every(name =>
      isDeepStrictEqual(waitingBinding[name], manifest[name])));
    const currentManifest = { ...manifest, releaseSha256: receipt.releaseSha256 };
    const originPins = exact(request.originPins, ['oldState','originalManifest','configuredOrigin']);
    pin(originPins.oldState); pin(originPins.originalManifest);
    const configuredOrigin = exact(originPins.configuredOrigin, ['journal','receipt','releaseRoot','node']);
    pin(configuredOrigin.journal); pin(configuredOrigin.receipt); pin(configuredOrigin.node);
    demand(path(configuredOrigin.releaseRoot) && state.phase === 'COMPLETE' && state.pending == null
      && isDeepStrictEqual(state.receipt, receipt) && state.transitionId === receipt.transitionId
      && typeof state.transitionId === 'string' && state.transitionId !== request.transitionId
      && state.operationId === manifest.operationId
      && receipt.protocol === 'address-only-configured-transition-receipt-v1'
      && receipt.sourceMonitoring === 'configured_pending_observation'
      && receipt.databaseImported === true && receipt.newImportPerformed === false
      && receipt.businessReleaseSwitched === true && receipt.monitoringCompleted === false
      && receipt.businessEligibilityGranted === false && safety.every(name => receipt[name] === false)
      && ['operationId','generationId','importId'].every(name => receipt[name] === manifest[name])
      && hash(receipt.releaseSha256) && receipt.releaseSha256 !== manifest.releaseSha256
      && object(state.release).releaseSha256 === receipt.releaseSha256
      && hash(request.configuredManifestSha256) && state.newManifestSha256 === request.configuredManifestSha256
      && receipt.newManifestSha256 === request.configuredManifestSha256
      && object(state.node).sha256 === pin(configuredOrigin.node).sha256
      && isDeepStrictEqual(state.walletServiceUser, request.walletServiceUser)
      && isDeepStrictEqual(object(object(state.measurement).binding), waitingBinding)
      && configuredOrigin.releaseRoot === currentDeployment.releaseRoot
      && input.material.authority.releaseSha256 === receipt.releaseSha256
      && currentDeployment.operationId === manifest.operationId
      && isDeepStrictEqual(object(currentDeployment.cutover).addressOnly, currentManifest));
    const stage = object(request.stage), release = object(stage.release);
    const permanent = exact(stage.permanentPins, ['oldState', 'originalManifest']);
    demand(stage.protocol === 'address-only-code-stage-receipt-v1' && stage.status === 'CODE_STAGED_ONLY'
      && stage.stageOnly === true && stage.authorizationRef === review.approvalRef
      && stage.transitionId === request.transitionId
      && isDeepStrictEqual(pin(object(stage.nativeNode).pin), pin(request.node))
      && isDeepStrictEqual(pin(permanent.oldState), pin(originPins.oldState))
      && isDeepStrictEqual(pin(permanent.originalManifest), pin(originPins.originalManifest))
      && path(release.root) && /^\/opt\/address-radar\/releases\/address-only-[a-z0-9-]{1,100}$/.test(release.root)
      && hash(release.releaseSha256) && release.releaseSha256 !== receipt.releaseSha256
      && release.releaseSha256 !== manifest.releaseSha256);
    const entry = pin(release.entryPin);
    demand(entry.path === release.root + '/scripts/postgres-service-entry.mjs');
    const finalMaterial = structuredClone(plan.material);
    finalMaterial.authority.releaseSha256 = release.releaseSha256;
    finalMaterial.deployment.releaseRoot = release.root;
    object(object(finalMaterial.deployment.cutover).addressOnly).releaseSha256 = release.releaseSha256;
    const files: GeneratedFinalSourceMaterial['files'] = {};
    function render(name: string, body: unknown): Pin {
      const raw = JSON.stringify(body) + '\n';
      demand(Buffer.byteLength(raw) <= 524288);
      files[name] = { raw, sha256: sha(raw) };
      return { path: request.outputDirectory + '/' + name, sha256: files[name]!.sha256 };
    }
    const finalPins = { authority: render('authority.json', finalMaterial.authority),
      deployment: render('deployment.json', finalMaterial.deployment), settings: render('settings.json', finalMaterial.settings) };
    finalMaterial.environment.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 = release.releaseSha256;
    finalMaterial.environment.ADDRESS_RADAR_POSTGRES_ENTRY_SHA256 = entry.sha256;
    for (const [name, key] of [['authority', 'AUTHORITY'], ['deployment', 'DEPLOYMENT'], ['settings', 'CONFIGURED_PREFLIGHT']] as const) {
      finalMaterial.environment[`ADDRESS_RADAR_POSTGRES_${key}_FILE`] = finalPins[name].path;
      finalMaterial.environment[`ADDRESS_RADAR_POSTGRES_${key}_SHA256`] = finalPins[name].sha256;
    }
    render('environment.json', finalMaterial.environment);
    const summary = validateProductionSourceMaterial({ input, replacementSha256: plan.replacementSha256,
      approvalRef: plan.seed.approvalRef, generationId: plan.seed.generationId,
      releaseRoot: release.root, releaseSha256: release.releaseSha256, entrySha256: entry.sha256, finalMaterial, finalPins });
    return { files, summary };
  } catch { throw new Error(REFUSAL); }
}

export async function main(args: readonly string[], input: AsyncIterable<Uint8Array> = process.stdin) {
  try {
    demand(args.length === 1 && args[0] === '--generate');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of input) {
      demand(chunk instanceof Uint8Array); size += chunk.byteLength;
      demand(size <= LIMIT); chunks.push(Uint8Array.from(chunk));
    }
    demand(size > 0);
    const result = generateFinalSourceMaterial(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))));
    demand(Buffer.byteLength(JSON.stringify(result)) <= LIMIT);
    return result;
  } catch { throw new Error(REFUSAL); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(result => { process.stdout.write(JSON.stringify(result) + '\n'); })
    .catch(() => { process.stdout.write('{"status":"REFUSED_NOT_EXECUTED"}\n'); process.exitCode = 1; });
}
