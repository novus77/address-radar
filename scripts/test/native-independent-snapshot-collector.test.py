import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / 'native-independent-snapshot-collector.py'
SPEC = importlib.util.spec_from_file_location('native_snapshot_entry', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BindingTests(unittest.TestCase):
    def fixture(self):
        nonce, request, pin = 'a' * 16, 'b' * 16, 'c' * 64
        control = '/var/lib/address-radar-rehearsal-artifact-control/' + nonce
        root = '/var/lib/address-radar-rehearsal-artifacts/' + nonce
        job = dict(nonce=nonce, requestNonce=request, expirySha256=pin,
                   bindingPath=control + '/invocations/' + request + '-verifier.binding.json',
                   producerDirectory=root + '/snapshot', measurementPath=root + '/snapshot/measurement.json')
        expiry = dict(nonce=nonce, artifacts=dict(root=root, control=dict(root=control)))
        binding = dict(unit='radar-rehearsal-' + nonce + '-verifier-' + request + '.service',
                       role='verifier', request_nonce=request, record_sha256=pin,
                       policy=dict(receipt_directory=control + '/receipts/' + request))
        return job, expiry, binding

    def test_exact_frozen_helper_namespace(self):
        job, expiry, binding = self.fixture()
        self.assertEqual(MODULE.validate_binding(job, expiry, binding), binding['policy']['receipt_directory'])

    def test_unknown_unit_or_producer_or_record_refused(self):
        for key, value in [('role', 'producer'), ('unit', 'other.service'), ('record_sha256', 'd' * 64)]:
            job, expiry, binding = self.fixture()
            binding[key] = value
            with self.assertRaises(MODULE.Refused):
                MODULE.validate_binding(job, expiry, binding)

    def test_outside_or_traversal_artifact_path_refused(self):
        for path in ['/tmp/snapshot', '/var/lib/address-radar-rehearsal-artifacts/' + 'a' * 16 + '/../snapshot']:
            job, expiry, binding = self.fixture()
            job['producerDirectory'] = path
            with self.assertRaises(MODULE.Refused):
                MODULE.validate_binding(job, expiry, binding)

    def test_no_cross_request_receipt_output(self):
        job, expiry, binding = self.fixture()
        binding['policy']['receipt_directory'] += '-other'
        with self.assertRaises(MODULE.Refused):
            MODULE.validate_binding(job, expiry, binding)



class WorkCleanupTests(unittest.TestCase):
    def test_owned_work_removed_and_sanitized_audit(self):
        import tempfile, os, time
        with tempfile.TemporaryDirectory() as parent:
            os.chmod(parent, 0o700)
            with MODULE.WorkArea(parent, time.monotonic() + 10, lambda: None) as work:
                pathlib.Path(work.path, 'snapshot.sqlite').write_bytes(b'business-secret')
                audit = work.clean()
                self.assertEqual(audit['removedEntries'], 1)
                self.assertFalse(pathlib.Path(work.path).exists())
                self.assertNotIn('business-secret', str(audit))
                self.assertNotIn('snapshot.sqlite', str(audit))

    def test_unknown_symlink_hardlink_or_overbound_tree_no_delete(self):
        import tempfile, os, time
        for attack in ['symlink', 'hardlink', 'bound']:
            with tempfile.TemporaryDirectory() as parent:
                os.chmod(parent, 0o700)
                with self.assertRaises(MODULE.Refused), MODULE.WorkArea(parent, time.monotonic() + 10, lambda: None) as work:
                    victim = pathlib.Path(work.path, 'data'); victim.write_bytes(b'keep')
                    if attack == 'symlink':
                        pathlib.Path(work.path, 'link').symlink_to('/etc/passwd')
                    elif attack == 'hardlink':
                        os.link(victim, pathlib.Path(work.path, 'link'))
                    else:
                        work.maximum = 0
                    with self.assertRaises(MODULE.Refused): work.clean()
                    self.assertEqual(victim.read_bytes(), b'keep')

    def test_preexisting_work_and_parent_replacement_refused(self):
        import tempfile, os, time
        with tempfile.TemporaryDirectory() as parent:
            os.chmod(parent, 0o700); pathlib.Path(parent, 'snapshot-work').mkdir()
            with self.assertRaises(FileExistsError):
                MODULE.WorkArea(parent, time.monotonic() + 10, lambda: None)
        with tempfile.TemporaryDirectory() as parent:
            os.chmod(parent, 0o700)
            with self.assertRaises(MODULE.Refused), MODULE.WorkArea(parent, time.monotonic() + 10, lambda: None) as work:
                os.rename(work.path, work.path + '-replaced'); os.mkdir(work.path, 0o700)
                with self.assertRaises(MODULE.Refused): work.clean()

    def test_failure_path_cleanup_and_retained_unexpected_file_refusal(self):
        import tempfile, os, time
        with tempfile.TemporaryDirectory() as parent:
            os.chmod(parent, 0o700)
            with MODULE.WorkArea(parent, time.monotonic() + 10, lambda: None) as work:
                pathlib.Path(work.path, 'partial').write_bytes(b'partial')
                work.clean()
                pathlib.Path(parent, 'unexpected').write_bytes(b'not-approved')
                with self.assertRaises(MODULE.Refused): work.retained_audit()


if __name__ == '__main__':
    unittest.main()
