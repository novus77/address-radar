"""Offline container-only composition: real reader, bundled TS validator and prepare.

All approvals, COMPLETE metadata and release module bodies are synthetic fixtures.
No database, ledger, provider, service, rotation or production authority is exercised.
The original validator bundle is used unchanged. A separate fixture-only copy
exports its existing pure source-plan functions to generate hashes without guesses.

Run with ASSEMBLER_NATIVE_CONTAINER=1, ASSEMBLER_VALIDATOR_BUNDLE pointing to the
reviewed bundle, in a disposable root Linux container with --network=none. Never
mount host /opt, /etc or /var into this container.
"""
import copy
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_assembly', SCRIPTS / 'assemble-production-source-execution.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def put(path, value, mode=0o444):
    raw = value if isinstance(value, bytes) else m.encode(value)
    with path.open('xb') as stream:
        stream.write(raw)
    path.chmod(mode)
    return {'path': str(path), 'sha256': digest(raw)}


ENABLED = (os.environ.get('ASSEMBLER_NATIVE_CONTAINER') == '1'
           and sys.platform == 'linux' and os.geteuid() == 0)


@unittest.skipUnless(ENABLED, 'requires explicitly opted-in disposable offline Linux root container')
class NativeAssemblyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Refuse a normally networked host even if the opt-in variable is present.
        interfaces = [name for _, name in socket.if_nameindex() if name != 'lo']
        if (not Path('/.dockerenv').is_file() or any(
                int((Path('/sys/class/net') / name / 'flags').read_text().strip(), 16) & 1
                for name in interfaces)):
            raise RuntimeError('disposable_offline_docker_required')
        cls.token = secrets.token_hex(8)
        m.ROOT.mkdir(parents=True, exist_ok=True, mode=0o755)
        cls.common = m.ROOT / ('assembler-native-fixture-' + cls.token)
        cls.common.mkdir(mode=0o700)
        bundle = Path(os.environ['ASSEMBLER_VALIDATOR_BUNDLE']).read_bytes()
        if b'function createSourceReplacementPlan(' not in bundle or b'function migrationCutoverCanonicalJson(' not in bundle:
            raise RuntimeError('reviewed_bundle_pure_fixture_exports_unavailable')
        cls.validator = put(cls.common / 'validator.mjs', bundle)
        # This copy is never passed as materialValidator to production prepare.
        cls.plan_module = put(cls.common / 'fixture-plan.mjs', bundle +
            b'\nexport { createSourceReplacementPlan, migrationCutoverCanonicalJson };\n')
        node_source = Path(shutil.which('node')).resolve()
        cls.node = put(cls.common / 'node', node_source.read_bytes(), 0o555)
        cls.python = put(cls.common / 'python', Path(sys.executable).resolve().read_bytes(), 0o555)
        runner = b'''import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createSourceReplacementPlan,migrationCutoverCanonicalJson} from './fixture-plan.mjs';
const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
input.trustedReviewSha256=createHash('sha256').update(migrationCutoverCanonicalJson(input.review)).digest('hex');
const plan=createSourceReplacementPlan(input);
fs.writeFileSync(process.argv[3],JSON.stringify({input,material:plan.material,replacementSha256:plan.replacementSha256}),{flag:'wx',mode:384});
'''
        cls.runner = put(cls.common / 'fixture-runner.mjs', runner)
        try:
            pwd.getpwnam('address-radar')
        except KeyError:
            subprocess.run(['/usr/sbin/useradd', '-U', '-M', '-s', '/usr/sbin/nologin', 'address-radar'],
                           check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        cls.wallet_name = 'fixture_wallet_' + cls.token
        subprocess.run(['/usr/sbin/useradd', '-U', '-M', '-s', '/usr/sbin/nologin', cls.wallet_name],
                       check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        account = pwd.getpwnam(cls.wallet_name)
        cls.wallet = {'user': account.pw_name, 'group': grp.getgrgid(account.pw_gid).gr_name,
                      'uid': account.pw_uid, 'gid': account.pw_gid}
        Path('/opt/address-radar/releases').mkdir(parents=True, exist_ok=True, mode=0o755)

    def setUp(self):
        self.token = secrets.token_hex(8)
        self.operation = 'native-assembly-' + self.token
        self.directory = self.common / self.token
        self.directory.mkdir(mode=0o700)
        self.destination = m.ROOT / ('source-execution-preparation-' + self.token)
        self.generation = 'production-20261006-v1'
        self.approval = 'fixture-only-no-production-authority'
        self.release = self.make_release()
        at = int(m.time.time() * 1000)
        self.deadline = at + 180000
        old_sha = digest(b'synthetic-origin-release-not-executed')
        schema_sha = digest(b'synthetic-schema-contract-not-a-database-proof')
        manifest = {'operationId': self.operation, 'generationId': self.generation,
                    'releaseSha256': old_sha, 'fixtureOnly': True}
        authority_credential = self.write('authority-credential', {'fixtureOnly': True})
        authority_key = self.write('authority-key', {'fixtureOnly': True})
        operator_credential = self.write('operator-credential', {'fixtureOnly': True})
        evidence = digest(b'synthetic-reviewed-provider-contract')
        old_provider, old_origin = 'solana-helius-source', 'https://helius.example'
        old_material = {
            'authority': {'generationId': self.generation, 'releaseSha256': old_sha, 'username': 'fixture_publisher',
                'credential': authority_credential, 'privateKey': authority_key,
                'validator': {'validationTtlMs': 60000, 'reviewedProviderBindings': [{
                    'chain': 'solana', 'sourceProviderId': old_provider, 'sourceEndpoint': old_origin + '/private',
                    'replayProviderId': 'solana-official-replay', 'replayEndpoint': 'https://api.mainnet-beta.solana.com',
                    'expectedGenesisHash': 'fixture-only-not-verified'}]},
                'publisher': {'maximumValidationAgeMs': 60000}},
            'deployment': {'operationId': self.operation, 'generationId': self.generation,
                'releaseRoot': '/opt/address-radar/releases/address-only-fixture-origin',
                'cutover': {'addressOnly': manifest},
                'driver': {'schemaVersion': 3, 'schemaFingerprint': schema_sha},
                'gatewayDeliveryEnabled': False, 'fomoEnabled': False, 'fullHistoricalMiningEnabled': False,
                'walletExecution': {'solana': {'providerId': old_provider, 'endpoint': old_origin + '/private',
                    'maximumRunMs': 5000}, 'receiver': {'maximumRunMs': 5000}},
                'executionRetry': {'maximumCaptures': 1, 'maximumRunMs': 5000}},
            'settings': {'protocol': 'address-only-configured-preflight-settings-v1', 'validators': [],
                'credential': operator_credential, 'providerContracts': [{'providerId': old_provider,
                    'origin': old_origin, 'importId': 'fixture-old-contract', 'sourceFingerprint': evidence,
                    'windowMs': 60000, 'maximumRequests': 60, 'maximumConcurrency': 1}]},
            'environment': {'RADAR_RPC_SOLANA_HTTP_URL': old_origin + '/private',
                'ADDRESS_RADAR_POSTGRES_RELEASE_SHA256': old_sha,
                'ADDRESS_RADAR_POSTGRES_ENTRY_SHA256': old_sha,
                'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256': old_sha,
                **{flag: 'false' for flag in ('ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED',
                    'ADDRESS_RADAR_FOMO_BROWSER_ENABLED', 'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED',
                    'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED')}}}
        review = {'version': 1, 'importId': 'fixture-publicnode-' + self.token, 'approvalRef': self.approval,
            'generationId': self.generation, 'importedAt': at, 'contractRef': 'fixture-only-publicnode-terms',
            'budgets': [{'providerId': 'solana-publicnode-source', 'origin': 'https://solana-rpc.publicnode.com',
                'windowStartedAt': at, 'windowMs': 60000, 'maximumRequests': 60, 'requestsUsed': 0,
                'maximumConcurrency': 1, 'cooldownUntil': '0'}]}
        source = {'oldProviderId': old_provider, 'oldOrigin': old_origin, 'oldOperator': 'Helius',
            'newOperator': 'Allnodes/PublicNode', 'review': review, 'material': old_material}
        raw_source = self.write('raw-source', source)
        result_path = self.directory / 'source-plan-result.json'
        subprocess.run([self.node['path'], '--no-global-search-paths', self.runner['path'], raw_source['path'], str(result_path)],
                       check=True, timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        result = json.loads(result_path.read_bytes())
        self.source = result['input']
        final = result['material']
        final['authority']['releaseSha256'] = self.release['releaseSha256']
        final['deployment']['releaseRoot'] = self.release['root']
        final['deployment']['cutover']['addressOnly']['releaseSha256'] = self.release['releaseSha256']
        self.final_pins = {name: self.write('final-' + name, final[name]) for name in ('authority', 'deployment', 'settings')}
        env = final['environment']
        env.update(ADDRESS_RADAR_POSTGRES_RELEASE_SHA256=self.release['releaseSha256'],
                   ADDRESS_RADAR_POSTGRES_ENTRY_SHA256=self.release['entryPin']['sha256'])
        for name, key in (('authority', 'AUTHORITY'), ('deployment', 'DEPLOYMENT'), ('settings', 'CONFIGURED_PREFLIGHT')):
            env['ADDRESS_RADAR_POSTGRES_' + key + '_FILE'] = self.final_pins[name]['path']
            env['ADDRESS_RADAR_POSTGRES_' + key + '_SHA256'] = self.final_pins[name]['sha256']
        environment = self.write('final-environment', env)
        controllers = {key: self.copy_script(key, filename) for key, filename in {
            'activation': 'activate-address-only-postgres.py', 'configured': 'activate-address-only-configured.py',
            'controller': 'run-address-only-native-controller.py', 'fence': 'address-only-native-fence.py',
            'pgFence': 'pg-source-replacement-fence.py'}.items()}
        config = {'protocol': 'address-only-controller-v1', 'operationId': self.operation,
            'fence': controllers['fence'], 'node': self.node,
            'outputDirectory': str(m.ROOT / ('address-only-run-' + self.operation)),
            'reconcile': self.copy_script('reconcile', 'address-only-pg-reconcile.py'),
            **{key: self.write(key, b'# Fixture-only unused controller tool.\n')
               for key in ('exporter', 'validator', 'launcher')}}
        config['jobTemplate'] = {'operationId': self.operation, 'action': 'plan',
            'outputDirectory': config['outputDirectory'], 'sourceFence': config['fence']}
        old_state = self.write('old-state', {'phase': 'COMPLETE', 'operationId': self.operation,
            'receipt': {'sourceMonitoring': 'waiting_configuration'}, 'fixtureOnly': True})
        original = self.write('original-manifest', manifest)
        transition = {'protocol': 'address-only-configured-transition-v1', 'transitionId': self.operation,
            'authorizationRef': self.approval, 'deadlineAtMs': self.deadline, 'oldState': old_state,
            'originalManifest': original, 'releaseRoot': self.release['root'], 'releaseSha256': self.release['releaseSha256'],
            'node': self.node, 'deployment': self.final_pins['deployment'], 'environment': environment,
            'nativeVerifier': self.write('unused-native-verifier', b'// Fixture only: never executed.\n'),
            'resourcePolicy': dict(m.CONFIGURED_POLICY), 'walletServiceUser': self.wallet}
        target = {'systemIdentifier': '7693392208475083526', 'database': 'address_radar',
            'schema': 'address_radar_business', 'username': 'address_radar_migrator', 'generation': self.generation,
            'service': 'migrator', 'serverAddress': '127.0.0.1', 'serverPort': 5432,
            'schemaVersion': 3, 'schemaFingerprint': schema_sha}
        probe = {'protocol': 'address-only-configured-source-probe-job-v1', 'deadlineAtMs': self.deadline,
            'deployment': self.final_pins['deployment'], 'environment': environment, **self.final_pins,
            **{name: self.write('unused-' + name, {'fixtureOnly': True}) for name in ('runtimeAuthority', 'credential', 'payload')},
            'maximumRunMs': 5000, 'maximumBodyBytes': 2097152}
        stage = {'protocol': 'address-only-code-stage-receipt-v1', 'status': 'CODE_STAGED_ONLY', 'stageOnly': True,
            'authorizationRef': self.approval, 'transitionId': self.operation, 'release': self.release,
            'nativeNode': {'pin': self.node}, 'permanentPins': {'oldState': old_state, 'originalManifest': original},
            'fixtureOnly': True, 'productionProof': False}
        self.materials = {'protocol': 'address-only-production-execution-materials-v1',
            'operationId': self.operation, 'approvalRef': self.approval, 'replacementSha256': result['replacementSha256'],
            'rotationNonce': self.token, 'controllerPins': controllers,
            'tools': {'node': self.node, 'python': self.python,
                **{key: self.write('tool-' + key, b'// Fixture-only unused execution tool.\n')
                   for key in ('rotation', 'rotationSupport', 'import', 'probe')}},
            'materialValidator': self.validator, 'controllerConfig': self.write('config', config),
            'transition': self.write('transition', transition), 'stageReceipt': self.write('stage', stage),
            'importTemplate': self.write('import', {'input': self.write('source', self.source), 'target': target}),
            'probeTemplate': self.write('probe', probe),
            'fenceRequest': self.write('fence-request', {'protocol': 'address-only-pg-source-fence-v1',
                'operationId': self.operation, 'replacementSha256': result['replacementSha256'],
                'generationId': self.generation, 'oldProviderId': old_provider, 'oldOrigin': old_origin,
                'newProviderId': 'solana-publicnode-source', 'newOrigin': 'https://solana-rpc.publicnode.com',
                'authorizationRef': self.approval, 'deadlineAtMs': self.deadline, 'publishedFiles': []}),
            'adapter': self.copy_script('adapter', 'source-replacement-controller-adapter.py'),
            'sequence': self.copy_script('sequence', 'run-pg-source-replacement.py'),
            'selfPin': self.copy_script('execute-pg-source-replacement.py', 'execute-pg-source-replacement.py')}

    def write(self, name, value):
        return put(self.directory / name, value)

    def copy_script(self, name, source):
        return self.write(name, (SCRIPTS / source).read_bytes())

    def make_release(self):
        root = Path('/opt/address-radar/releases') / ('address-only-native-fixture-' + self.token)
        root.mkdir(mode=0o755)
        (root / 'scripts').mkdir(mode=0o755)
        pins = {}
        for name, key in (('pg.mjs', 'pgPin'), ('scripts/postgres-address-only-dispatch.mjs', 'dispatcherPin'),
                          ('scripts/postgres-service-entry.mjs', 'entryPin')):
            pins[key] = put(root / name, b'// Synthetic sealed inventory fixture; never executed.\n')
        (root / 'scripts').chmod(0o555)
        root.chmod(0o555)
        rows = []
        for name in ('.', 'pg.mjs', 'scripts', 'scripts/postgres-address-only-dispatch.mjs', 'scripts/postgres-service-entry.mjs'):
            path = root / name
            info = path.lstat()
            directory = stat.S_ISDIR(info.st_mode)
            row = {'path': name, 'mode': stat.S_IMODE(info.st_mode), 'kind': 'directory' if directory else 'file'}
            if not directory:
                row.update(size=info.st_size, sha256=digest(path.read_bytes()))
            rows.append(row)
        raw = ''.join(json.dumps(row, separators=(',', ':')) + '\n' for row in rows).encode()
        return {'root': str(root), 'releaseSha256': digest(raw), **pins}

    def prepare(self):
        pin = self.write('materials-' + secrets.token_hex(4), self.materials)
        return m.prepare(pin, str(self.destination))

    def assert_no_output(self):
        self.assertFalse(self.destination.exists())

    def test_real_prepare_persists_exact_job_receipt_and_refuses_reuse(self):
        receipt = self.prepare()
        self.assertEqual(receipt['status'], 'PREPARED_NOT_EXECUTED')
        self.assertFalse(receipt['activationPerformed'])
        self.assertFalse(receipt['retryAuthorized'])
        self.assertEqual(json.loads((self.destination / 'preparation-receipt.json').read_bytes()), receipt)
        job_raw = (self.destination / 'execution-job.json').read_bytes()
        self.assertEqual(digest(job_raw), receipt['job']['sha256'])
        job = json.loads(job_raw)
        self.assertEqual(job['operationId'], self.operation)
        self.assertEqual(job['tools']['node'], self.node)
        self.assertEqual(job['transition'], self.materials['transition'])
        self.assertEqual(job['protocol'], 'address-only-source-replacement-execution-v1')
        self.assertFalse(Path(job['outputDirectory']).exists())
        self.assertFalse(Path(job['rotationDirectory']).exists())
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        for name in ('execution-job.json', 'preparation-receipt.json'):
            self.assertEqual(stat.S_IMODE((self.destination / name).stat().st_mode), 0o600)
        before = {path.name: path.read_bytes() for path in self.destination.iterdir()}
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual({path.name: path.read_bytes() for path in self.destination.iterdir()}, before)

    def test_real_helper_rejects_changed_review_hash(self):
        source = copy.deepcopy(self.source)
        source['trustedReviewSha256'] = digest(b'unapproved-fixture-review')
        template = json.loads(Path(self.materials['importTemplate']['path']).read_bytes())
        template['input'] = self.write('changed-source', source)
        self.materials['importTemplate'] = self.write('changed-import', template)
        with self.assertRaisesRegex(ValueError, 'material_validation'):
            self.prepare()
        self.assert_no_output()

    def test_real_helper_rejects_bound_but_changed_final_budget(self):
        settings = json.loads(Path(self.final_pins['settings']['path']).read_bytes())
        settings['providerContracts'][0]['maximumRequests'] = 61
        settings_pin = self.write('changed-settings', settings)
        probe = json.loads(Path(self.materials['probeTemplate']['path']).read_bytes())
        transition = json.loads(Path(self.materials['transition']['path']).read_bytes())
        environment = json.loads(Path(transition['environment']['path']).read_bytes())
        environment['ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE'] = settings_pin['path']
        environment['ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256'] = settings_pin['sha256']
        environment_pin = self.write('changed-environment', environment)
        transition['environment'] = environment_pin
        probe.update(settings=settings_pin, environment=environment_pin)
        self.materials['transition'] = self.write('changed-transition', transition)
        self.materials['probeTemplate'] = self.write('changed-probe', probe)
        with self.assertRaisesRegex(ValueError, 'material_validation'):
            self.prepare()
        self.assert_no_output()

    def test_real_reader_rejects_tampered_dependency(self):
        path = Path(self.final_pins['settings']['path'])
        path.chmod(0o644)
        path.write_bytes(path.read_bytes() + b' ')
        path.chmod(0o444)
        with self.assertRaisesRegex(ValueError, 'pin_changed'):
            self.prepare()
        self.assert_no_output()

    def test_real_reader_rejects_unsealed_release(self):
        Path(self.release['entryPin']['path']).chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'release_seal'):
            self.prepare()
        self.assert_no_output()

    def test_existing_execution_attempt_is_not_reused(self):
        attempted = m.ROOT / ('source-replacement-execution-' + self.operation)
        attempted.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'attempt_collision'):
            self.prepare()
        self.assert_no_output()


if __name__ == '__main__':
    unittest.main()
