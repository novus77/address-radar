import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('cmetadata', Path(__file__).parents[1] / 'prepare-address-only-stability-c-metadata.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def fixture():
    h = 'a' * 64
    p = lambda path: {'path': path, 'sha256': h}
    original = {'operationId': 'operation', 'generationId': M.GENERATION, 'activatedAt': M.ACTIVATED_AT,
                'importId': 'import', 'releaseSha256': '0' * 64}
    node = copy.deepcopy(M.NODE)
    request = {'protocol': 'address-only-configured-transition-v1', 'transitionId': 'stability-20261009b',
               'authorizationRef': 'previous', 'deadlineAtMs': 0, 'oldState': p('/permanent/old.json'),
               'originalManifest': p('/permanent/original.json'), 'releaseRoot': M.B_RELEASE, 'releaseSha256': h,
               'node': node, 'deployment': {'path': M.B_ROOT + '/deployment.json', 'sha256': M.B_PINS['deployment.json']},
               'environment': {'path': M.B_ROOT + '/environment.json', 'sha256': M.B_PINS['environment.json']},
               'nativeVerifier': p('/permanent/verifier.mjs'), 'resourcePolicy': {'keep': True},
               'walletServiceUser': {'user': 'wallet', 'group': 'wallet'},
               'configuredOrigin': {'degradedRecovery': {'old': True}}}
    providers = {chain: {'providerId': chain + '-source', 'expectedChainId': '56' if chain == 'bsc' else '8453',
                         'expectedGenesisBlockHash': '0x' + h, 'endpoint': 'https://private.invalid/DO_NOT_PRINT'}
                 for chain in ('bsc', 'base')}
    deployment = {'releaseRoot': M.B_RELEASE, 'generationId': M.GENERATION, 'activatedAt': M.ACTIVATED_AT,
                  'operationId': 'operation', 'cutover': {'addressOnly': dict(original, releaseSha256=h)},
                  'execution': {'maximumEntries': 5, 'maximumBytes': 100}, 'wallet': {'maximumProfiles': 256},
                  'lifecycle': {'pollMs': 15000}, 'services': {'wallet-monitor': {'intervalMs': 15000}},
                  'walletExecution': {'receiver': {'maximumRunMs': 9000}, 'evm': providers},
                  **{k: False for k in M.SAFETY}}
    environment = {'ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE': M.B_ROOT + '/authority.json',
                   'ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256': M.B_PINS['authority.json'],
                   **{k: 'false' for k in ('ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED', 'ADDRESS_RADAR_FOMO_BROWSER_ENABLED',
                                          'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED')}}
    authority = {'generationId': M.GENERATION, 'operationId': 'operation', 'releaseSha256': h, 'secret': 'DO_NOT_PRINT'}
    source = dict(zip(M.B_PINS, (authority, deployment, environment, request)))
    job = {'protocol': 'address-only-stability-c-metadata-job-v1', 'authorizationRef': 'approved-technical-metadata',
           'floorReceipt': p('/private/floor-receipt.json'),
           'journal': p(M.ORIGIN_ROOT + '/configured-stability-20261009b-state.json'),
           'receipt': p(M.ORIGIN_ROOT + '/configured-stability-20261009b-receipt.json')}
    receipt = {'protocol': 'address-only-configured-transition-receipt-v1', 'transitionId': request['transitionId'],
               'sourceMonitoring': 'configured_pending_observation', 'releaseSha256': h, 'operationId': 'operation',
               'generationId': M.GENERATION, 'importId': 'import', 'databaseImported': True, 'newImportPerformed': False,
               'businessReleaseSwitched': True, 'monitoringCompleted': False, 'businessEligibilityGranted': False,
               **{k: False for k in M.SAFETY}}
    journal = {'phase': 'COMPLETE', 'pending': None, 'receipt': receipt, 'transitionId': request['transitionId'],
               'operationId': 'operation', 'release': {'releaseSha256': h}, 'configuredReleaseRoot': M.B_RELEASE,
               'node': node, 'walletServiceUser': request['walletServiceUser']}
    floors = {'bsc': 126398984, 'base': 52326456}
    proof = []
    for chain, value in floors.items():
        proof.append({'chain': chain, 'providerId': providers[chain]['providerId'], 'chainId': providers[chain]['expectedChainId'],
                      'genesisHash': '0x' + h, 'activatedAt': M.ACTIVATED_AT, 'fromBlock': value,
                      'before': {'number': value - 1, 'timestamp': M.ACTIVATED_AT // 1000, 'hash': '0x' + h},
                      'header': {'number': value, 'timestamp': M.ACTIVATED_AT // 1000 + 1,
                                 'parentHash': '0x' + h, 'hash': '0x' + 'b' * 64}})
    floor = {'protocol': 'address-only-evm-floor-receipt-v1', 'generationId': M.GENERATION,
             'activatedAt': M.ACTIVATED_AT, 'releaseSha256': h, 'authoritySha256': M.B_PINS['authority.json'],
             'deploymentSha256': M.B_PINS['deployment.json'], 'environmentSha256': M.B_PINS['environment.json'],
             'currentJournalSha256': h, 'currentReceiptSha256': h, 'floors': floors, 'floorEnvironment': json.dumps(floors),
             'chains': proof, **{k: False for k in ('businessFactsWritten', 'checkpointWritten', 'activationGranted', 'signalPermissionGranted')}}
    return source, job, floor, journal, receipt, original


class MetadataTests(unittest.TestCase):
    def test_stability_stamp_ignores_read_atime_but_detects_mutation(self):
        fields = {k: 1 for k in ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid',
                                 'st_nlink', 'st_mtime_ns', 'st_ctime_ns', 'st_atime_ns')}
        before = SimpleNamespace(**fields)
        self.assertEqual(M.file_stamp(before), M.file_stamp(SimpleNamespace(**dict(fields, st_atime_ns=2))))
        self.assertNotEqual(M.file_stamp(before), M.file_stamp(SimpleNamespace(**dict(fields, st_ctime_ns=2))))

    def test_exact_tuning_and_pin_chain_without_mutating_source(self):
        values = fixture(); previous = copy.deepcopy(values)
        result = M.build_metadata(*values)
        self.assertEqual(values, previous)
        a, d, e, r = (result[n] for n in M.B_PINS)
        self.assertEqual(a['releaseSha256'], M.RELEASE_SHA)
        self.assertEqual(d['wallet'], {'maximumProfiles': 256, 'collectorQuota': 1, 'maximumRunMs': 24000, 'leaseMs': 60000})
        self.assertEqual(d['execution'], {'maximumEntries': 5, 'maximumBytes': 1192952})
        self.assertEqual(d['walletExecution']['receiver']['maximumRunMs'], 5000)
        self.assertEqual(d['lifecycle']['pollMs'], 30000)
        self.assertEqual(d['services']['wallet-monitor']['intervalMs'], 5000)
        self.assertEqual(e['ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE'], '1')
        self.assertEqual(e['ADDRESS_RADAR_SOLANA_SIGNATURE_LIMIT'], '10')
        self.assertEqual(json.loads(e['ADDRESS_RADAR_EVM_BOOTSTRAP_FLOORS']), values[2]['floors'])
        self.assertEqual(e['ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256'], M.sha(M.encode(a)))
        self.assertEqual(r['deployment']['sha256'], M.sha(M.encode(d)))
        self.assertEqual(r['environment']['sha256'], M.sha(M.encode(e)))
        self.assertEqual(r['deadlineAtMs'], 0)
        self.assertEqual(set(r['configuredOrigin']), {'journal', 'receipt', 'releaseRoot', 'node'})
        for k in ('oldState', 'originalManifest', 'node', 'nativeVerifier', 'resourcePolicy', 'walletServiceUser'):
            self.assertEqual(r[k], values[0]['request-template.json'][k])
        self.assertEqual(d['walletExecution']['evm'], values[0]['deployment.json']['walletExecution']['evm'])

    def test_refuses_activation_generation_and_receipt_pin_drift(self):
        for field in ('activatedAt', 'generationId', 'authoritySha256', 'deploymentSha256', 'environmentSha256',
                      'currentJournalSha256', 'currentReceiptSha256', 'releaseSha256'):
            with self.subTest(field=field):
                values = fixture(); values[2][field] = 0 if field == 'activatedAt' else 'wrong'
                with self.assertRaises(M.Refused):
                    M.build_metadata(*values)

    def test_refuses_missing_extra_invalid_or_placeholder_floors(self):
        for bad in ({'bsc': 1}, {'bsc': 1, 'base': 1, 'eth': 1}, {'bsc': 0, 'base': 1},
                    {'bsc': 'PLACEHOLDER', 'base': 1}, {'bsc': True, 'base': 1}):
            with self.subTest(floors=bad):
                values = fixture(); values[2]['floors'] = bad; values[2]['floorEnvironment'] = json.dumps(bad)
                with self.assertRaises(M.Refused):
                    M.build_metadata(*values)

    def test_refuses_unbound_boundary_and_provider(self):
        for field, value in (('providerId', 'other'), ('fromBlock', 1), ('chainId', '1')):
            values = fixture(); values[2]['chains'][0][field] = value
            with self.assertRaises(M.Refused):
                M.build_metadata(*values)
        values = fixture(); values[2]['chains'][0]['header']['parentHash'] = '0x' + 'c' * 64
        with self.assertRaises(M.Refused):
            M.build_metadata(*values)

    def test_refuses_noncomplete_and_uncertain_origin(self):
        for field, value in (('phase', 'PENDING'), ('pending', {'operation': 'commit'})):
            values = fixture(); values[3][field] = value
            with self.assertRaises(M.Refused):
                M.build_metadata(*values)

    def test_refuses_safety_or_authority_pin_changes(self):
        for target in ('receipt', 'deployment', 'environment', 'authority'):
            values = fixture()
            if target == 'receipt': values[4]['gatewayDeliveryEnabled'] = True
            if target == 'deployment': values[0]['deployment.json']['fomoEnabled'] = True
            if target == 'environment': values[0]['environment.json']['ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED'] = 'true'
            if target == 'authority': values[0]['authority.json']['releaseSha256'] = 'changed'
            with self.assertRaises(M.Refused):
                M.build_metadata(*values)

    def test_exclusive_file_mode_fsync_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with patch.object(M.os, 'fsync', wraps=os.fsync) as sync:
                    M.write_exclusive(fd, 'authority.json', b'private')
                    self.assertEqual(sync.call_count, 2)
                self.assertEqual(os.stat(directory + '/authority.json').st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError): M.write_exclusive(fd, 'authority.json', b'replaced')
                self.assertEqual(Path(directory + '/authority.json').read_bytes(), b'private')
                with self.assertRaises(M.Refused): M.write_exclusive(fd, '../escape', b'private')
            finally:
                os.close(fd)

    def test_runner_preserves_failure_audit_and_refuses_existing_root(self):
        with tempfile.TemporaryDirectory() as parent:
            target = parent + '/new-c'
            with patch.object(M, 'C_ROOT', target), patch.object(M.os, 'geteuid', return_value=0), \
                 patch.object(M.sys, 'platform', 'linux'), \
                 patch.object(M, 'open_directory', side_effect=lambda p: os.open(p, os.O_RDONLY | os.O_DIRECTORY)), \
                 patch.object(M, 'read_pin', side_effect=M.Refused('input_failure')):
                with self.assertRaises(M.Refused): M.execute(fixture()[1])
                self.assertEqual(os.stat(target).st_mode & 0o777, 0o700)
                self.assertEqual(json.loads(Path(target + '/preparation-failed.json').read_bytes()), {'status': 'FAILED_NOT_ACTIVATED'})
                self.assertFalse(Path(target + '/preparation-complete.json').exists())
                with self.assertRaises(FileExistsError): M.execute(fixture()[1])


if __name__ == '__main__':
    unittest.main()
