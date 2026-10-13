import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { POSTGRES_BUSINESS_SERVICES, type PostgresBusinessService } from '../packages/database/src/postgres-service-dispatch.js';
import { validatePostgresBusinessTarget } from '../packages/database/src/postgres-business-driver.js';
import { validatePostgresServiceDeployment, type PostgresServiceDeployment } from './postgres-service-entry.js';
import type { AddressOnlyStartupManifest } from '../apps/automation/src/postgres-address-only-startup.js';

export interface AddressOnlyWaitingDeploymentInput {
  readonly manifest: AddressOnlyStartupManifest;
  readonly releaseRoot: string;
  readonly execution: PostgresServiceDeployment['execution'];
  readonly roles: Readonly<Record<PostgresBusinessService, string>>;
  readonly intervalMs: number;
  readonly lifecycle?: PostgresServiceDeployment['lifecycle'];
  // These remain reviewed inputs. Migration approval does not approve business thresholds.
  readonly wallet?: PostgresServiceDeployment['wallet'];
  readonly composition?: PostgresServiceDeployment['composition'];
  readonly console?: PostgresServiceDeployment['console'];
}

export function createAddressOnlyWaitingDeployment(input: AddressOnlyWaitingDeploymentInput) {
  const manifest = input.manifest;
  const lifecycle = input.lifecycle ?? { startupMs: 60000, pollMs: 15000, shutdownMs: 10000, killMs: 5000 };
  const consoleConfiguration = input.console ?? { host: '127.0.0.1', port: 3214, maximumTraceRows: 20 };
  if (!isAbsolute(input.releaseRoot) || resolve(input.releaseRoot) !== input.releaseRoot
    || lifecycle.shutdownMs !== 10000) throw new Error('Canonical release and approved shutdown budget required');
  const services = Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => {
    const username = input.roles[service];
    validatePostgresBusinessTarget({ database: manifest.target.database, schema: manifest.target.schema,
      generation: manifest.generationId, username, service });
    return [service, { username, maximumConnections: 1, intervalMs: input.intervalMs }];
  }));
  const serviceConnectionBudgets = Object.fromEntries([
    ...POSTGRES_BUSINESS_SERVICES.map(service => [service, 1] as const),
    ['migration', 1], ['operator', 2], ['backup', 1],
  ]);
  const environment = { ADDRESS_RADAR_DATABASE_BACKEND: 'postgresql', ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: 'compiled-esm',
    ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: 'false', ADDRESS_RADAR_FOMO_BROWSER_ENABLED: 'false',
    ADDRESS_RADAR_FOMO_CAPTURE_ENABLED: 'false', ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED: 'false',
    ADDRESS_RADAR_POSTGRES_STARTUP_MS: String(lifecycle.startupMs), ADDRESS_RADAR_POSTGRES_POLL_MS: String(lifecycle.pollMs),
    ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS: String(lifecycle.shutdownMs), ADDRESS_RADAR_POSTGRES_KILL_MS: String(lifecycle.killMs) };
  const deployment = validatePostgresServiceDeployment({ format: 1, executionFormat: 'compiled-esm',
    operationId: manifest.operationId, generationId: manifest.generationId, activatedAt: manifest.activatedAt,
    cohortId: manifest.importId, database: manifest.target.database, schema: manifest.target.schema,
    releaseRoot: input.releaseRoot, execution: input.execution, cutover: { addressOnly: manifest }, lifecycle,
    gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false,
    driver: { schemaVersion: 3, schemaFingerprint: manifest.target.schemaFingerprint, ssl: false,
      serviceConnectionBudgets, serverMaximumConnections: 16, reservedConnections: 3, maximumPendingOperations: 0,
      connectionTimeoutMs: 5000, idleTimeoutMs: 10000, statementTimeoutMs: 30000, lockTimeoutMs: 5000,
      idleTransactionTimeoutMs: 30000, shutdownTimeoutMs: 10000, workMemKb: 1024 },
    services, sources: { mode: 'waiting_configuration' },
    ...(input.wallet === undefined ? {} : { wallet: input.wallet }),
    ...(input.composition === undefined ? {} : { composition: input.composition }), console: consoleConfiguration }, environment);
  return { deployment, environment,
    // The controller must enforce this measurement-age limit; it is not a driver option.
    resources: { serverMaximumConnections: 16, reservedConnections: 3, allocatedConnections: 10,
      unallocatedConnections: 3, measurementMaximumAgeMs: 60000 },
    acceptance: { migration: 'pending_verification', lifecycle: 'pending_verification', sourceMonitoring: 'waiting_configuration' } } as const;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: create-address-only-waiting-deployment <reviewed-input.json>');
  const bytes = await readFile(process.argv[2]!);
  if (bytes.length > 512 * 1024) throw new Error('Configuration input exceeds bound');
  process.stdout.write(JSON.stringify(createAddressOnlyWaitingDeployment(JSON.parse(bytes.toString('utf8')))) + '\n');
}
