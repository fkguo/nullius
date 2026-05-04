import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
ASSETS_ROOT = SKILL_ROOT / "assets"


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


def _run_prune_optional_scaffold(root: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SKILL_ROOT / "scripts/bin/prune_optional_scaffold.py"),
            "--root",
            str(root),
            *extra_args,
        ],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )


def _read_prune_report(stdout: str) -> dict:
    for line in stdout.splitlines():
        if line.startswith("[ok] report: "):
            report_md = Path(line.split(": ", 1)[1])
            return json.loads(report_md.with_suffix(".json").read_text(encoding="utf-8"))
    raise AssertionError(f"prune report path not found in output:\n{stdout}")


class TestUpdateProjectMapLatestPointers(unittest.TestCase):
    def test_full_scaffold_does_not_create_latest_draft_and_latest_index_omits_it(self) -> None:
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
            latest_index = (root / "team" / "LATEST.md").read_text(encoding="utf-8")

        self.assertFalse((root / "team" / "LATEST_DRAFT.md").exists())
        self.assertNotIn("LATEST_DRAFT.md", latest_index)
        self.assertIn("- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)", latest_index)
        self.assertIn("- Trajectory index: [trajectory_index.json](trajectory_index.json)", latest_index)

    def test_no_draft_state_keeps_latest_draft_absent(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "team" / "runs").mkdir(parents=True)

            result = _run_update_project_map(root, "--latest-kind", "draft")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_index = (root / "team" / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertFalse((root / "team" / "LATEST_DRAFT.md").exists())
        self.assertNotIn("LATEST_DRAFT.md", latest_index)
        self.assertNotIn("Draft latest tag:", project_index)
        self.assertNotIn("Draft latest status:", project_index)
        self.assertNotIn("Latest draft", project_index)

    def test_non_draft_team_run_and_trajectory_do_not_activate_latest_draft_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            team_dir = root / "team"
            run_tag = "M1-team-r1"
            (team_dir / "runs" / run_tag).mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (team_dir / "trajectory_index.json").write_text(
                '{"runs":[{"tag":"M1-team-r1","stage":"preflight_ok"}]}\n',
                encoding="utf-8",
            )

            result = _run_update_project_map(root, "--latest-kind", "draft")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_index = (team_dir / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertFalse((team_dir / "LATEST_DRAFT.md").exists())
        self.assertNotIn("LATEST_DRAFT.md", latest_index)
        self.assertNotIn("Draft latest tag:", project_index)
        self.assertNotIn("Draft latest status:", project_index)
        self.assertNotIn(run_tag, project_index)
        self.assertNotIn("preflight_ok", project_index)

    def test_explicit_draft_state_creates_live_latest_run_pointer_and_indexes_it(self) -> None:
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
            latest_index = (root / "team" / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertIn("- Draft cycle state: active", latest_draft)
        self.assertIn(f"- Latest tag: {tag}", latest_draft)
        self.assertIn("- Status: draft_member_reports", latest_draft)
        self.assertIn(f"- Run directory: [./runs/{tag}](./runs/{tag})", latest_draft)
        self.assertIn(f"- Draft packet: [./runs/{tag}/{tag}_draft_packet.md](./runs/{tag}/{tag}_draft_packet.md)", latest_draft)
        self.assertNotIn("optional / not configured", latest_draft)
        self.assertNotIn("Status: not configured", latest_draft)
        self.assertIn("- Draft cycle: [LATEST_DRAFT.md](LATEST_DRAFT.md)", latest_index)
        self.assertIn(f"- Draft latest tag: {tag}", project_index)
        self.assertIn("- Draft latest status: draft_member_reports", project_index)
        self.assertIn("- Latest draft: [team/LATEST_DRAFT.md](team/LATEST_DRAFT.md)", project_index)

    def test_placeholder_latest_draft_is_deleted_when_no_explicit_draft_state(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            team_dir = root / "team"
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (team_dir / "runs").mkdir(parents=True)
            placeholder = ASSETS_ROOT / "team_latest_draft_template.md"
            (team_dir / "LATEST_DRAFT.md").write_text(placeholder.read_text(encoding="utf-8"), encoding="utf-8")

            result = _run_update_project_map(root, "--latest-kind", "draft")

            self.assertEqual(result.returncode, 0, msg=result.stdout)

        self.assertFalse((team_dir / "LATEST_DRAFT.md").exists())

    def test_prune_team_dir_accepts_missing_latest_draft_and_rejects_live_one(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            scaffold = subprocess.run(
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
            self.assertEqual(scaffold.returncode, 0, msg=scaffold.stdout)

            dry_run = _run_prune_optional_scaffold(
                root,
                "--archive-dir",
                str(root / "artifacts" / "migrations" / "prune_default"),
            )
            self.assertEqual(dry_run.returncode, 0, msg=dry_run.stdout)
            report = _read_prune_report(dry_run.stdout)
            team_items = [
                item for item in report["items"] if item["component"] == "scaffolds" and item["path"] == "team"
            ]
            self.assertTrue(team_items, msg=report)
            self.assertTrue(any(item["status"] == "plan_move" for item in team_items), msg=team_items)

            draft_tag = "20260504T020000Z-d0-draft-r1"
            draft_run = root / "team" / "runs" / draft_tag
            draft_run.mkdir(parents=True)
            (draft_run / f"{draft_tag}_draft_packet.md").write_text("# packet\n", encoding="utf-8")
            active = _run_update_project_map(
                root,
                "--latest-kind",
                "draft",
                "--tag",
                draft_tag,
                "--status",
                "draft_member_reports",
            )
            self.assertEqual(active.returncode, 0, msg=active.stdout)

            live_dry_run = _run_prune_optional_scaffold(
                root,
                "--archive-dir",
                str(root / "artifacts" / "migrations" / "prune_live"),
            )
            self.assertEqual(live_dry_run.returncode, 0, msg=live_dry_run.stdout)
            live_report = _read_prune_report(live_dry_run.stdout)
            live_team_items = [
                item for item in live_report["items"] if item["component"] == "scaffolds" and item["path"] == "team"
            ]
            self.assertTrue(live_team_items, msg=live_report)
            self.assertTrue(any(item["status"] == "skip" for item in live_team_items), msg=live_team_items)
            self.assertTrue(
                any("contains non-default files" in item["reason"] for item in live_team_items),
                msg=live_team_items,
            )


if __name__ == "__main__":
    unittest.main()
