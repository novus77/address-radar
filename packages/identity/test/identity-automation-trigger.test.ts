import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  drainResolvedWalletAutomationOutbox,
  recordResolvedWalletAutomation,
} from '../src/identity-automation.js';

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE trader_entities (
      entity_id TEXT PRIMARY KEY,
      lifecycle TEXT NOT NULL
    );
    CREATE TABLE candidate_evidence_v3 (
      evidence_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE monitoring_registry_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO monitoring_registry_state(singleton, version, updated_at)
    VALUES (1, 0, 0);
    CREATE TABLE monitoring_registry_outbox (
      event_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      published_at INTEGER
    );
    CREATE TABLE trader_monitoring_policy (
      trader_id TEXT PRIMARY KEY,
      policy TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE trader_coverage_state (
      trader_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      coverage_state TEXT NOT NULL,
      last_covered_at INTEGER,
      next_evaluation_at INTEGER NOT NULL,
      strategy_version TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE automation_jobs (
      job_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      lane TEXT NOT NULL,
      job_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL,
      cursor TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      lease_owner TEXT,
      payload TEXT NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);
  return database;
}

describe('resolved wallet automation trigger', () => {
  it('publishes one monitoring change and one initial backfill for a wallet', () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO trader_entities(entity_id, lifecycle)
      VALUES ('trader-1', 'degraded');
      INSERT INTO candidate_evidence_v3(evidence_id, entity_id, source)
      VALUES ('evidence-1', 'trader-1', 'fomo');
      INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at)
      VALUES ('trader-1', 'periodic', 0);
      INSERT INTO trader_coverage_state(
        trader_id,
        tier,
        coverage_state,
        last_covered_at,
        next_evaluation_at,
        strategy_version,
        updated_at
      ) VALUES ('trader-1', 'T2', 'unseen', NULL, 0, 'test-v1', 0);
    `);

    const input = {
      traderId: 'trader-1',
      accountId: 'account-1',
      chainFamily: 'evm' as const,
      address: '0xAABBCCDDEEFF0011223344556677889900AABBCC',
      occurredAt: 1_000,
    };

    expect(recordResolvedWalletAutomation(database, input)).toBe(true);
    expect(recordResolvedWalletAutomation(database, input)).toBe(false);
    expect(drainResolvedWalletAutomationOutbox(database, input.occurredAt)).toBe(1);
    expect(drainResolvedWalletAutomationOutbox(database, input.occurredAt)).toBe(0);

    const outbox = database
      .prepare(
        `SELECT event_type, status
         FROM monitoring_registry_outbox`,
      )
      .all() as Array<{ event_type: string; status: string }>;
    expect(outbox).toEqual([
      { event_type: 'identity.wallet_resolved', status: 'published' },
    ]);

    const jobs = database
      .prepare(
        `SELECT job_type, idempotency_key, status, payload
         FROM automation_jobs`,
      )
      .all() as Array<{
      job_type: string;
      idempotency_key: string;
      status: string;
      payload: string;
    }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: 'initial_wallet_backfill',
      status: 'pending',
      idempotency_key:
        'initial-wallet-backfill:trader-1:evm:0xaabbccddeeff0011223344556677889900aabbcc:60d:300:trader-backfill-v1',
    });
    expect(JSON.parse(jobs[0]!.payload)).toMatchObject({
      traderId: 'trader-1',
      accountId: 'account-1',
      chainFamily: 'evm',
      address: '0xaabbccddeeff0011223344556677889900aabbcc',
      windowDays: 60,
      maximumTokens: 300,
    });

    expect(
      database
        .prepare(
          `SELECT policy
           FROM trader_monitoring_policy
           WHERE trader_id = 'trader-1'`,
        )
        .get(),
    ).toEqual({ policy: 'realtime' });
    expect(
      database
        .prepare(
          `SELECT tier, coverage_state
           FROM trader_coverage_state
           WHERE trader_id = 'trader-1'`,
        )
        .get(),
    ).toEqual({ tier: 'T1', coverage_state: 'queued' });
    expect(
      database
        .prepare(
          `SELECT lifecycle
           FROM trader_entities
           WHERE entity_id = 'trader-1'`,
        )
        .get(),
    ).toEqual({ lifecycle: 'degraded' });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM candidate_evidence_v3
           WHERE entity_id = 'trader-1'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          `SELECT version
           FROM monitoring_registry_state
           WHERE singleton = 1`,
        )
        .get(),
    ).toEqual({ version: 1 });

    database.close();
  });

  it('allows one-chain identities and keeps Solana address casing intact', () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO trader_entities(entity_id, lifecycle)
      VALUES ('trader-sol', 'active');
    `);

    const address = 'AoHegEjer11TJ2JUt6TesCqv1111111111111111111';
    expect(
      recordResolvedWalletAutomation(database, {
        traderId: 'trader-sol',
        accountId: 'account-sol',
        chainFamily: 'solana',
        address,
        occurredAt: 2_000,
      }),
    ).toBe(true);
    drainResolvedWalletAutomationOutbox(
      database,
      2_000,
    );

    const job = database
      .prepare(`SELECT payload FROM automation_jobs`)
      .get() as { payload: string };
    expect(JSON.parse(job.payload).address).toBe(address);

    database.close();
  });
});
