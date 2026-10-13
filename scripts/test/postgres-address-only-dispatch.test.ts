import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createAddressOnlyActivationSpawn } from '../postgres-address-only-dispatch.js';

describe('native activation readiness relay', () => {
  it('relays only a real child IPC notice matching the fresh launch and deployment', () => {
    const child = Object.assign(new EventEmitter(), { pid: 1234 });
    const stream = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn(), setTimeout: vi.fn() });
    const spawn = vi.fn(() => child), connect = vi.fn((_options, callback) => { queueMicrotask(callback); return stream; });
    const launch = createAddressOnlyActivationSpawn('scanner', { spawn: spawn as any, connect: connect as any });
    const env = { ADDRESS_RADAR_POSTGRES_ACTIVATION_SOCKET: '/run/address-radar-activation/aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb.sock',
      ADDRESS_RADAR_POSTGRES_ACTIVATION_ATTEMPT: 'a'.repeat(32), ADDRESS_RADAR_POSTGRES_ACTIVATION_OPERATION: 'op',
      ADDRESS_RADAR_POSTGRES_ACTIVATION_GENERATION: 'generation', ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: 'b'.repeat(64),
      ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE: 'c'.repeat(32) };
    launch('/sealed/node', ['--no-global-search-paths', '/sealed/release/scripts/postgres-service-entry.mjs', 'scanner'], env);
    const ready = { type: 'postgres-service-ready', service: 'scanner', operationId: 'op', generationId: 'generation',
      releaseSha256: 'b'.repeat(64), nonce: 'c'.repeat(32) };
    for (const value of [{ ...ready, nonce: 'd'.repeat(32) }, { ...ready, operationId: 'other' },
      { ...ready, generationId: 'other' }, { ...ready, releaseSha256: 'e'.repeat(64) }, { ...ready, extra: true }]) child.emit('message', value);
    expect(connect).not.toHaveBeenCalled();
    child.emit('message', ready); child.emit('message', ready);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: ['inherit', 'inherit', 'inherit', 'ipc'], shell: false });
  });
  it('requires a complete bounded activation channel before spawning', () => {
    const spawn = vi.fn();
    const launch = createAddressOnlyActivationSpawn('scanner', { spawn: spawn as any });
    expect(() => launch('/node', ['--no-global-search-paths', '/root/scripts/entry.mjs', 'scanner'],
      { ADDRESS_RADAR_POSTGRES_ACTIVATION_SOCKET: '/tmp/fake.sock' })).toThrow('activation');
    expect(spawn).not.toHaveBeenCalled();
  });
});
