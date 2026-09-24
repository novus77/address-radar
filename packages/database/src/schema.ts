import type { DatabaseSync } from "node:sqlite";

export function initializeAddressRadarSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS fomo_accounts (
      account_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS fomo_accounts_handle ON fomo_accounts(handle COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS wallet_identities (
      account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      chain_family TEXT NOT NULL CHECK(chain_family IN ('solana', 'evm')),
      address TEXT NOT NULL,
      confidence TEXT NOT NULL CHECK(confidence IN ('low', 'medium', 'high', 'confirmed')),
      source TEXT NOT NULL,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      PRIMARY KEY(account_id, chain_family, address)
    );
    CREATE INDEX IF NOT EXISTS wallet_identities_address ON wallet_identities(chain_family, address);

    CREATE TABLE IF NOT EXISTS trader_entities (
      entity_id TEXT PRIMARY KEY,
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('candidate', 'probation', 'active', 'elite', 'degraded', 'suspended')),
      manual INTEGER NOT NULL CHECK(manual IN (0, 1)),
      locked INTEGER NOT NULL CHECK(locked IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trader_profiles (
      entity_id TEXT PRIMARY KEY REFERENCES trader_entities(entity_id),
      display_name TEXT NOT NULL,
      priority TEXT NOT NULL CHECK(priority IN ('normal', 'important')),
      notes TEXT,
      monitoring_enabled INTEGER NOT NULL CHECK(monitoring_enabled IN (0, 1)),
      fomo_monitoring_enabled INTEGER NOT NULL CHECK(fomo_monitoring_enabled IN (0, 1)),
      onchain_monitoring_enabled INTEGER NOT NULL CHECK(onchain_monitoring_enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trader_tags (
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      category TEXT NOT NULL CHECK(category IN ('source', 'ability', 'style')),
      tag TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(entity_id, category, tag)
    );
    CREATE INDEX IF NOT EXISTS trader_tags_category ON trader_tags(category, tag);
    CREATE TABLE IF NOT EXISTS monitoring_registry_outbox (
      event_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'published')),
      created_at INTEGER NOT NULL,
      published_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS monitoring_registry_outbox_pending ON monitoring_registry_outbox(status, created_at);

    CREATE TABLE IF NOT EXISTS entity_accounts (
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      confidence TEXT NOT NULL CHECK(confidence IN ('low', 'medium', 'high', 'confirmed')),
      source TEXT NOT NULL,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      PRIMARY KEY(entity_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS trader_events (
      event_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      amount_usd REAL,
      price_usd REAL,
      market_cap_usd REAL,
      token_age_ms INTEGER,
      occurred_at INTEGER NOT NULL,
      collected_at INTEGER NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trader_events_entity_time ON trader_events(entity_id, occurred_at);
    CREATE INDEX IF NOT EXISTS trader_events_token_time ON trader_events(chain, token_address, occurred_at);
    CREATE TABLE IF NOT EXISTS raw_trader_observations (
      observation_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      source_family TEXT NOT NULL CHECK(source_family IN ('fomo', 'onchain')),
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      amount_usd REAL,
      occurred_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS raw_trader_observations_match ON raw_trader_observations(entity_id, chain, token_address, side, occurred_at);
    CREATE TABLE IF NOT EXISTS canonical_trader_events (
      canonical_event_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      amount_usd REAL,
      occurred_at INTEGER NOT NULL,
      source_status TEXT NOT NULL CHECK(source_status IN ('FOMO_ONLY', 'ONCHAIN_ONLY', 'FOMO_AND_ONCHAIN')),
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS canonical_trader_events_match ON canonical_trader_events(entity_id, chain, token_address, side, occurred_at);
    CREATE TABLE IF NOT EXISTS canonical_trader_event_observations (
      canonical_event_id TEXT NOT NULL REFERENCES canonical_trader_events(canonical_event_id),
      observation_id TEXT NOT NULL REFERENCES raw_trader_observations(observation_id),
      PRIMARY KEY(canonical_event_id, observation_id)
    );

    CREATE TABLE IF NOT EXISTS leaderboard_observations (
      account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      window TEXT NOT NULL CHECK(window IN ('24h', '30d')),
      rank INTEGER NOT NULL,
      profit_usd REAL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY(account_id, window, observed_at)
    );
    CREATE TABLE IF NOT EXISTS identity_resolution_jobs (
      handle TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('resolved', 'not_observed', 'deferred')),
      account_id TEXT,
      expires_at INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trader_score_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      strategy_version TEXT NOT NULL,
      window TEXT NOT NULL,
      quality REAL NOT NULL,
      components TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trader_style_scores (
      snapshot_id TEXT NOT NULL REFERENCES trader_score_snapshots(snapshot_id),
      style TEXT NOT NULL,
      score REAL NOT NULL,
      PRIMARY KEY(snapshot_id, style)
    );
    CREATE TABLE IF NOT EXISTS trader_lifecycle_events (
      lifecycle_event_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      previous_state TEXT NOT NULL,
      next_state TEXT NOT NULL,
      reasons TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      occurred_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trader_token_samples (
      sample_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      first_buy_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      weighted_entry_price_usd REAL,
      weighted_entry_market_cap_usd REAL,
      total_buy_usd REAL NOT NULL,
      total_sell_usd REAL NOT NULL,
      realized_value_usd REAL NOT NULL,
      remaining_cost_usd REAL NOT NULL,
      launch_at INTEGER,
      lifecycle_stage_at_entry TEXT NOT NULL,
      source_state TEXT NOT NULL,
      sample_status TEXT NOT NULL,
      exclusion_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(entity_id, chain, token_address)
    );
    CREATE INDEX IF NOT EXISTS trader_token_samples_entity_time ON trader_token_samples(entity_id, first_buy_at);
    CREATE TABLE IF NOT EXISTS market_observations (
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      price_usd REAL NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY(chain, token_address, observed_at, source)
    );
    CREATE INDEX IF NOT EXISTS market_observations_token_time ON market_observations(chain, token_address, observed_at);
    CREATE TABLE IF NOT EXISTS trader_token_outcomes (
      sample_id TEXT NOT NULL REFERENCES trader_token_samples(sample_id),
      horizon TEXT NOT NULL,
      target_at INTEGER NOT NULL,
      observed_at INTEGER,
      close_multiple REAL,
      mfe_multiple REAL,
      mae_multiple REAL,
      captured_multiple REAL,
      hit_1_5x INTEGER,
      hit_2x INTEGER,
      hit_5x INTEGER,
      hit_10x INTEGER,
      time_to_1_5x_ms INTEGER,
      time_to_2x_ms INTEGER,
      time_to_5x_ms INTEGER,
      time_to_10x_ms INTEGER,
      coverage_status TEXT NOT NULL,
      source TEXT,
      computed_at INTEGER NOT NULL,
      PRIMARY KEY(sample_id, horizon)
    );
    CREATE INDEX IF NOT EXISTS trader_token_outcomes_pending ON trader_token_outcomes(coverage_status, target_at);
    CREATE TABLE IF NOT EXISTS trader_ability_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      window TEXT NOT NULL,
      as_of INTEGER NOT NULL,
      strategy_version TEXT NOT NULL,
      raw_quality REAL NOT NULL,
      adjusted_quality REAL NOT NULL,
      sample_confidence REAL NOT NULL,
      coverage_confidence REAL NOT NULL,
      metrics TEXT NOT NULL,
      components TEXT NOT NULL,
      styles TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trader_ability_snapshots_latest ON trader_ability_snapshots(entity_id, window, as_of DESC);
    CREATE TABLE IF NOT EXISTS trader_backfill_jobs (
      job_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES trader_entities(entity_id),
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      cursor TEXT,
      attempt_count INTEGER NOT NULL,
      coverage TEXT NOT NULL,
      last_error TEXT,
      next_attempt_at INTEGER NOT NULL,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trader_backfill_jobs_claim ON trader_backfill_jobs(status, next_attempt_at, created_at);
    CREATE TABLE IF NOT EXISTS token_milestones (
      milestone_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      market_cap_usd REAL NOT NULL,
      reached_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(chain, token_address, market_cap_usd)
    );
    CREATE TABLE IF NOT EXISTS milestone_backfill_jobs (
      job_id TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL REFERENCES token_milestones(milestone_id),
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'partial', 'failed', 'unavailable')),
      source TEXT NOT NULL CHECK(source IN ('local_journal', 'fomo_token_page')),
      cursor TEXT,
      attempt_count INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      coverage_start_at INTEGER,
      coverage_end_at INTEGER,
      records_seen INTEGER NOT NULL,
      records_inserted INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(milestone_id, source)
    );
    CREATE INDEX IF NOT EXISTS milestone_backfill_jobs_claim ON milestone_backfill_jobs(status, next_attempt_at, created_at);
    CREATE TABLE IF NOT EXISTS milestone_evaluations (
      evaluation_id TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL REFERENCES token_milestones(milestone_id),
      strategy_version TEXT NOT NULL,
      event_watermark INTEGER NOT NULL,
      eligible_buy_count INTEGER NOT NULL,
      evaluated_account_count INTEGER NOT NULL,
      qualified_candidate_count INTEGER NOT NULL,
      coverage_status TEXT NOT NULL CHECK(coverage_status IN ('complete', 'partial', 'unavailable')),
      evaluated_at INTEGER NOT NULL,
      UNIQUE(milestone_id, strategy_version, event_watermark)
    );
    CREATE INDEX IF NOT EXISTS milestone_evaluations_latest ON milestone_evaluations(milestone_id, evaluated_at DESC);
    CREATE TABLE IF NOT EXISTS candidate_discoveries (
      discovery_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      discovery_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      discovered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS address_signal_evidence (
      event_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      contribution REAL NOT NULL,
      occurred_at INTEGER NOT NULL,
      source TEXT,
      side TEXT,
      amount_usd REAL,
      lifecycle_stage TEXT,
      trader_tags TEXT NOT NULL,
      dedupe_key TEXT
    );
    CREATE INDEX IF NOT EXISTS address_signal_evidence_token_time ON address_signal_evidence(chain, token_address, occurred_at);
    CREATE TABLE IF NOT EXISTS token_evaluation_state (
      token_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      action TEXT NOT NULL,
      signal_family TEXT,
      lifecycle_stage TEXT NOT NULL,
      score REAL NOT NULL,
      participant_count INTEGER NOT NULL,
      total_buy_usd REAL NOT NULL,
      source_state TEXT NOT NULL,
      window_ms INTEGER NOT NULL,
      missing_conditions TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chain, token_address)
    );
    CREATE TABLE IF NOT EXISTS token_aggregation_state (
      token_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      current_score REAL NOT NULL,
      peak_score REAL NOT NULL,
      broadcast_count INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(chain, token_address)
    );
    CREATE TABLE IF NOT EXISTS broadcast_records (
      broadcast_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL REFERENCES token_aggregation_state(token_id),
      broadcast_number INTEGER NOT NULL,
      strategy_version TEXT NOT NULL,
      score REAL NOT NULL,
      triggered_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(token_id, broadcast_number)
    );
    CREATE TABLE IF NOT EXISTS evidence_consumption (
      event_id TEXT PRIMARY KEY REFERENCES trader_events(event_id),
      broadcast_id TEXT NOT NULL REFERENCES broadcast_records(broadcast_id),
      consumed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outcome_observations (
      broadcast_id TEXT NOT NULL REFERENCES broadcast_records(broadcast_id),
      horizon TEXT NOT NULL,
      payload TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY(broadcast_id, horizon)
    );
    CREATE TABLE IF NOT EXISTS strategy_config_versions (
      strategy_version TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operator_audit_log (
      audit_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_resolution_queue (
      handle TEXT PRIMARY KEY COLLATE NOCASE,
      account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      priority INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'exported', 'resolved', 'not_found', 'conflict')),
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      next_export_at INTEGER NOT NULL,
      last_batch_id TEXT,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS identity_resolution_queue_eligible ON identity_resolution_queue(status, next_export_at, priority DESC);
    CREATE TABLE IF NOT EXISTS identity_resolution_batches (
      batch_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      max_size INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('exported', 'partially_imported', 'imported')),
      imported_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS identity_resolution_batch_items (
      batch_id TEXT NOT NULL REFERENCES identity_resolution_batches(batch_id),
      handle TEXT NOT NULL REFERENCES identity_resolution_queue(handle),
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(batch_id, handle),
      UNIQUE(batch_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS wallet_mapping_observations (
      observation_id TEXT PRIMARY KEY,
      import_id TEXT NOT NULL,
      batch_id TEXT REFERENCES identity_resolution_batches(batch_id),
      handle TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      chain_family TEXT NOT NULL CHECK(chain_family IN ('solana', 'evm')),
      address TEXT NOT NULL,
      provider TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      imported_at INTEGER NOT NULL,
      UNIQUE(import_id, chain_family, address)
    );
    CREATE INDEX IF NOT EXISTS wallet_mapping_observations_address ON wallet_mapping_observations(chain_family, address);
    CREATE TABLE IF NOT EXISTS identity_conflicts (
      conflict_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      chain_family TEXT NOT NULL CHECK(chain_family IN ('solana', 'evm')),
      address TEXT NOT NULL,
      conflicting_account_id TEXT NOT NULL REFERENCES fomo_accounts(account_id),
      status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected')),
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution TEXT
    );
    CREATE TABLE IF NOT EXISTS wallet_analysis_jobs (
      analysis_id TEXT PRIMARY KEY,
      chain_family TEXT NOT NULL CHECK(chain_family IN ('solana', 'evm')),
      address TEXT NOT NULL,
      display_name TEXT,
      fomo_handle TEXT,
      status TEXT NOT NULL CHECK(status IN ('collecting', 'review_required', 'accepted', 'rejected', 'insufficient_data', 'failed')),
      requested_sample_count INTEGER NOT NULL,
      valid_sample_count INTEGER NOT NULL DEFAULT 0,
      coverage_rate REAL NOT NULL DEFAULT 0,
      metrics TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS wallet_analysis_jobs_status ON wallet_analysis_jobs(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS wallet_analysis_checkpoints (
      analysis_id TEXT NOT NULL REFERENCES wallet_analysis_jobs(analysis_id),
      scope TEXT NOT NULL,
      cursor TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(analysis_id, scope)
    );
    CREATE TABLE IF NOT EXISTS wallet_analysis_history_events (
      analysis_id TEXT NOT NULL REFERENCES wallet_analysis_jobs(analysis_id),
      event_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      token_amount REAL NOT NULL,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(analysis_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS wallet_analysis_history_events_time
      ON wallet_analysis_history_events(analysis_id, occurred_at);
    CREATE TABLE IF NOT EXISTS monitoring_registry_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO monitoring_registry_state(singleton, version, updated_at)
    VALUES (1, 0, 0);
    CREATE TABLE IF NOT EXISTS monitoring_registry_consumers (
      consumer TEXT PRIMARY KEY,
      applied_version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_quality_snapshots (
      snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS economic_evidence_consumption (
      dedupe_key TEXT PRIMARY KEY,
      broadcast_id TEXT NOT NULL REFERENCES broadcast_records(broadcast_id),
      consumed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_outbox (
      outbox_id TEXT PRIMARY KEY,
      broadcast_id TEXT NOT NULL UNIQUE REFERENCES broadcast_records(broadcast_id),
      token_id TEXT NOT NULL,
      broadcast_sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'delivered')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL,
      last_error TEXT,
      claimed_by TEXT,
      claimed_at INTEGER,
      claim_token TEXT,
      claim_generation INTEGER NOT NULL DEFAULT 0,
      lease_expires_at INTEGER,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(token_id, broadcast_sequence)
    );
    CREATE INDEX IF NOT EXISTS signal_outbox_pending ON signal_outbox(status, next_retry_at, created_at, token_id, broadcast_sequence);
    CREATE TABLE IF NOT EXISTS signal_outbox_migration_review (
      review_id TEXT PRIMARY KEY,
      broadcast_id TEXT NOT NULL UNIQUE REFERENCES broadcast_records(broadcast_id),
      token_id TEXT NOT NULL,
      broadcast_sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('legacy_review', 'approved', 'dead_letter')),
      validation_status TEXT NOT NULL CHECK(validation_status IN ('valid', 'legacy_unreplayable', 'invalid')),
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reviewed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS collector_dead_letters (
      dead_letter_id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      error TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      UNIQUE(source_path, byte_offset, content_hash)
    );

    INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at)
    SELECT entity_id, 'source', 'source.manual', created_at
    FROM trader_entities WHERE manual = 1;

    INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at)
    SELECT DISTINCT ea.entity_id, 'source', 'source.30d_top100', lo.observed_at
    FROM leaderboard_observations lo
    JOIN entity_accounts ea ON ea.account_id = lo.account_id
    WHERE lo.window = '30d';

    INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at)
    SELECT DISTINCT ea.entity_id, 'source', 'source.milestone_discovery', d.discovered_at
    FROM candidate_discoveries d
    JOIN entity_accounts ea ON ea.account_id = d.account_id;

    INSERT OR IGNORE INTO trader_tags(entity_id, category, tag, created_at)
    SELECT DISTINCT ea.entity_id, 'ability', REPLACE(d.discovery_type, 'market_cap_', 'ability.'), d.discovered_at
    FROM candidate_discoveries d
    JOIN entity_accounts ea ON ea.account_id = d.account_id
    WHERE d.discovery_type LIKE 'market_cap_%';
  `);
}
