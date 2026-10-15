import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requireValue = (value, code) => { if (!value) throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safety = ['gatewayDeliveryEnabled', 'fomoEnabled', 'fullHistoricalMiningEnabled'];
const environmentSafety = ['ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED', 'ADDRESS_RADAR_FOMO_BROWSER_ENABLED',
  'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED'];

/** Pure candidate generation only. Protected I/O, authority freshness and activation remain external gates. */
export function produceCodeOnlyReleaseMaterial(raw) {
  requireValue(typeof raw === 'string' && Buffer.byteLength(raw) <= 2 * 1024 ** 2, 'input_budget');
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('invalid_json'); }
  requireValue(object(input) && Object.keys(input).sort().join(',') ===
    ['current', 'origin', 'outputDirectory', 'stage'].sort().join(','), 'input_shape');
  const { current, origin, stage, outputDirectory } = input;
  requireValue(object(current) && ['authority', 'deployment', 'environment', 'settings'].every(key => object(current[key]))
    && Object.keys(current).every(key => ['authority', 'deployment', 'environment', 'settings', 'reportedPriceAuthority'].includes(key)), 'current_shape');
  const reportedPrice = current.deployment.priceAcquisition?.protocol === 'approved_reported_market_cap_v1';
  const priceAuthority = current.reportedPriceAuthority;
  requireValue(reportedPrice ? object(priceAuthority) : priceAuthority === undefined
    && current.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE === undefined
    && current.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256 === undefined, 'reported_price_material_required');
  requireValue(typeof outputDirectory === 'string' &&
    /^\/var\/lib\/address-radar-maintenance-tools\/code-only-materials-[a-z0-9-]{1,100}$/.test(outputDirectory), 'output_scope');
  requireValue(object(origin) && object(origin.state) && object(origin.receipt)
    && origin.state.phase === 'COMPLETE' && origin.state.pending === null
    && isDeepStrictEqual(origin.state.receipt, origin.receipt), 'completed_origin_required');
  const receipt = origin.receipt;
  requireValue(receipt.protocol === 'address-only-configured-transition-receipt-v1'
    && receipt.businessReleaseSwitched === true && receipt.databaseImported === true
    && receipt.newImportPerformed === false && receipt.monitoringCompleted === false
    && receipt.businessEligibilityGranted === false
    && safety.every(key => receipt[key] === false), 'origin_receipt_required');
  const manifest = current.deployment.cutover?.addressOnly;
  requireValue(object(manifest) && hash(receipt.releaseSha256)
    && ['operationId', 'generationId', 'importId'].every(key => manifest[key] === receipt[key])
    && current.authority.operationId === receipt.operationId
    && current.authority.generationId === receipt.generationId
    && manifest.releaseSha256 === receipt.releaseSha256
    && current.authority.releaseSha256 === receipt.releaseSha256
    && current.environment.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 === receipt.releaseSha256,
  'current_release_binding');
  if (reportedPrice) {
    requireValue(priceAuthority.protocol === 'address-only-cli-reported-price-authority-v1'
      && priceAuthority.operationId === receipt.operationId && priceAuthority.generationId === receipt.generationId
      && priceAuthority.releaseSha256 === receipt.releaseSha256
      && isDeepStrictEqual(priceAuthority.approval, current.deployment.priceAcquisition.approval)
      && typeof current.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE === 'string'
      && hash(current.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256), 'reported_price_binding');
  }
  requireValue(safety.every(key => current.deployment[key] === false && manifest[key] === false)
    && environmentSafety.every(key => current.environment[key] === 'false'), 'safety_required');
  requireValue(object(stage) && stage.protocol === 'address-only-code-stage-receipt-v1'
    && stage.status === 'CODE_STAGED_ONLY' && stage.stageOnly === true && object(stage.safety)
    && ['controllerInvoked', 'activationPerformed', 'servicesStopped', 'servicesRestarted', 'postgresConnected',
      'postgresWrites', 'sqliteTouched', 'runtimeFilesModified', 'finalConfigurationCreated']
      .every(key => stage.safety[key] === false), 'code_stage_required');
  const release = stage.release;
  requireValue(object(release) && typeof release.root === 'string'
    && /^\/opt\/address-radar\/releases\/address-only-[a-z0-9-]{1,100}$/.test(release.root)
    && release.root !== current.deployment.releaseRoot && hash(release.releaseSha256)
    && release.releaseSha256 !== receipt.releaseSha256
    && release.entryPin?.path === release.root + '/scripts/postgres-service-entry.mjs'
    && hash(release.entryPin.sha256), 'new_release_required');
  const material = structuredClone(current);
  material.authority.releaseSha256 = release.releaseSha256;
  if (reportedPrice) material.reportedPriceAuthority.releaseSha256 = release.releaseSha256;
  material.deployment.releaseRoot = release.root;
  material.deployment.cutover.addressOnly.releaseSha256 = release.releaseSha256;
  const files = {};
  const pins = {};
  function render(name, value) {
    const body = JSON.stringify(value) + '\n';
    requireValue(Buffer.byteLength(body) <= 512 * 1024, 'output_budget');
    files[name] = { raw: body, sha256: digest(body) };
    return { path: outputDirectory + '/' + name, sha256: files[name].sha256 };
  }
  for (const key of ['authority', 'deployment', 'settings']) pins[key] = render(key + '.json', material[key]);
  material.environment.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 = release.releaseSha256;
  material.environment.ADDRESS_RADAR_POSTGRES_ENTRY_SHA256 = release.entryPin.sha256;
  for (const [key, suffix] of [['authority', 'AUTHORITY'], ['deployment', 'DEPLOYMENT'], ['settings', 'CONFIGURED_PREFLIGHT']]) {
    material.environment[`ADDRESS_RADAR_POSTGRES_${suffix}_FILE`] = pins[key].path;
    material.environment[`ADDRESS_RADAR_POSTGRES_${suffix}_SHA256`] = pins[key].sha256;
  }
  if (reportedPrice) {
    pins.reportedPriceAuthority = render('reported-price-authority.json', material.reportedPriceAuthority);
    material.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE = pins.reportedPriceAuthority.path;
    material.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256 = pins.reportedPriceAuthority.sha256;
  }
  pins.environment = render('environment.json', material.environment);
  return { files, pins, summary: { status: 'CANDIDATE_ONLY', activationReady: false,
    releaseSha256: release.releaseSha256, sourceConfigurationUnchanged: true,
    authorityFreshnessVerified: false, protectedInputsVerified: false, actualReleaseVerified: false,
    originLifecycleVerified: false, nativePreflightPassed: false, productionWrites: false } };
}
