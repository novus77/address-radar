import { isAbsolute, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createSourceReplacementPlan, type SourceReplacementInput,
  type SourceReplacementMaterial } from './prepare-address-only-source-replacement.js';

interface Pin { readonly path: string; readonly sha256: string }
export interface ProductionSourceMaterialValidationInput {
  readonly input: SourceReplacementInput;
  readonly replacementSha256: string;
  readonly approvalRef: string;
  readonly generationId: string;
  readonly releaseRoot: string;
  readonly releaseSha256: string;
  readonly entrySha256: string;
  readonly finalMaterial: SourceReplacementMaterial;
  readonly finalPins: { readonly authority: Pin; readonly deployment: Pin; readonly settings: Pin };
}
export interface ProductionSourceMaterialValidationResult {
  readonly replacementSha256: string;
  readonly approvalRef: string;
  readonly generationId: string;
  readonly oldProviderId: string;
  readonly oldOrigin: string;
  readonly newProviderId: string;
  readonly newOrigin: string;
}
const LIMIT = 2 * 1024 * 1024;
const REFUSAL = 'PRODUCTION_SOURCE_MATERIAL_REFUSED';
function demand(value: unknown): asserts value { if (!value) throw new Error(REFUSAL); }
function record(value: unknown): Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const object = record(value);
  demand(isDeepStrictEqual(Object.keys(object).sort(), [...keys].sort()));
  return object;
}
function hash(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function path(value: unknown): boolean {
  return typeof value === 'string' && isAbsolute(value) && normalize(value) === value
    && !value.includes('//') && !/[\x00-\x1f\x7f]/.test(value);
}

/** Validate supplied trusted metadata only. Pins describe actual files checked by the caller;
 * this pure boundary neither reads them nor substitutes canonical JSON hashes for file hashes.
 */
export function validateProductionSourceMaterial(value: ProductionSourceMaterialValidationInput): ProductionSourceMaterialValidationResult {
  try {
    exact(value, ['input', 'replacementSha256', 'approvalRef', 'generationId', 'releaseRoot',
      'releaseSha256', 'entrySha256', 'finalMaterial', 'finalPins']);
    demand(hash(value.replacementSha256) && hash(value.releaseSha256) && hash(value.entrySha256)
      && path(value.releaseRoot));
    demand([value.approvalRef, value.generationId].every(item => typeof item === 'string'
      && item.trim().length > 0 && item.length <= 512 && !/[\x00-\x1f\x7f]/.test(item)));
    exact(value.finalPins, ['authority', 'deployment', 'settings']);
    for (const pin of Object.values(value.finalPins)) {
      exact(pin, ['path', 'sha256']);
      demand(path(pin.path) && hash(pin.sha256));
    }
    const plan = createSourceReplacementPlan(value.input);
    demand(plan.replacementSha256 === value.replacementSha256
      && plan.seed.approvalRef === value.approvalRef && plan.seed.generationId === value.generationId);
    const expected = structuredClone(plan.material);
    expected.authority.releaseSha256 = value.releaseSha256;
    expected.deployment.releaseRoot = value.releaseRoot;
    const addressOnly = record(record(expected.deployment.cutover).addressOnly);
    addressOnly.releaseSha256 = value.releaseSha256;
    expected.environment.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 = value.releaseSha256;
    expected.environment.ADDRESS_RADAR_POSTGRES_ENTRY_SHA256 = value.entrySha256;
    for (const [name, key] of [['authority', 'AUTHORITY'], ['deployment', 'DEPLOYMENT'],
      ['settings', 'CONFIGURED_PREFLIGHT']] as const) {
      expected.environment[`ADDRESS_RADAR_POSTGRES_${key}_FILE`] = value.finalPins[name].path;
      expected.environment[`ADDRESS_RADAR_POSTGRES_${key}_SHA256`] = value.finalPins[name].sha256;
    }
    demand(isDeepStrictEqual(value.finalMaterial, expected));
    const next = plan.seed.budgets[0]!;
    return { replacementSha256: plan.replacementSha256, approvalRef: plan.seed.approvalRef,
      generationId: plan.seed.generationId, oldProviderId: plan.oldProviderId, oldOrigin: plan.oldOrigin,
      newProviderId: next.providerId, newOrigin: next.origin };
  } catch {
    // Source-plan validation errors must never cross this boundary with private material.
    throw new Error(REFUSAL);
  }
}

/** Bounded CLI input seam; no file, database, transport or subprocess operations. */
export async function main(args: readonly string[], input: AsyncIterable<Uint8Array> = process.stdin): Promise<ProductionSourceMaterialValidationResult> {
  try {
    demand(args.length === 1 && args[0] === '--validate');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of input) {
      demand(chunk instanceof Uint8Array);
      bytes += chunk.byteLength;
      demand(bytes <= LIMIT);
      chunks.push(Uint8Array.from(chunk));
    }
    demand(bytes > 0);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    return validateProductionSourceMaterial(JSON.parse(text) as ProductionSourceMaterialValidationInput);
  } catch {
    throw new Error(REFUSAL);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(() => {
    process.stdout.write(JSON.stringify({ status: 'REFUSED_NOT_EXECUTED', reasonCode: REFUSAL }) + '\n');
    process.exitCode = 1;
  });
}
