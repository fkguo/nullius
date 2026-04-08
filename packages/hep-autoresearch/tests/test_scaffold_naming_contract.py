import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestScaffoldNamingContract(unittest.TestCase):
    def test_init_uses_new_minimal_surface(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            env = dict(os.environ)
            env["PYTHONPATH"] = str(_src_root()) + os.pathsep + env.get("PYTHONPATH", "")
            proc = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "hep_autoresearch.orchestrator_cli",
                    "--project-root",
                    str(root),
                    "init",
                ],
                capture_output=True,
                check=False,
                env=env,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
            present_paths = {
                str(path.relative_to(root)).replace("\\", "/")
                for path in root.rglob("*")
            }
            for rel in (
                "AGENTS.md",
                "project_charter.md",
                "project_index.md",
                "research_plan.md",
                "research_notebook.md",
                "research_contract.md",
                ".mcp.template.json",
                "docs/APPROVAL_GATES.md",
                "docs/ARTIFACT_CONTRACT.md",
                "docs/EVAL_GATE_CONTRACT.md",
                "specs/plan.schema.json",
            ):
                self.assertIn(rel, present_paths, msg=f"expected scaffolded path: {rel}")

            for rel in (
                "Draft_Derivation.md",
                "PROJECT_CHARTER.md",
                "PROJECT_MAP.md",
                "RESEARCH_PLAN.md",
                "PREWORK.md",
                "INITIAL_INSTRUCTION.md",
                "INNOVATION_LOG.md",
            ):
                # APFS is case-insensitive by default, so existence checks must use the
                # actual directory entries rather than alternate-case probes.
                self.assertNotIn(rel, present_paths, msg=f"legacy path should not be scaffolded: {rel}")

            for rel in ("knowledge_base", "prompts", "references", "team", "research_team_config.json"):
                self.assertFalse((root / rel).exists(), msg=f"minimal init should not precreate optional path: {rel}")
