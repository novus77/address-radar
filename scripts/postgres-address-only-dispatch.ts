import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dispatchPostgresBusinessService, type PostgresBusinessService, type ServiceEnvironment } from '../packages/database/src/postgres-service-dispatch.js';

/** Forward actual sealed-child IPC, never infer readiness from process or database liveness. */
export function createAddressOnlyActivationSpawn(service: PostgresBusinessService, dependencies: {
  spawn?: typeof spawn; connect?: typeof createConnection;
} = {}) {
  return (executable: string, args: readonly string[], environment: ServiceEnvironment): ChildProcess => {
    const socket = environment.ADDRESS_RADAR_POSTGRES_ACTIVATION_SOCKET;
    const attempt = environment.ADDRESS_RADAR_POSTGRES_ACTIVATION_ATTEMPT;
    const operationId = environment.ADDRESS_RADAR_POSTGRES_ACTIVATION_OPERATION;
    const generationId = environment.ADDRESS_RADAR_POSTGRES_ACTIVATION_GENERATION;
    const releaseSha256 = environment.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256;
    const nonce = environment.ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE;
    const requested = [socket, attempt, operationId, generationId].some(value => value !== undefined);
    if (requested && (!socket || !/^\/run\/address-radar-activation\/[a-f0-9]{16}-[a-f0-9]{16}\.sock$/.test(socket)
      || !/^[a-f0-9]{32}$/.test(attempt ?? '') || !/^[A-Za-z0-9_-]{1,80}$/.test(operationId ?? '')
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(generationId ?? '')
      || !/^[a-f0-9]{64}$/.test(releaseSha256 ?? '') || !/^[a-f0-9]{32}$/.test(nonce ?? ''))) {
      throw new Error('Explicit bounded activation readiness channel required');
    }
    const child = (dependencies.spawn ?? spawn)(executable, [...args], {
      env: { ...environment }, cwd: dirname(dirname(args[1]!)), stdio: ['inherit', 'inherit', 'inherit', 'ipc'], shell: false,
    });
    if (!requested) return child;
    let sent = false;
    const message = (value: unknown) => {
      if (sent || !value || typeof value !== 'object' || Array.isArray(value)) return;
      const notice = value as Record<string, unknown>;
      const expected = { type: 'postgres-service-ready', service, operationId, generationId, releaseSha256, nonce };
      if (Object.keys(notice).length !== 6 || Object.entries(expected).some(([key, item]) => notice[key] !== item)
        || !Number.isSafeInteger(child.pid) || child.pid! < 2) return;
      sent = true;
      const connection = (dependencies.connect ?? createConnection)({ path: socket! }, () => {
        connection.end(JSON.stringify({ relayProtocol: 'address-only-ready-relay-v1', ...expected, attempt, childPid: child.pid }) + '\n');
      });
      // Missing activation controller never substitutes readiness; its bounded wait fails closed.
      connection.on('error', () => connection.destroy());
      connection.setTimeout(1000, () => connection.destroy());
    };
    child.on('message', message);
    child.once('exit', () => child.removeListener('message', message));
    return child;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.env.ADDRESS_RADAR_DATABASE_BACKEND !== 'postgresql'
    || process.env.ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT !== 'compiled-esm'
    || process.env.NODE_PG_FORCE_NATIVE !== undefined) {
    throw new Error('Explicit compiled PostgreSQL invocation required');
  }
  const service = process.argv[2] as PostgresBusinessService;
  if (!await dispatchPostgresBusinessService(service, process.env, { spawn: createAddressOnlyActivationSpawn(service) })) {
    throw new Error('SQLite fallback forbidden');
  }
}
