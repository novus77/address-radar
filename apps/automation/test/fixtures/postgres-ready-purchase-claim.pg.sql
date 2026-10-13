-- Run only against an independently identified isolated PG16 cluster, inside this rollback.
-- The harness inserts PREPARE ready_claim with the exact exported production SQL at the marker.
BEGIN;
SET LOCAL statement_timeout='3s';
SET LOCAL lock_timeout='1s';
SET LOCAL search_path=pg_catalog,pg_temp;
CREATE TEMP TABLE wallet_service_fact_inputs(fact_id text,generation_id text,kind text,subject_key text,payload text,fingerprint text,provider_id text,observed_at bigint,known_at bigint);
CREATE TEMP TABLE wallet_service_fact_attestations(generation_id text,fact_id text,kind text,fingerprint text,validator_id text,checked_at bigint,expires_at bigint);
CREATE TEMP TABLE wallet_service_fact_validators(generation_id text,validator_id text,kind text,import_id text,valid_from bigint,valid_until bigint,revoked_at bigint);
CREATE TEMP TABLE wallet_service_import_ledger(generation_id text,import_id text,revoked_at bigint,proof_scope text,imported_at bigint);
CREATE TEMP TABLE capture_normalized_results(job_id text PRIMARY KEY,chain text,token_address text,occurred_at bigint,normalized_payload text,event_kind text,requires_review boolean,committed_at bigint);
CREATE TEMP TABLE capture_normalization_jobs(job_id text PRIMARY KEY,source_namespace text,source_event_id text,semantic_fingerprint text,status text,parser_version text);
CREATE TEMP TABLE wallet_capture_generation_bindings(generation_id text,source_namespace text,source_event_id text,semantic_fingerprint text,created_at bigint);
CREATE TEMP TABLE capture_consumer_intents(intent_id text PRIMARY KEY,job_id text);
CREATE TEMP TABLE capture_consumer_jobs(intent_id text PRIMARY KEY,consumer_name text,consumer_version text,status text,next_attempt_at bigint,lease_owner text,claim_generation integer,lease_expires_at bigint);
INSERT INTO capture_normalized_results
SELECT 'old'||lpad(i::text,4,'0'),'solana','Token',900,
 json_build_object('schemaVersion','wallet-chain-v1','generationId','generation','event',json_build_object('chain','solana','walletAddress','wallet','sourceReference','solana:old'||i,'tokenAddress','Token'))::text,
 'buy',false,900 FROM generate_series(1,500) i;
INSERT INTO capture_normalized_results VALUES('fresh','solana','Token',900,
 '{"schemaVersion":"wallet-chain-v1","generationId":"generation","event":{"chain":"solana","walletAddress":"wallet","sourceReference":"solana:fresh","tokenAddress":"Token"}}','buy',false,900);
INSERT INTO capture_normalization_jobs SELECT job_id,'wallet',job_id,'input-'||job_id,'completed','wallet-chain-v1' FROM capture_normalized_results;
INSERT INTO wallet_capture_generation_bindings SELECT 'generation',source_namespace,source_event_id,semantic_fingerprint,900 FROM capture_normalization_jobs;
INSERT INTO capture_consumer_intents SELECT job_id,job_id FROM capture_normalized_results;
INSERT INTO capture_consumer_jobs SELECT job_id,'forward_purchase_match','version','pending',CASE WHEN job_id='fresh' THEN 999 ELSE 1 END,NULL,0,NULL FROM capture_normalized_results;
INSERT INTO wallet_service_fact_inputs VALUES('fact','generation','execution',encode(sha256(convert_to('["solana","wallet","solana:fresh","Token"]','UTF8')),'hex'),
 '{"canonical":"confirmed_execution","sourceReference":"solana:fresh","purchase":{"chain":"solana","tokenAddress":"Token","occurredAt":900}}','fingerprint','provider',900,950);
INSERT INTO wallet_service_fact_attestations VALUES('generation','fact','execution','fingerprint','validator',950,2000);
INSERT INTO wallet_service_fact_validators VALUES('generation','validator','execution','approval',0,5000,NULL);
INSERT INTO wallet_service_import_ledger VALUES('generation','approval',NULL,'validator_authority',0);
-- CLAIM_PREPARE
DO $$DECLARE picked record; BEGIN
 EXECUTE 'EXECUTE ready_claim(''forward_purchase_match'',''version'',1000,''automation'',61000,''generation'',32,32,2097152,true)' INTO picked;
 IF picked.intent_id IS DISTINCT FROM 'fresh' THEN RAISE EXCEPTION 'fresh_hint_lost_behind_same_time_backlog'; END IF;
 IF picked.claim_generation<>1 OR picked.lease_expires_at<>61000 OR picked.status<>'leased' OR picked.next_attempt_at<>999 THEN RAISE EXCEPTION 'lease_protocol_changed'; END IF;
END$$;
UPDATE capture_consumer_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL;
DO $$DECLARE picked record; BEGIN
 EXECUTE 'EXECUTE ready_claim(''forward_purchase_match'',''version'',1000,''automation'',61000,''generation'',32,32,2097152,false)' INTO picked;
 IF picked.intent_id IS DISTINCT FROM 'old0001' THEN RAISE EXCEPTION 'fifo_fairness_changed'; END IF;
