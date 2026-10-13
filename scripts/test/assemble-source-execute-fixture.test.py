import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('assemble_fixture', Path(__file__).with_name('assemble-source-execute-fixture.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AssemblyBoundaryTests(unittest.TestCase):
    def test_production_scope_refused_before_reading_materials(self):
        with self.assertRaisesRegex(ValueError, 'fixture_scope'):
            module.assemble('/var/lib/address-radar-maintenance-tools/production', {}, 0)

    def test_missing_real_materials_are_not_synthesized(self):
        with self.assertRaisesRegex(ValueError, 'fixture_materials_shape'):
            module.assemble('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef', {}, 0)

    def test_outside_scope_pin_refused(self):
        with self.assertRaisesRegex(ValueError, 'fixture_pin_scope'):
            module.pin(Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef'), '/etc/passwd')


if __name__ == '__main__':
    unittest.main()
