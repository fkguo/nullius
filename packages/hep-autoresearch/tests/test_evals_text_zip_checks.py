import json
import tempfile
import unittest
import zipfile
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestEvalsTextZipChecks(unittest.TestCase):
    def test_text_and_zip_checks(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.evals import run_eval_case

        repo_root = Path(__file__).resolve().parents[1]
        schema_text = (repo_root / "specs" / "eval_case.schema.json").read_text(encoding="utf-8")

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "specs").mkdir(parents=True, exist_ok=True)
            (root / "specs" / "eval_case.schema.json").write_text(schema_text, encoding="utf-8")

            (root / "foo.md").write_text("hello\nkb-profile\n", encoding="utf-8")

            with zipfile.ZipFile(root / "bundle.zip", "w") as zf:
                zf.writestr("a.txt", "A")
                zf.writestr("dir/b.txt", "B")

            case_dir = root / "case"
            case_dir.mkdir(parents=True, exist_ok=True)
            case = {
                "schema_version": 1,
                "case_id": "TMP-text-zip",
                "workflow": "custom",
                "inputs": {},
                "acceptance": {
                    "required_paths_exist": ["foo.md", "bundle.zip"],
                    "text_contains_checks": [{"path": "foo.md", "contains": ["kb-profile"]}],
                    "zip_contains_checks": [{"path": "bundle.zip", "required_entries": ["a.txt", "dir/b.txt"]}],
                },
            }
            (case_dir / "case.json").write_text(json.dumps(case, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            res = run_eval_case(case_dir, repo_root=root)
            self.assertTrue(res.ok, msg="\n".join(res.messages))

