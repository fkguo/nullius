"""The shipped refresh entry point, exercised as a subprocess.

Nothing in the repo ran this script before, so its exit statuses — the one
signal an operator or a wrapper actually consumes — were unlocked. A review
seat confirmed the exit-1 branch could be deleted with the whole suite still
green.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / 'packages' / 'project-contracts' / 'src'))
SCRIPT = REPO_ROOT / "skills" / "research-team" / "scripts" / "bin" / "refresh_research_contract.py"
CONTRACT = """# Research contract

<!-- RESEARCH_NOTEBOOK_SYNC_START -->
- Source notebook: [research_notebook.md](research_notebook.md)
- Notebook sha256: `deadbeef`

### Notebook references

- Curated entry, [DOI](https://example.org/curated)
<!-- RESEARCH_NOTEBOOK_SYNC_END -->

## Owner section

- Owned.
"""
NOTEBOOK = "# N\n\n## Scope\n\nText.\n\n## References\n\n- A, [DOI](https://example.org/a)\n"


def _project(root: Path) -> None:
    root.mkdir(parents=True)
    (root / "research_contract.md").write_text(CONTRACT, encoding="utf-8")
    (root / "research_notebook.md").write_text(NOTEBOOK, encoding="utf-8")


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False
    )


class RefreshEntryPointTest(unittest.TestCase):
    def test_a_plain_run_succeeds_and_leaves_the_contract_alone(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project(root)
            before = (root / "research_contract.md").read_bytes()
            result = _run("--root", str(root))
            self.assertEqual(0, result.returncode, result.stderr)
            payload = json.loads(result.stdout)
            self.assertFalse(payload["contract_modified"])
            self.assertEqual(before, (root / "research_contract.md").read_bytes())
            self.assertTrue(Path(payload["proposal_path"]).is_file())

    def test_aiming_the_proposal_at_the_contract_exits_non_zero(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            _project(root)
            before = (root / "research_contract.md").read_bytes()
            result = _run("--root", str(root), "--proposal", str(root / "research_contract.md"))
            self.assertEqual(1, result.returncode)
            self.assertIn("refusing", result.stderr)
            self.assertEqual(before, (root / "research_contract.md").read_bytes())

    def test_a_contract_that_changes_during_the_run_exits_non_zero(self):
        """The consumer of `contract_modified`, locked at the branch.

        A filesystem construction cannot reach it: every state that would make
        the contract change is now refused by the destination guard first, so a
        contrived fixture exits 1 for the wrong reason and the branch stays
        unlocked — a review seat deleted it with the whole suite still green.
        The honest lock drives the entry point with a result that reports the
        contract changed, which is exactly the condition the branch exists for.
        """
        script = SCRIPT.read_text(encoding="utf-8")
        module = {"__name__": "refresh_entry_point_under_test", "__file__": str(SCRIPT)}
        exec(compile(script, str(SCRIPT), "exec"), module)  # noqa: S102 - the entry point itself

        import io
        import contextlib

        def fake_propose(**kwargs):
            return {"proposal_path": "/tmp/p.md", "contract_path": "/tmp/c.md",
                    "contract_modified": True, "notebook_sha256": "x",
                    "section_count": 0, "reference_count": 0}

        argv = ["refresh_research_contract.py", "--root", str(REPO_ROOT)]
        err = io.StringIO()
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stderr(err), \
                mock.patch.dict(sys.modules), contextlib.redirect_stdout(io.StringIO()):
            import project_contracts.research_contract as rc
            with mock.patch.object(rc, "propose_research_contract_block", fake_propose):
                code = module["main"]()
        self.assertEqual(1, code)
        self.assertIn("should not have", err.getvalue())


if __name__ == "__main__":
    unittest.main()
