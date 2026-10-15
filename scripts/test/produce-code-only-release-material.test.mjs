import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { produceCodeOnlyReleaseMaterial } from '../produce-code-only-release-material.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const flags = { gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false };
  const manifest = { operationId: 'op', generationId: 'gen', importId: 'import', releaseSha256: 'a'.repeat(64), ...flags };
  const receipt = { protocol: 'address-only-configured-transition-receipt-v1', ...manifest,
    databaseImported: true, newImportPerformed: false, businessReleaseSwitched: true,
    monitoringCompleted: false, businessEligibilityGranted: false };
  return { current: {
    authority: { operationId: 'op', generationId: 'gen', releaseSha256: manifest.releaseSha256, validator: { validatorId: 'same' } },
    deployment: { releaseRoot: '/opt/address-radar/releases/address-only-old', cutover: { addressOnly: manifest },
      walletExecution: { providerId: 'unchanged' }, wallet: { maximumEvents: 32 }, ...flags },
    settings: { providerContracts: [{ maximumRequests: 60, maximumConcurrency: 1 }], validators: [{ validUntil: 1 }] },
    environment: { ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: manifest.releaseSha256,
      ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: 'false', ADDRESS_RADAR_FOMO_BROWSER_ENABLED: 'false',
      ADDRESS_RADAR_FOMO_CAPTURE_ENABLED: 'false', ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED: 'false',
      RADAR_RPC_SOLANA_HTTP_URL: 'https://fixture.invalid/?key=synthetic-test-value' } },
    origin: { state: { phase: 'COMPLETE', pending: null, receipt }, receipt },
    stage: { protocol: 'address-only-code-stage-receipt-v1', status: 'CODE_STAGED_ONLY', stageOnly: true,
      safety: Object.fromEntries(['controllerInvoked', 'activationPerformed', 'servicesStopped', 'servicesRestarted',
        'postgresConnected', 'postgresWrites', 'sqliteTouched', 'runtimeFilesModified', 'finalConfigurationCreated'].map(k => [k, false])),
      release: { root: '/opt/address-radar/releases/address-only-new', releaseSha256: 'b'.repeat(64),
        entryPin: { path: '/opt/address-radar/releases/address-only-new/scripts/postgres-service-entry.mjs', sha256: 'c'.repeat(64) } } },
    outputDirectory: '/var/lib/address-radar-maintenance-tools/code-only-materials-test' };
}

test('rebinds code only, preserves sources and budgets, and never claims activation readiness', () => {
  const input = fixture(), before = JSON.stringify(input);
  const result = produceCodeOnlyReleaseMaterial(before);
  const next = Object.fromEntries(Object.entries(result.files).map(([k,v]) => [k, JSON.parse(v.raw)]));
  assert.deepEqual(next['settings.json'], input.current.settings);
  assert.deepEqual(next['deployment.json'].walletExecution, input.current.deployment.walletExecution);
  assert.deepEqual(next['deployment.json'].wallet, input.current.deployment.wallet);
  assert.equal(next['environment.json'].RADAR_RPC_SOLANA_HTTP_URL, input.current.environment.RADAR_RPC_SOLANA_HTTP_URL);
  assert.equal(next['authority.json'].releaseSha256, 'b'.repeat(64));
  assert.equal(next['environment.json'].ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256, result.files['deployment.json'].sha256);
  for (const file of Object.values(result.files)) assert.equal(file.sha256, hash(file.raw));
  assert.equal(result.summary.activationReady, false);
  assert.equal(result.summary.authorityFreshnessVerified, false);
  assert.equal(JSON.stringify(result.summary).includes('synthetic-test-value'), false);
  assert.equal(JSON.stringify(input), before);
});
for (const [name, mutate, reason] of [
  ['unfinished origin', x => { x.origin.state.phase = 'BLOCKED'; }, 'completed_origin_required'],
  ['receipt mismatch', x => { x.origin.state.receipt = { ...x.origin.receipt, operationId: 'other' }; }, 'completed_origin_required'],
  ['release mismatch', x => { x.current.authority.releaseSha256 = 'd'.repeat(64); }, 'current_release_binding'],
  ['unsafe environment', x => { x.current.environment.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED = 'true'; }, 'safety_required'],
  ['unsafe stage', x => { x.stage.safety.postgresWrites = true; }, 'code_stage_required'],
  ['foreign entry', x => { x.stage.release.entryPin.path = '/tmp/entry.mjs'; }, 'new_release_required'],
  ['traversal output', x => { x.outputDirectory += '/../other'; }, 'output_scope'],
  ['extra request field', x => { x.approval = true; }, 'input_shape'],
]) test('rejects ' + name, () => { const x = fixture(); mutate(x); assert.throws(() => produceCodeOnlyReleaseMaterial(JSON.stringify(x)), { message: reason }); });

