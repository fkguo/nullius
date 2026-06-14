import subprocess
import sys
import tempfile
import unittest
import json
import re
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
LANGUAGE_DISCIPLINE_SNIPPETS = (
    "## Scientific writing discipline",
    "use the field's native scientific language",
    "`certificate`, `instantiation`, or `guardrail`",
    "genuinely the correct software, security, formal-mathematics, or toolchain term",
    "the project's physical, mathematical, experimental, statistical, or numerical concepts",
)


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
            )
        )

        self.assertIn("artifacts/runs/<run_id>/", docs)
        self.assertIn("team/runs/<tag>/", docs)
        self.assertIn("20260502T023000Z-m0-topic", docs)
        self.assertIn("Do not use bare UUIDs or `run_<uuid>`", docs)
        self.assertNotIn("M0-r1", docs)

    def test_agents_anchor_gate_requires_harness_precedence_when_runtime_sentinel_exists(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "research_team_config.json").write_text(
                json.dumps({"features": {"agents_anchor_gate": True}}),
                encoding="utf-8",
            )
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / ".autoresearch").mkdir()
            (root / ".autoresearch" / "HARNESS").write_text('{"schema_version":1}\n', encoding="utf-8")
            (root / "AGENTS.md").write_text(
                "\n".join(
                    [
                        "# AGENTS.md",
                        "",
                        "Use `research_contract.md`.",
                        "Run `run_team_cycle.sh`.",
                        "This intentionally long anchor text keeps the fixture above the minimum size while omitting the project-harness precedence tokens that the gate must require when the runtime sentinel exists.",
                        "The test should fail on the missing runtime handshake, not on the generic minimum-length guard.",
                    ]
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    sys.executable,
                    str(SKILL_ROOT / "scripts/gates/check_agents_anchor.py"),
                    "--notes",
                    str(root / "research_contract.md"),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )

        self.assertEqual(result.returncode, 1, msg=result.stdout)
        self.assertIn(".autoresearch/HARNESS", result.stdout)
        self.assertIn("research-harness", result.stdout)
        self.assertIn(".autoresearch/bin/autoresearch status --json", result.stdout)

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
            skill = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
            kb_readme = (root / "knowledge_base" / "README.md").read_text(encoding="utf-8")
            cfg = json.loads((root / "research_team_config.json").read_text(encoding="utf-8"))
            # Scaffolded AGENTS.md is now the canonical project-contracts document
            # (single scaffold authority). The run_team_cycle.sh cycle-trigger
            # guidance lives in the research-team skill, not the baseline AGENTS.
            # Anchor on the runnable invocation, not a bare filename mention, so
            # the assertion locks the actual guidance.
            self.assertIn('bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh"', skill)
            self.assertIn("artifacts/runs/<run_id>/", agents)
            self.assertIn("Do not use an abstract-only reading as decisive evidence", agents)
            self.assertIn("If arXiv LaTeX source is available, prefer reading the source", agents)
            self.assertIn("Literature notes should record scientific content, not tool-use logs", agents)
            for snippet in LANGUAGE_DISCIPLINE_SNIPPETS:
                self.assertIn(snippet, agents)
            self.assertIn("Evidence readiness: evidence-ready", kb_readme)
            self.assertIn("Source form actually read", kb_readme)
            self.assertIn("Sections/pages/equations/figures actually read", kb_readme)
            self.assertTrue(cfg["knowledge_layers"]["require_literature_reading_evidence"])
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
