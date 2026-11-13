"""Generated instructions preserve continuity without granting result acceptance."""

import re
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "packages/project-contracts/src"))
sys.path.insert(0, str(REPO_ROOT / "scripts/lib"))

from instruction_documents import read_instruction_documents
from project_contracts.project_scaffold import ensure_project_scaffold


def normalized(text: str) -> str:
    return " ".join(text.split())


class TestResearchContinuityGuidance(unittest.TestCase):
    def test_generated_project_routes_continuation_to_a_real_section(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "project"
            ensure_project_scaffold(repo_root=root, project_policy="real_project")
            entry = (root / "AGENTS.md").read_text(encoding="utf-8")
            route = next(
                line for line in entry.splitlines()
                if line.startswith("| Save unfinished work for another session |")
            )
            match = re.search(r'\]\(([^)#]+)#([^ )]+) "nullius-guidance"\)', route)
            self.assertIsNotNone(match, msg="continuation must be a discoverable instruction route")
            target, anchor = match.groups()
            guidance = (root / target).read_text(encoding="utf-8")
            self.assertIn("## " + anchor.replace("-", " ").capitalize(), guidance)
            self.assertIn(
                '[Research workflow](research_guidance.md#research-workflow "nullius-guidance")',
                entry,
            )
            instructions = normalized(read_instruction_documents(root / "AGENTS.md"))

        # These obligations must survive actual scaffold generation and marked
        # reference loading, including a host that starts with only AGENTS.md.
        for obligation in (
            "The primary agent retains the scientific judgment",
            "Use the current host's native reasoning and tools",
            "when it adds independent evidence or useful parallelism",
            "A native subagent call does not by itself adopt a formal `research-team` cycle",
            "Completing a scoped answer is ordinary task completion, not project acceptance",
            "Verification of load-bearing claims is required in either case",
            "A fixed-source question needs the actual source versions",
            "Saving a continuation checkpoint is allowed while a gate or approval is pending or failed",
            "It neither clears that boundary nor adopts scientific results",
            "`fresh` means selected bytes match; it does not mean scientific acceptance",
            "resume only work allowed by the relevant gates and authorizations",
            "Restoring that existing state does not itself require a new full-text review",
            "Newly adopting or revising scientific conclusions",
            "A checkpoint label cannot exempt that handoff",
        ):
            with self.subTest(obligation=obligation):
                self.assertIn(obligation, instructions)

        for retained_gate in (
            "at least two independent blind re-derivations",
            "convergence, independent methods, regression anchor",
            "claim-grounding",
            "citation-triangulation",
            "current full-text notebook review and unscoped `nullius notebook check --json`",
            "research-integrity",
            "not mark it complete, register it as current, or authorize downstream reliance",
        ):
            with self.subTest(retained_gate=retained_gate):
                self.assertIn(retained_gate, instructions)

    def test_harness_keeps_checkpoint_and_adopted_result_routes_distinct(self) -> None:
        entry_path = REPO_ROOT / "skills/research-harness/SKILL.md"
        entry = entry_path.read_text(encoding="utf-8")
        routes = [line for line in entry.splitlines() if line.startswith("|")]
        continuation = next(line for line in routes if "Save unfinished work" in line)
        closeout = next(line for line in routes if "hand off adopted results" in line)
        self.assertIn('references/task-context.md "nullius-guidance"', continuation)
        self.assertIn('references/closeout.md "nullius-guidance"', closeout)
        instructions = normalized(read_instruction_documents(entry_path))
        for obligation in (
            "Give blind verification its neutral question and original inputs",
            "Calling a subagent does not by itself require adopting the formal `research-team` cycle",
            "A fixed-paper question does not automatically require a field-wide survey",
            "Check a load-bearing result before dependent work relies on it",
            "Recording a pending check does not discharge that check",
            "recovering that existing state does not itself require a new full-text review",
            "Calling that operation a checkpoint does not exempt it",
            "current unscoped notebook structure check and accepted full-text content review",
            "A summary is a navigation aid and cannot certify an omitted source or replace a required gate",
        ):
            with self.subTest(obligation=obligation):
                self.assertIn(obligation, instructions)


if __name__ == "__main__":
    unittest.main()