test('rejects oversized and malformed input', () => {
  assert.throws(() => produceCodeOnlyReleaseMaterial('x'.repeat(2097153)), { message: 'input_budget' });
  assert.throws(() => produceCodeOnlyReleaseMaterial('{'), { message: 'invalid_json' });
});

function reportedFixture() {
  const x = fixture();
  const approval = { evidenceRef: 'same-approval', validUntil: 1 };
  x.current.deployment.priceAcquisition = { protocol: 'approved_reported_market_cap_v1', approval };
  x.current.reportedPriceAuthority = { protocol: 'address-only-cli-reported-price-authority-v1',
    operationId: 'op', generationId: 'gen', releaseSha256: 'a'.repeat(64), approval,
    providerContract: { maximumRequests: 60 }, validator: { validationTtlMs: 5000 } };
  x.current.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE = '/private/old-authority.json';
  x.current.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256 = 'd'.repeat(64);
  return x;
}

test('rebinds reported-price authority without renewing approvals or changing budgets', () => {
  const x = reportedFixture();
  const result = produceCodeOnlyReleaseMaterial(JSON.stringify(x));
  const authority = JSON.parse(result.files['reported-price-authority.json'].raw);
  assert.deepEqual(authority, { ...x.current.reportedPriceAuthority, releaseSha256: 'b'.repeat(64) });
  const env = JSON.parse(result.files['environment.json'].raw);
  assert.equal(env.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE, result.pins.reportedPriceAuthority.path);
  assert.equal(env.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256, hash(result.files['reported-price-authority.json'].raw));
  assert.deepEqual(JSON.parse(result.files['deployment.json'].raw).priceAcquisition, x.current.deployment.priceAcquisition);
  assert.equal(result.summary.authorityFreshnessVerified, false);
});
for (const [name, mutate, reason] of [
  ['missing authority', x => { delete x.current.reportedPriceAuthority; }, 'reported_price_material_required'],
  ['foreign generation', x => { x.current.reportedPriceAuthority.generationId = 'other'; }, 'reported_price_binding'],
  ['old release mismatch', x => { x.current.reportedPriceAuthority.releaseSha256 = 'e'.repeat(64); }, 'reported_price_binding'],
  ['approval mismatch', x => { x.current.reportedPriceAuthority.approval = {}; }, 'reported_price_binding'],
  ['missing reference', x => { delete x.current.environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE; }, 'reported_price_binding'],
]) test('rejects reported-price ' + name, () => { const x = reportedFixture(); mutate(x); assert.throws(() => produceCodeOnlyReleaseMaterial(JSON.stringify(x)), { message: reason }); });

test('rejects unused reported-price authority rather than retaining stale release references', () => {
  const x = reportedFixture(); delete x.current.deployment.priceAcquisition;
  assert.throws(() => produceCodeOnlyReleaseMaterial(JSON.stringify(x)), { message: 'reported_price_material_required' });
});

test('Python transport and real CLI preserve immutable nested manifest field order', () => {
  const input = fixture();
  input.current.deployment.cutover.addressOnly.target = {
    database: 'fixture', schema: 'public', schemaFingerprint: 'fixed',
    systemIdentifier: 'fixture-system', serverAddress: '127.0.0.1', serverPort: 5432,
  };
  const wrapper = fileURLToPath(new URL('../prepare-code-only-release-material.py', import.meta.url));
  const python = spawnSync('/usr/bin/python3', ['-B', '-c',
    'import importlib.util, json, sys; s=importlib.util.spec_from_file_location("wrapper",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); sys.stdout.buffer.write(m.encode_payload(json.load(sys.stdin)))', wrapper],
    { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000, maxBuffer: 2097152 });
  assert.equal(python.status, 0, python.stderr);
  const cli = spawnSync(process.execPath, ['--no-global-search-paths', fileURLToPath(new URL('../code-only-release-material-cli.mjs', import.meta.url))],
    { input: python.stdout, encoding: 'utf8', timeout: 5000, maxBuffer: 2097152 });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  const manifest = JSON.parse(result.files['deployment.json'].raw).cutover.addressOnly;
  assert.equal(JSON.stringify(manifest.target), JSON.stringify(input.current.deployment.cutover.addressOnly.target));
});
