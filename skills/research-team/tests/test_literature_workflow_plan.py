from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path


class TestResearchTeamWorkflowPlan(unittest.TestCase):
    def test_workflow_plan_subcommand_uses_launcher_authority(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        script = repo_root / "skills" / "research-team" / "scripts" / "bin" / "literature_fetch.py"
        completed = subprocess.run(
            [
                sys.executable,
                str(script),
                "workflow-plan",
                "--recipe",
                "literature_landscape",
                "--phase",
                "prework",
                "--query",
                "bootstrap amplitudes",
                "--topic",
                "bootstrap amplitudes",
                "--seed-recid",
                "1234",
                "--preferred-provider",
                "openalex",
            ],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, msg=completed.stdout + completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload.get("entry_tool"), "literature_workflows.resolve")
        steps = payload.get("resolved_steps") or []
        self.assertTrue(isinstance(steps, list) and steps)
        self.assertEqual((steps[0] or {}).get("tool"), "openalex_search")
