import subprocess
import sys
import tempfile
import unittest
import json
import re
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]


class TestRunArtifactIdentity(unittest.TestCase):
    def test_full_validation_default_smoke_entry_exists(self) -> None:
        validation = SKILL_ROOT / "scripts/validation/run_full_contract_validation.sh"
        text = validation.read_text(encoding="utf-8")
        match = re.search(r'^SMOKE_ALL="\$\{SKILL_ROOT\}/(.+)"$', text, flags=re.MULTILINE)

        self.assertIsNotNone(match)
        smoke = SKILL_ROOT / match.group(1)
        self.assertTrue(smoke.is_file(), msg=f"default smoke entry missing: {smoke}")
        self.assertIn("python3 -m pytest", smoke.read_text(encoding="utf-8"))

    def test_docs_define_tag_to_run_id_relation(self) -> None:
        docs = "\n".join(
            (SKILL_ROOT / rel).read_text(encoding="utf-8")
            for rel in (
                "SKILL.md",
                "README.md",
                "references/usage_guide.md",
                "references/usage_guide.zh.md",
                "assets/AGENTS_template.md",
                "assets/research_plan_template.md",
            )
        )

        self.assertIn("artifacts/runs/<run_id>/", docs)
        self.assertIn("team/runs/<tag>/", docs)
        self.assertIn("20260502T023000Z-m0-topic", docs)
        self.assertIn("Do not use bare UUIDs or `run_<uuid>`", docs)
        self.assertNotIn("M0-r1", docs)

    def test_next_team_tag_preserves_meaningful_base(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            result = subprocess.run(
                [
                    sys.executable,
                    str(SKILL_ROOT / "scripts/bin/next_team_tag.py"),
                    "--tag",
                    "20260502T023000Z-m0-topic",
                    "--out-dir",
                    td,
                ],
                check=True,
                stdout=subprocess.PIPE,
                text=True,
            )

        self.assertEqual(result.stdout.strip(), "20260502T023000Z-m0-topic-r1")

    def test_run_team_cycle_rejects_instead_of_sanitizing_tags(self) -> None:
        script = (SKILL_ROOT / "scripts/bin/run_team_cycle.sh").read_text(encoding="utf-8")

        self.assertIn("resolved tag must be one safe path segment", script)
        self.assertIn("machine-generated UUID", script)
        self.assertNotIn("s/[^A-Za-z0-9._-]+/_/g", script)

    def test_reviewer_artifact_lane_uses_canonical_run_root(self) -> None:
        runtime = "\n".join(
            (SKILL_ROOT / rel).read_text(encoding="utf-8")
            for rel in (
                "scripts/bin/run_member_review.py",
                "scripts/bin/run_team_cycle.sh",
                "scripts/gates/check_independent_reproduction.py",
                "scripts/gates/check_logic_isolation.py",
                "scripts/gates/check_clean_room.py",
                "scripts/lib/workspace_isolator.py",
                "scripts/validation/run_full_contract_validation.sh",
            )
        )

        self.assertIn("artifacts/runs/{safe_tag}/research_team/{member_id}/", runtime)
        self.assertIn("artifacts/runs/${safe_tag}/research_team", runtime)
        self.assertIn("artifacts/runs/<run_id>/research_team/<member_id>/independent/", runtime)
        self.assertNotIn("artifacts/{safe_tag}", runtime)
        self.assertNotIn("artifacts/{st}", runtime)
        self.assertNotIn("artifacts/<tag>/<member_id>", runtime)

    def test_milestone_gate_accepts_canonical_run_id_shape(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "research_plan.md").write_text(
                "\n".join(
                    [
                        "# plan",
                        "",
                        "### M2 - Core Computation",
                        "",
                        "- Deliverables:",
                        "  - `artifacts/runs/20260502T023000Z-m2-topic-r1/analysis.json`",
                        "- Acceptance:",
                        "  - `python3 scripts/check.py` passes",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            (root / "research_team_config.json").write_text(
                json.dumps({"features": {"milestone_dod_gate": True}}),
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(SKILL_ROOT / "scripts/gates/check_milestone_dod.py"),
                    "--notes",
                    str(root / "research_contract.md"),
                    "--tag",
                    "20260502T023000Z-m2-topic-r1",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )

        self.assertEqual(result.returncode, 0, msg=result.stdout)
        self.assertIn("- Gate: PASS", result.stdout)

    def test_demo_milestone_enriches_canonical_scaffold_without_legacy_artifact_root(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            scaffold = subprocess.run(
                [
                    "bash",
                    str(SKILL_ROOT / "scripts/bin/scaffold_research_workflow.sh"),
                    "--root",
                    str(root),
                    "--project",
                    "Identity Demo",
                    "--profile",
                    "mixed",
                    "--full",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )
            self.assertEqual(scaffold.returncode, 0, msg=scaffold.stdout)
            agents = (root / "AGENTS.md").read_text(encoding="utf-8")
            self.assertIn("run_team_cycle.sh", agents)
            self.assertIn("artifacts/runs/<run_id>/", agents)
            plan = (root / "research_plan.md").read_text(encoding="utf-8")
            self.assertIn("- [ ] T1:", plan)
            self.assertIn("artifacts/runs/<run_id>/analysis.json", plan)

            run_id = "20260502T023000Z-m0-topic-r1"
            demo = subprocess.run(
                [
                    "bash",
                    str(SKILL_ROOT / "scripts/bin/generate_demo_milestone.sh"),
                    "--root",
                    str(root),
                    "--tag",
                    run_id,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )

            self.assertEqual(demo.returncode, 0, msg=demo.stdout)
            contract = (root / "research_contract.md").read_text(encoding="utf-8")
            self.assertIn("<!-- REVIEW_EXCERPT_START -->", contract)
            self.assertIn("<!-- AUDIT_SLICES_START -->", contract)
            self.assertIn(f"artifacts/runs/{run_id}/analysis.json", contract)
            self.assertIn("[@Bezanson2017]", contract)
            self.assertIn("## 6. Mapping to Computation", contract)
            self.assertIn("Demo scalar 'a' stored in analysis artifact", contract)
            self.assertTrue((root / "artifacts" / "runs" / run_id / "analysis.json").is_file())
            self.assertFalse((root / "artifacts" / run_id).exists())


if __name__ == "__main__":
    unittest.main()
