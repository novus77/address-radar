import { describe, expect, it } from 'vitest';
import * as uowModule from '../../packages/database/src/postgres-unit-of-work.js';
import * as schemaModule from '../../packages/database/src/postgres-business-schema.js';
import { createSchemaInstaller } from '../install-production-postgres-business-schema.mjs';

describe('production schema entry native transaction bridge (no host)', () => {
  const candidate = {
    target: { database: 'address_radar', schema: 'radar_business', username: 'radar_migrator', generation: 'production-v1', service: 'migration' },
    approvalRef: 'approved-by-operator', schemaPlan: schemaModule.POSTGRES_BUSINESS_SCHEMA_PLAN,
    statementTimeoutMs: 60000, lockTimeoutMs: 5000,
  };
  it('uses actual native UOW top-level COMMIT and fixed new-schema approval', async () => {
    const statements: string[] = [], releases: unknown[] = [];
    const pool = { connect: async () => ({
      query: async (text: string) => { statements.push(text); return { rows: [] }; },
      release: (error?: unknown) => { releases.push(error); },
    }) };
    let options: any;
    const bridge = { ...schemaModule, installPostgresBusinessSchema: async (executor: any, input: any) => {
      options = input; return executor.run(async (tx: any) => {
        await tx.query('SELECT 1 AS mocked_schema_transaction'); return { status: 'installed' };
      });
    } };
    const install = createSchemaInstaller(uowModule, bridge, pool, candidate);
    expect(await install()).toEqual({ status: 'installed' });
    expect(statements[0]).toBe('BEGIN'); expect(statements.at(-1)).toBe('COMMIT');
    expect(options.approval).toBe('approved-new-business-schema'); expect(options.target).toEqual(candidate.target);
    expect(options.plan).toBe(schemaModule.POSTGRES_BUSINESS_SCHEMA_PLAN); expect(releases).toHaveLength(1);
  });
  it('actual unknown native COMMIT cannot produce installer success or retry', async () => {
    const statements: string[] = [], releases: unknown[] = [];
    const pool = { connect: async () => ({
      query: async (text: string) => { statements.push(text); if (text === 'COMMIT') throw new Error('unknown native result'); return { rows: [] }; },
      release: (error?: unknown) => { releases.push(error); },
    }) };
    const bridge = { ...schemaModule, installPostgresBusinessSchema: (executor: any) => executor.run(async () => ({ status: 'installed' })) };
    await expect(createSchemaInstaller(uowModule, bridge, pool, candidate)()).rejects.toBeInstanceOf(uowModule.PostgresCommitUncertainError);
    expect(statements.filter(text => text === 'COMMIT')).toHaveLength(1); expect(releases[0]).toBeTruthy();
  });
  it('real installer rejects missing live owner identity before any schema DDL', async () => {
    const statements: string[] = [];
    const pool = { connect: async () => ({
      query: async (text: string) => { statements.push(text); return { rows: [] }; }, release: () => {},
    }) };
    await expect(createSchemaInstaller(uowModule, schemaModule, pool, candidate)()).rejects.toThrow();
    expect(statements.some(text => /^CREATE\s/i.test(text))).toBe(false);
    expect(statements).toContain('ROLLBACK'); expect(statements).not.toContain('COMMIT');
  });
  it('candidate cannot replace compiled schema fingerprint or inject a registry', () => {
    expect(() => createSchemaInstaller(uowModule, schemaModule, {}, {
      ...candidate, schemaPlan: { ...candidate.schemaPlan, fingerprint: 'f'.repeat(64) },
    })).toThrow('compiled_schema_plan_changed');
  });
});