END$$;
UPDATE capture_consumer_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL;
UPDATE wallet_service_fact_attestations SET expires_at=1000;
DO $$DECLARE picked record; BEGIN
 EXECUTE 'EXECUTE ready_claim(''forward_purchase_match'',''version'',1000,''automation'',61000,''generation'',32,32,2097152,true)' INTO picked;
 IF picked.intent_id IS DISTINCT FROM 'old0001' THEN RAISE EXCEPTION 'expired_hint_selected'; END IF;
END$$;
UPDATE capture_consumer_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL;
UPDATE wallet_service_fact_attestations SET expires_at=2000;
UPDATE capture_consumer_jobs SET status='leased',lease_owner='held',lease_expires_at=99000 WHERE intent_id='fresh';
DO $$DECLARE picked record; BEGIN
 EXECUTE 'EXECUTE ready_claim(''forward_purchase_match'',''version'',1000,''automation'',61000,''generation'',32,32,2097152,true)' INTO picked;
 IF picked.intent_id IS DISTINCT FROM 'old0001' OR (SELECT lease_owner FROM capture_consumer_jobs WHERE intent_id='fresh')<>'held' THEN RAISE EXCEPTION 'active_lease_stolen'; END IF;
END$$;
UPDATE capture_consumer_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL;
UPDATE wallet_service_fact_inputs SET subject_key='invalid-hint';
DO $$DECLARE picked record; BEGIN
 EXECUTE 'EXECUTE ready_claim(''forward_purchase_match'',''version'',1000,''automation'',61000,''generation'',32,32,2097152,true)' INTO picked;
 IF picked.intent_id IS DISTINCT FROM 'old0001' THEN RAISE EXCEPTION 'different_subject_selected'; END IF;
END$$;
UPDATE capture_consumer_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL;
UPDATE wallet_service_fact_inputs SET payload=repeat('x',2097153);
DO $$DECLARE picked record; BEGIN
 EXECUTE 'EXECUTE ready_claim(''forward_purchase_match'',''version'',1000,''automation'',61000,''generation'',32,32,2097152,true)' INTO picked;
 IF picked.intent_id IS DISTINCT FROM 'old0001' THEN RAISE EXCEPTION 'oversized_hint_not_bounded'; END IF;
END$$;
-- Duplicate A31 + B1 envelopes, each approximately 308 KB: deduplicate before either budget.
UPDATE capture_consumer_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL,claim_generation=0;
UPDATE capture_consumer_jobs SET status='leased',lease_owner='held',lease_expires_at=99000 WHERE intent_id='old0001';
TRUNCATE wallet_service_fact_inputs,wallet_service_fact_attestations;
INSERT INTO wallet_service_fact_inputs
SELECT 'duplicate-A-'||i,'generation','execution',encode(sha256(convert_to('["solana","wallet","solana:old1","Token"]','UTF8')),'hex'),
 jsonb_build_object('canonical','confirmed_execution','sourceReference','solana:old1','purchase',jsonb_build_object('chain','solana','tokenAddress','Token','occurredAt',900),'padding',repeat('a',308000))::text,
 'fingerprint','provider',900,960 FROM generate_series(1,31) i;
INSERT INTO wallet_service_fact_inputs
SELECT 'fact-B','generation','execution',encode(sha256(convert_to('["solana","wallet","solana:fresh","Token"]','UTF8')),'hex'),
 jsonb_build_object('canonical','confirmed_execution','sourceReference','solana:fresh','purchase',jsonb_build_object('chain','solana','tokenAddress','Token','occurredAt',900),'padding',repeat('b',308000))::text,
 'fingerprint','provider',900,950;
INSERT INTO wallet_service_fact_attestations SELECT generation_id,fact_id,kind,fingerprint,'validator',known_at,2000 FROM wallet_service_fact_inputs;
DO $$DECLARE picked record; BEGIN
 EXECUTE 'EXECUTE ready_claim(''forward_purchase_match'',''version'',1000,''automation'',61000,''generation'',32,32,2097152,true)' INTO picked;
 IF picked.intent_id IS DISTINCT FROM 'fresh' THEN RAISE EXCEPTION 'duplicate_A31_B1_crowded_out_B'; END IF;
 IF picked.claim_generation<>1 OR (SELECT count(*) FROM capture_consumer_jobs WHERE status='leased')<>2 THEN RAISE EXCEPTION 'claim_quota_changed'; END IF;
END$$;
-- Repeated bindings must not multiply one invalid-schema intent past the capture window.
UPDATE capture_consumer_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL,claim_generation=0;
UPDATE capture_normalized_results SET normalized_payload=replace(normalized_payload,'wallet-chain-v1','wallet-chain-unknown') WHERE job_id='old0001';
INSERT INTO wallet_capture_generation_bindings SELECT g.* FROM wallet_capture_generation_bindings g CROSS JOIN generate_series(1,40) WHERE g.source_event_id='old0001';
DO $$DECLARE picked record; BEGIN
 EXECUTE 'EXECUTE ready_claim(''forward_purchase_match'',''version'',1000,''automation'',61000,''generation'',32,32,2097152,true)' INTO picked;
 IF picked.intent_id IS DISTINCT FROM 'fresh' THEN RAISE EXCEPTION 'duplicate_bindings_crowded_out_B'; END IF;
END$$;
SELECT 'ready_purchase_pg16_eight_scenarios_pass';
ROLLBACK;
