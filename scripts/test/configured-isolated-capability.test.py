import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('configured_capability', Path(__file__).parents[1]/'activate-address-only-configured.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CapabilityTests(unittest.TestCase):
    def test_production_does_not_request_isolated_capability(self):
        self.assertIsNone(module.configured_isolated_target(SimpleNamespace(), None, {}, {}))

    def test_isolated_origin_requires_real_verifier_and_exact_record(self):
        capability = object()
        recorded = {'jobPin': {'path': '/isolated/job', 'sha256': 'a'*64}, 'target': {'database': 'fixture'}}
        calls = []
        def verify(*args):
            calls.append(args)
            return capability
        base = SimpleNamespace(_verify_isolated_target=verify, _isolated_target=lambda cap: recorded)
        old = {'isolatedActivation': recorded, 'releaseRoot': '/isolated/release', 'nodePath': '/isolated/node'}
        config = {'launcher': {'path': '/isolated/generator', 'sha256': 'b'*64}}
        self.assertIs(module.configured_isolated_target(base, 'controller', config, old), capability)
        self.assertEqual(calls, [('controller', config, config['launcher'], recorded['jobPin'], old['releaseRoot'], old['nodePath'])])
        base._isolated_target = lambda cap: dict(recorded, target={'database': 'other'})
        with self.assertRaisesRegex(ValueError, 'configured_isolated_origin_changed'):
            module.configured_isolated_target(base, 'controller', config, old)

    def test_verifier_rejection_is_not_converted_to_production(self):
        def refuse(*args):
            raise ValueError('isolated_activation_pg_identity')
        with self.assertRaisesRegex(ValueError, 'isolated_activation_pg_identity'):
            module.configured_isolated_target(SimpleNamespace(_verify_isolated_target=refuse), None,
                {'launcher': {}}, {'isolatedActivation': {'jobPin': {}}, 'releaseRoot': '/fixture', 'nodePath': '/fixture/node'})


if __name__ == '__main__':
    unittest.main()
