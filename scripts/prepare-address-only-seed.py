#!/usr/bin/env python3
"""Validate an address-only seed without importing or granting eligibility."""
import argparse
import hashlib
import json
import os
import re
import stat

TABLES = {'fomo_accounts', 'wallet_identities', 'entity_accounts', 'trader_entities', 'trader_profiles', 'trader_monitoring_policy'}
FLAGS = ('monitoring_enabled', 'fomo_monitoring_enabled', 'onchain_monitoring_enabled')

def require(value, reason):
    if not value:
        raise ValueError(reason)

def unique(rows, field):
    result = {}
    for row in rows:
        key = row[field]
        require(isinstance(key, str) and key and key not in result, 'duplicate_or_invalid_' + field)
        result[key] = row
    return result

def prepare(seed, source_sha256):
    require(seed.get('format') == 'address-only-seed-v1', 'unsupported_seed')
    tables = seed['tables']
    require(set(tables) == TABLES, 'unexpected_tables')
    require(all(isinstance(rows, list) and len(rows) <= 10000 for rows in tables.values()), 'row_budget')
    require(seed['rules'] == {'historicalEvidenceImported': False, 'historicalJobsImported': False,
        'legacyLifecycleIsNotNewCapabilityProof': True, 'gatewayDeliveryEnabled': False,
        'activationAuthorizedByExport': False}, 'seed_authority_changed')
    accounts = unique(tables['fomo_accounts'], 'account_id')
    entities = unique(tables['trader_entities'], 'entity_id')
    profiles = unique(tables['trader_profiles'], 'entity_id')
    policies = unique(tables['trader_monitoring_policy'], 'trader_id')
    require(set(entities) == set(profiles) == set(policies), 'incomplete_entity_settings')
    links = {}
    for link in tables['entity_accounts']:
        account, entity = link['account_id'], link['entity_id']
        require(account in accounts and entity in entities and account not in links, 'ambiguous_account_owner')
        require(link['confidence'] in ('high', 'confirmed'), 'unverified_account_link')
        links[account] = entity
    require(set(links) == set(accounts), 'unlinked_account')
    wallets, seen, used_accounts = [], {}, set()
    for wallet in tables['wallet_identities']:
        family, address, account = wallet['chain_family'], wallet['address'], wallet['account_id']
        require(account in links, 'unlinked_wallet')
        require((wallet['confidence'], wallet['source']) in {('confirmed', 'manual'), ('high', 'fomolens_manual')}, 'unverified_wallet')
        require(isinstance(address, str) and ((family == 'evm' and re.fullmatch(r'0x[0-9a-fA-F]{40}', address))
            or (family == 'solana' and re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', address))), 'invalid_address')
        key = (family, address.lower() if family == 'evm' else address)
        require(key not in seen, 'duplicate_or_conflicting_wallet')
        seen[key] = account
        used_accounts.add(account)
        wallets.append({'entityId': links[account], 'accountId': account, 'family': family,
            'address': key[1], 'confirmation': 'historical-confirmed', 'source': wallet['source']})
    require(wallets and used_accounts == set(accounts), 'orphan_or_empty_accounts')
    settings = []
    for entity, profile in sorted(profiles.items()):
        require(all(type(profile[field]) is int and profile[field] in (0, 1) for field in FLAGS), 'invalid_channel_flags')
        require(policies[entity]['policy'] in ('realtime', 'periodic', 'lightweight', 'off'), 'invalid_monitoring_policy')
        require(entities[entity]['lifecycle'] in ('candidate', 'probation', 'active', 'elite', 'degraded', 'suspended'), 'invalid_lifecycle')
        settings.append({'entityId': entity, 'displayName': profile['display_name'], 'priority': profile['priority'],
            'notes': profile['notes'], 'channels': {field: bool(profile[field]) for field in FLAGS},
            'policy': policies[entity]['policy'], 'legacyLifecycle': entities[entity]['lifecycle'],
            'suspended': entities[entity]['lifecycle'] == 'suspended'})
    return {'format': 'address-only-import-candidate-v1', 'sourceSha256': source_sha256,
        'accounts': [{'accountId': key, 'handle': value['handle']} for key, value in sorted(accounts.items())],
        'wallets': wallets, 'settings': settings, 'grantsBusinessEligibility': False,
        'historicalJobsImported': False, 'gatewayDeliveryEnabled': False, 'activationAuthorized': False}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    fd = os.open(args.seed, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4 * 1024 * 1024, 'unsafe_seed')
        raw = stream.read(4 * 1024 * 1024 + 1)
    digest = hashlib.sha256(raw).hexdigest()
    require(digest == args.expected_sha256, 'seed_digest_mismatch')
    candidate = prepare(json.loads(raw), digest)
    body = json.dumps(candidate, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    os.umask(0o077)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'status': 'prepared-not-imported', 'wallets': len(candidate['wallets']),
        'entities': len(candidate['settings']), 'sha256': hashlib.sha256(body).hexdigest(), 'activationAuthorized': False}))

if __name__ == '__main__':
    main()
