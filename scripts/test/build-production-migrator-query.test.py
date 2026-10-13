"""Parse and evaluate the actual CLI SQL expression, not a parallel fixture query."""
import ast
import hashlib
import json
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'build-production-migrator-activation-plan.py'


def actual_query(plan):
    tree = ast.parse(SOURCE.read_text())
    nodes = [n for n in ast.walk(tree) if isinstance(n, ast.Assign)
             and any(isinstance(t, ast.Name) and t.id == 'sql' for t in n.targets)]
    if len(nodes) != 1: raise AssertionError('one authoritative query required')
    names = {'migration': plan['migratorRole'], **plan['serviceRoles']}
    env = {'plan': plan, 'names': names, 'literal': lambda text: "'" + text.replace("'", "''") + "'"}
    return eval(compile(ast.Expression(nodes[0].value), 'actual-query', 'eval'), env), names


def tokens(query):
    result = []; i = 0
    while i < len(query):
        if query[i] == "'":
            start = i; i += 1
            while i < len(query):
                if query[i] != "'": i += 1; continue
                if i + 1 < len(query) and query[i + 1] == "'": i += 2; continue
                i += 1; break
            else: raise AssertionError('unterminated SQL literal')
            result.append(query[start:i]); continue
        if query[i].isspace(): i += 1; continue
        if query[i].isalnum() or query[i] == '_':
            start = i
            while i < len(query) and (query[i].isalnum() or query[i] == '_'): i += 1
            result.append(query[start:i]); continue
        result.append(query[i]); i += 1
    return result


class QueryTests(unittest.TestCase):
    def plan(self):
        services = ['scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console']
        return {'schema': 'reviewed_schema', 'migratorRole': 'address_radar_migrator',
                'serviceRoles': {s: 'address_radar_' + s.replace('-', '_') for s in services}}

    def test_actual_expression_has_single_select_prefix_and_exact_role_in_list(self):
        query, names = actual_query(self.plan())
        self.assertTrue(query.startswith("SELECT json_build_object('serverTimeMs',"))
        self.assertEqual(query.count("SELECT json_build_object('serverTimeMs',"), 1)
        tail = "WHERE rolname IN (" + ','.join("'" + n + "'" for n in sorted(names.values())) + ')));'
        self.assertTrue(query.endswith(tail))
        self.assertNotIn('IN (,', query)
        for name in names.values(): self.assertEqual(query.count("'" + name + "'"), 1)
        depth = 0
        for token in tokens(query):
            if token == '(': depth += 1
            elif token == ')': depth -= 1
            self.assertGreaterEqual(depth, 0)
        self.assertEqual(depth, 0)
        self.assertIn("'database',current_database()", query)
        self.assertIn("rolpassword IS NULL", query)

    def test_schema_quote_is_single_literal_not_sql_injection(self):
        plan = self.plan(); plan['schema'] = "schema'quoted"
        query, _ = actual_query(plan)
        self.assertIn("'schema''quoted'", tokens(query))

    def test_actual_original_plan_no_longer_matches_failed_native_query(self):
        path = Path('/private/tmp/address-radar-production-target-20261006-plan.json')
        if not path.exists(): self.skipTest('original offline plan not available')
        query, _ = actual_query(json.loads(path.read_text()))
        self.assertNotEqual(hashlib.sha256(query.encode()).hexdigest(),
            '38884a991c1c95547c14b30113dc4f616321b545cff0b4e02dd7ccf8d67b9d4a')
        self.assertEqual(query.count("SELECT json_build_object('serverTimeMs',"), 1)


if __name__ == '__main__': unittest.main()
