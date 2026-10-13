import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ options: {} as Record<string, unknown>, query: vi.fn(), release: vi.fn(),
  end: vi.fn(), on: vi.fn(), removeListener: vi.fn(), poolOn: vi.fn() }));
vi.mock('pg', () => ({ Pool: class {
  constructor(options: Record<string, unknown>) { mock.options = options; }
  on = mock.poolOn;
  connect = async () => ({ query: mock.query, release: mock.release, on: mock.on, removeListener: mock.removeListener });
  end = mock.end;
} }));
import { createIndependentPostgresPublisherRuntime } from '../src/postgres-independent-publisher-runtime.js';
beforeEach(() => { vi.clearAllMocks(); mock.query.mockResolvedValue({ rows: [], rowCount: 0 }); mock.end.mockResolvedValue(undefined); });
it('owns a single native pool with safe bootstrap before BEGIN and acknowledged COMMIT', async () => {
  const runtime = createIndependentPostgresPublisherRuntime({ connectionString: 'postgresql://private', schema: 'business', statementTimeoutMs: 5000, lockTimeoutMs: 1000 });
  await runtime.run(tx => tx.query('SELECT 1'));
  expect(mock.options.max).toBe(1); expect(mock.options.connectionTimeoutMillis).toBe(5000);
  const sql = mock.query.mock.calls.map(call => call[0]);
  expect(sql[0]).toContain('pg_catalog.set_config'); expect(sql[1]).toBe('BEGIN'); expect(sql.at(-1)).toBe('COMMIT');
  expect(mock.release).toHaveBeenCalledTimes(1); await runtime.close(); await runtime.close(); expect(mock.end).toHaveBeenCalledTimes(1);
});
it('rolls back a rejected operation and refuses invalid limits', async () => {
  const runtime = createIndependentPostgresPublisherRuntime({ connectionString: 'postgresql://private', schema: 'business', statementTimeoutMs: 5000, lockTimeoutMs: 1000 });
  await expect(runtime.run(async () => { throw new Error('refused'); })).rejects.toThrow('refused');
  expect(mock.query.mock.calls.map(call => call[0])).toContain('ROLLBACK'); await runtime.close();
  expect(() => createIndependentPostgresPublisherRuntime({ connectionString: '', schema: 'public', statementTimeoutMs: 0, lockTimeoutMs: 1 })).toThrow();
});
