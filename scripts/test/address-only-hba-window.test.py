import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('hba_window', Path(__file__).parents[1] / 'run-address-only-hba-rehearsal.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class HbaWindowTests(unittest.TestCase):
    def test_only_exact_isolated_rule_is_inserted(self):
        changed = module.temporary_body(module.ORIGINAL)
        self.assertEqual(changed.replace(module.RULE, b''), module.ORIGINAL)
        self.assertEqual(changed.count(module.RULE), 1)
        self.assertLess(changed.index(module.RULE), changed.index(b'host all all 127.0.0.1/32 reject'))
        self.assertNotIn(b'trust', changed)

    def test_changed_original_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'original_hba_changed'):
            module.temporary_body(module.ORIGINAL + b'# other change\n')

if __name__ == '__main__':
    unittest.main()
