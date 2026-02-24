import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestKBProfile(unittest.TestCase):
    def test_kb_profile_smoke(self) -> None:
        import json
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.evals import _schema_for_json_path, _schema_validate
        from hep_autoresearch.toolkit.kb_profile import build_kb_profile

        repo_root = Path(__file__).resolve().parents[1]
        schema_path = repo_root / "specs" / "kb_profile.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))

        minimal = build_kb_profile(repo_root=repo_root, profile="minimal")
        curated = build_kb_profile(repo_root=repo_root, profile="curated")

        self.assertEqual(minimal["issues"]["missing_paths"], [])
        self.assertEqual(curated["issues"]["missing_paths"], [])
        self.assertGreaterEqual(int(curated["stats"]["total_entries"]), int(minimal["stats"]["total_entries"]))
        self.assertLessEqual(int(curated["stats"]["total_entries"]), 12)

        self.assertEqual(_schema_validate(minimal, schema, "kb_profile", root_schema=schema), [])
        self.assertEqual(_schema_validate(curated, schema, "kb_profile", root_schema=schema), [])

        mapped = _schema_for_json_path(repo_root, "artifacts/runs/TEST/kb_profile/kb_profile.json")
        self.assertEqual(mapped, schema_path)

