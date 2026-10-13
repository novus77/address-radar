import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('capacity', Path(__file__).parents[1] / 'measure-address-only-capacity.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class CapacityTest(unittest.TestCase):
    def test_insufficient_memory_refuses_without_launch(self):
        with self.assertRaisesRegex(RuntimeError, 'memory_headroom'):
            module.check_headroom(512 * 1024**2, 10 * 1024**3)

    def test_insufficient_disk_refuses_without_launch(self):
        with self.assertRaisesRegex(RuntimeError, 'disk_headroom'):
            module.check_headroom(2 * 1024**3, 2 * 1024**3)

    def test_measurement_requires_all_six_and_positive_peak(self):
        with self.assertRaisesRegex(RuntimeError, 'incomplete_measurement'):
            module.make_receipt(5, 1024, 'a' * 64, 'b' * 64, {})
        with self.assertRaisesRegex(RuntimeError, 'incomplete_measurement'):
            module.make_receipt(6, 0, 'a' * 64, 'b' * 64, {})

    def test_startup_measurement_never_claims_full_load_or_cutover(self):
        result = module.make_receipt(6, 1000000, 'a' * 64, 'b' * 64, {'availableRamBytes': 2 * 1024**3})
        self.assertEqual(result['scope'], 'six-process-module-startup-only')
        self.assertFalse(result['steadyStateCapacityVerified'])
        self.assertFalse(result['activationAuthorized'])

if __name__ == '__main__':
    unittest.main()
