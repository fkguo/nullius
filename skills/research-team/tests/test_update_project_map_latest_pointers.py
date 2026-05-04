import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]


def _run_update_project_map(root: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SKILL_ROOT / "scripts/bin/update_project_map.py"),
            "--notes",
            str(root / "research_contract.md"),
            "--team-dir",
            "team",
            *extra_args,
        ],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )


class TestUpdateProjectMapLatestPointers(unittest.TestCase):
    def test_full_scaffold_marks_disabled_latest_draft_template(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            result = subprocess.run(
                [
                    "bash",
                    str(SKILL_ROOT / "scripts/bin/scaffold_research_workflow.sh"),
                    "--root",
                    str(root),
                    "--project",
                    "Pointer Demo",
                    "--profile",
                    "mixed",
                    "--full",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_draft = (root / "team" / "LATEST_DRAFT.md").read_text(encoding="utf-8")

        self.assertIn("treat this file as a disabled status marker", latest_draft)

    def test_no_draft_state_writes_disabled_latest_draft_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "team" / "runs").mkdir(parents=True)

            result = _run_update_project_map(root, "--latest-kind", "draft")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_draft = (root / "team" / "LATEST_DRAFT.md").read_text(encoding="utf-8")
            latest_index = (root / "team" / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertIn("- Draft cycle state: optional / not configured", latest_draft)
        self.assertIn("- Latest tag: (no draft cycle has run yet)", latest_draft)
        self.assertIn("- Status: not configured", latest_draft)
        self.assertIn(
            "- Activation note: enable and run a draft cycle before treating this file as a live restart surface.",
            latest_draft,
        )
        self.assertIn("- Trajectory index: [trajectory_index.json](trajectory_index.json)", latest_draft)
        self.assertIn(
            "- Draft cycle (optional; disabled until configured and run): [LATEST_DRAFT.md](LATEST_DRAFT.md)",
            latest_index,
        )
        self.assertIn("- Draft latest tag: (no draft cycle has run yet)", project_index)
        self.assertIn("- Draft latest status: not configured", project_index)
        self.assertIn(
            "- Latest draft (optional; disabled until configured and run): [team/LATEST_DRAFT.md](team/LATEST_DRAFT.md)",
            project_index,
        )

    def test_non_draft_team_run_does_not_activate_latest_draft_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            team_dir = root / "team"
            run_tag = "M1-team-r1"
            run_dir = team_dir / "runs" / run_tag
            run_dir.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (team_dir / "trajectory_index.json").write_text(
                '{"runs":[{"tag":"M1-team-r1","stage":"preflight_ok"}]}\n',
                encoding="utf-8",
            )

            result = _run_update_project_map(root, "--latest-kind", "draft")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_draft = (team_dir / "LATEST_DRAFT.md").read_text(encoding="utf-8")

        self.assertIn("- Draft cycle state: optional / not configured", latest_draft)
        self.assertIn("- Latest tag: (no draft cycle has run yet)", latest_draft)
        self.assertIn("- Status: not configured", latest_draft)
        self.assertNotIn("- Draft cycle state: active", latest_draft)
        self.assertNotIn(f"- Latest tag: {run_tag}", latest_draft)
        self.assertNotIn("preflight_ok", latest_draft)

    def test_active_draft_state_keeps_live_latest_run_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-d0-draft-r1"
            run_dir = root / "team" / "runs" / tag
            run_dir.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (run_dir / f"{tag}_draft_packet.md").write_text("# packet\n", encoding="utf-8")

            result = _run_update_project_map(
                root,
                "--latest-kind",
                "draft",
                "--tag",
                tag,
                "--status",
                "draft_member_reports",
            )

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_draft = (root / "team" / "LATEST_DRAFT.md").read_text(encoding="utf-8")

        self.assertIn("- Draft cycle state: active", latest_draft)
        self.assertIn(f"- Latest tag: {tag}", latest_draft)
        self.assertIn("- Status: draft_member_reports", latest_draft)
        self.assertIn(f"- Run directory: [./runs/{tag}](./runs/{tag})", latest_draft)
        self.assertIn(f"- Draft packet: [./runs/{tag}/{tag}_draft_packet.md](./runs/{tag}/{tag}_draft_packet.md)", latest_draft)
        self.assertNotIn("optional / not configured", latest_draft)
        self.assertNotIn("Status: not configured", latest_draft)


if __name__ == "__main__":
    unittest.main()
