import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
ASSETS_ROOT = SKILL_ROOT / "assets"
PROJECT_INDEX_AUTO_START = "<!-- PROJECT_INDEX_AUTO_START -->"
PROJECT_INDEX_AUTO_END = "<!-- PROJECT_INDEX_AUTO_END -->"


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


def _run_export_paper_bundle(root: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SKILL_ROOT / "scripts/bin/export_paper_bundle.py"),
            *extra_args,
        ],
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )


def _write_project_index(root: Path, auto_lines: list[str]) -> None:
    lines = [
        "# Pointer Demo — project_index",
        "",
        "Last updated: 2026-05-04T00:00:00Z",
        "",
        "## Latest pointers",
        "",
        "- Latest pointers: [team/LATEST.md](team/LATEST.md)",
        "",
        PROJECT_INDEX_AUTO_START,
        "<!-- This block is auto-generated. Do not edit by hand. -->",
        *auto_lines,
        PROJECT_INDEX_AUTO_END,
        "",
    ]
    (root / "project_index.md").write_text("\n".join(lines), encoding="utf-8")


def _read_prune_report(stdout: str) -> dict:
    for line in stdout.splitlines():
        if line.startswith("[ok] report: "):
            report_md = Path(line.split(": ", 1)[1])
            return json.loads(report_md.with_suffix(".json").read_text(encoding="utf-8"))
    raise AssertionError(f"prune report path not found in output:\n{stdout}")


class TestUpdateProjectMapLatestPointers(unittest.TestCase):
    def test_full_scaffold_does_not_create_lazy_latest_pointers_and_latest_index_omits_them(self) -> None:
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

        self.assertFalse((root / "team" / "LATEST_TEAM.md").exists())
        self.assertFalse((root / "team" / "LATEST_DRAFT.md").exists())
        self.assertFalse((root / "artifacts" / "LATEST.md").exists())
        self.assertNotIn("LATEST_TEAM.md", latest_index)
        self.assertNotIn("LATEST_DRAFT.md", latest_index)
        self.assertNotIn("Team cycle", latest_index)
        self.assertIn("- Trajectory index: [trajectory_index.json](trajectory_index.json)", latest_index)

    def test_no_team_state_keeps_latest_team_and_artifacts_absent(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "team" / "runs").mkdir(parents=True)
            (root / "artifacts" / "runs").mkdir(parents=True)

            result = _run_update_project_map(root, "--latest-kind", "team")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_index = (root / "team" / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertFalse((root / "team" / "LATEST_TEAM.md").exists())
        self.assertFalse((root / "artifacts" / "LATEST.md").exists())
        self.assertNotIn("LATEST_TEAM.md", latest_index)
        self.assertNotIn("Team latest tag:", project_index)
        self.assertNotIn("Team latest status:", project_index)
        self.assertNotIn("Latest team", project_index)
        self.assertNotIn("Latest artifacts", project_index)

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

    def test_explicit_team_state_creates_live_latest_team_pointer_and_indexes_it(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-m0-team-r1"
            run_dir = root / "team" / "runs" / tag
            run_dir.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (run_dir / f"{tag}_member_a.md").write_text("# member a\n", encoding="utf-8")

            result = _run_update_project_map(
                root,
                "--latest-kind",
                "team",
                "--tag",
                tag,
                "--status",
                "preflight_ok",
            )

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_team = (root / "team" / "LATEST_TEAM.md").read_text(encoding="utf-8")
            latest_index = (root / "team" / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertIn(f"- Latest tag: {tag}", latest_team)
        self.assertIn("- Status: preflight_ok", latest_team)
        self.assertIn(f"- Run directory: [./runs/{tag}](./runs/{tag})", latest_team)
        self.assertIn(f"- Member A report: [./runs/{tag}/{tag}_member_a.md](./runs/{tag}/{tag}_member_a.md)", latest_team)
        self.assertIn("- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)", latest_index)
        self.assertIn(f"- Team latest tag: {tag}", project_index)
        self.assertIn("- Team latest status: preflight_ok", project_index)
        self.assertIn("- Latest team: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)", project_index)
        self.assertFalse((root / "artifacts" / "LATEST.md").exists())
        self.assertNotIn("Latest artifacts", project_index)

    def test_stale_existing_latest_team_and_artifacts_pointers_are_not_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            team_dir = root / "team"
            artifacts_dir = root / "artifacts"
            stale_tag = "20260504T020000Z-m0-team-r1"
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (team_dir / "runs").mkdir(parents=True)
            artifacts_dir.mkdir(parents=True)
            (team_dir / "LATEST_TEAM.md").write_text(
                "\n".join(
                    (
                        "# Latest Team Cycle",
                        "",
                        f"- Latest tag: {stale_tag}",
                        "- Status: preflight_ok",
                        f"- Run directory: [./runs/{stale_tag}](./runs/{stale_tag})",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            (artifacts_dir / "LATEST.md").write_text(
                "\n".join(
                    (
                        "# Latest Artifacts",
                        "",
                        f"- Latest tag: {stale_tag}",
                        f"- Canonical artifacts directory: [./runs/{stale_tag}](./runs/{stale_tag})",
                        "",
                    )
                ),
                encoding="utf-8",
            )

            result = _run_update_project_map(root, "--latest-kind", "team")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_index = (team_dir / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertNotIn("LATEST_TEAM.md", latest_index)
        self.assertNotIn("Team latest tag:", project_index)
        self.assertNotIn("Team latest status:", project_index)
        self.assertNotIn("Latest team", project_index)
        self.assertNotIn("Latest artifacts", project_index)

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

    def test_stale_draft_state_in_project_index_auto_block_is_not_reindexed_during_team_update(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            team_dir = root / "team"
            stale_tag = "20260504T020000Z-d0-draft-r1"
            team_tag = "20260504T020000Z-m0-team-r1"
            team_run = team_dir / "runs" / team_tag
            team_run.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (team_run / f"{team_tag}_member_a.md").write_text("# member a\n", encoding="utf-8")
            (root / "project_index.md").write_text(
                "\n".join(
                    (
                        "# proj — project_index",
                        "",
                        "Last updated: 2026-05-04T00:00:00Z",
                        "",
                        "<!-- PROJECT_INDEX_AUTO_START -->",
                        "- Auto-updated at: 2026-05-04T00:00:00Z",
                        "- Latest pointers: [team/LATEST.md](team/LATEST.md)",
                        f"- Draft latest tag: {stale_tag}",
                        "- Draft latest status: draft_member_reports",
                        "- Latest draft: [team/LATEST_DRAFT.md](team/LATEST_DRAFT.md)",
                        "<!-- PROJECT_INDEX_AUTO_END -->",
                        "",
                    )
                ),
                encoding="utf-8",
            )

            result = _run_update_project_map(
                root,
                "--latest-kind",
                "team",
                "--tag",
                team_tag,
                "--status",
                "preflight_ok",
            )

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_index = (team_dir / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertNotIn("LATEST_DRAFT.md", latest_index)
        self.assertNotIn("Latest draft", project_index)
        self.assertNotIn("Draft latest tag:", project_index)
        self.assertNotIn("Draft latest status:", project_index)

    def test_artifacts_latest_is_created_only_for_real_artifact_run_and_is_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-m0-team-r1"
            team_run = root / "team" / "runs" / tag
            art_run = root / "artifacts" / "runs" / tag
            team_run.mkdir(parents=True)
            art_run.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (art_run / "summary.txt").write_text("ok\n", encoding="utf-8")

            result = _run_update_project_map(
                root,
                "--latest-kind",
                "team",
                "--tag",
                tag,
                "--status",
                "preflight_ok",
            )

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            latest_artifacts = (root / "artifacts" / "LATEST.md").read_text(encoding="utf-8")
            project_index = (root / "project_index.md").read_text(encoding="utf-8")

        self.assertIn(f"- Latest tag: {tag}", latest_artifacts)
        self.assertIn(
            f"- Canonical artifacts directory: [./runs/{tag}](./runs/{tag})",
            latest_artifacts,
        )
        self.assertIn("- Latest artifacts: [artifacts/LATEST.md](artifacts/LATEST.md)", project_index)

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

    def test_prune_team_dir_rejects_live_latest_team_pointer(self) -> None:
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

            tag = "20260504T020000Z-m0-team-r1"
            run_dir = root / "team" / "runs" / tag
            run_dir.mkdir(parents=True)
            (run_dir / f"{tag}_member_a.md").write_text("# member a\n", encoding="utf-8")
            active = _run_update_project_map(
                root,
                "--latest-kind",
                "team",
                "--tag",
                tag,
                "--status",
                "preflight_ok",
            )
            self.assertEqual(active.returncode, 0, msg=active.stdout)

            dry_run = _run_prune_optional_scaffold(
                root,
                "--archive-dir",
                str(root / "artifacts" / "migrations" / "prune_live_team"),
            )
            self.assertEqual(dry_run.returncode, 0, msg=dry_run.stdout)
            report = _read_prune_report(dry_run.stdout)
            team_items = [
                item for item in report["items"] if item["component"] == "scaffolds" and item["path"] == "team"
            ]

        self.assertTrue(team_items, msg=report)
        self.assertTrue(any(item["status"] == "skip" for item in team_items), msg=team_items)
        self.assertTrue(
            any(
                "not default" in item["reason"] or "contains non-default files" in item["reason"]
                for item in team_items
            ),
            msg=team_items,
        )

    def test_export_bundle_skips_missing_optional_latest_pointers(self) -> None:
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
            tag = "20260504T020000Z-m0-team-r1"
            run_dir = root / "team" / "runs" / tag
            run_dir.mkdir(parents=True)
            (run_dir / f"{tag}_member_a.md").write_text("# member a\n", encoding="utf-8")

            result = _run_export_paper_bundle(root, "--tag", tag, "--out", "export")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            bundle_dir = root / "export" / f"paper_bundle_{tag}"
            manifest = (bundle_dir / "MANIFEST.md").read_text(encoding="utf-8")
            has_latest_index = (bundle_dir / "team" / "LATEST.md").is_file()
            has_latest_team = (bundle_dir / "team" / "LATEST_TEAM.md").exists()
            has_latest_draft = (bundle_dir / "team" / "LATEST_DRAFT.md").exists()
            has_latest_artifacts = (bundle_dir / "artifacts" / "LATEST.md").exists()

        self.assertTrue(has_latest_index)
        self.assertFalse(has_latest_team)
        self.assertFalse(has_latest_draft)
        self.assertFalse(has_latest_artifacts)
        self.assertNotIn("LATEST_TEAM.md", manifest)
        self.assertNotIn("LATEST_DRAFT.md", manifest)
        self.assertNotIn("artifacts/LATEST.md", manifest)

    def test_export_bundle_copies_flat_team_run_files_into_runs_dir(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T120000Z-m1-pointer-r1"
            team_dir = root / "team"
            team_dir.mkdir(parents=True)
            legacy_member = team_dir / f"{tag}_member_a.md"
            legacy_member.write_text("# legacy member output\n", encoding="utf-8")
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")

            result = _run_export_paper_bundle(root, "--tag", tag, "--out", "export")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            exported = root / "export" / f"paper_bundle_{tag}" / "team" / "runs" / tag / legacy_member.name
            exported_exists = exported.is_file()
            exported_text = exported.read_text(encoding="utf-8") if exported_exists else ""

        self.assertTrue(exported_exists, msg=result.stdout)
        self.assertEqual(exported_text, "# legacy member output\n")

    def test_export_bundle_skips_mismatched_latest_team_pointer_and_warns(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            current_tag = "20260504T020000Z-m0-team-r1"
            other_tag = "20260504T030000Z-m0-team-r2"
            current_run = root / "team" / "runs" / current_tag
            other_run = root / "team" / "runs" / other_tag
            current_run.mkdir(parents=True)
            other_run.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "team" / "LATEST.md").write_text("# Latest pointers\n", encoding="utf-8")
            (root / "team" / "LATEST_TEAM.md").write_text(
                "\n".join(
                    (
                        "# Latest Team Cycle",
                        "",
                        f"- Latest tag: {other_tag}",
                        "- Status: preflight_ok",
                        f"- Run directory: [./runs/{other_tag}](./runs/{other_tag})",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            (other_run / f"{other_tag}_member_a.md").write_text("# member a\n", encoding="utf-8")
            (current_run / f"{current_tag}_member_a.md").write_text("# member a\n", encoding="utf-8")

            result = _run_export_paper_bundle(root, "--tag", current_tag, "--out", "export")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            bundle_dir = root / "export" / f"paper_bundle_{current_tag}"
            manifest = (bundle_dir / "MANIFEST.md").read_text(encoding="utf-8")

        self.assertFalse((bundle_dir / "team" / "LATEST_TEAM.md").exists())
        self.assertIn("[warn] skipped team/LATEST_TEAM.md", manifest)
        self.assertIn("pointer tag", manifest)
        self.assertNotIn("Use `team/LATEST_TEAM.md`", manifest)

    def test_export_bundle_skips_stale_artifacts_latest_pointer_and_warns(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-m0-team-r1"
            team_run = root / "team" / "runs" / tag
            team_run.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "artifacts").mkdir(parents=True)
            (root / "artifacts" / "LATEST.md").write_text(
                "\n".join(
                    (
                        "# Latest Artifacts",
                        "",
                        f"- Latest tag: {tag}",
                        f"- Canonical artifacts directory: [./runs/{tag}](./runs/{tag})",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            (team_run / f"{tag}_member_a.md").write_text("# member a\n", encoding="utf-8")

            result = _run_export_paper_bundle(root, "--tag", tag, "--out", "export")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            bundle_dir = root / "export" / f"paper_bundle_{tag}"
            manifest = (bundle_dir / "MANIFEST.md").read_text(encoding="utf-8")

        self.assertFalse((bundle_dir / "artifacts" / "LATEST.md").exists())
        self.assertIn("[warn] skipped artifacts/LATEST.md", manifest)
        self.assertIn("missing target", manifest)
        self.assertNotIn("Use `artifacts/LATEST.md`", manifest)

    def test_export_bundle_sanitizes_bundle_navigation_for_skipped_optional_pointers(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            current_tag = "20260504T020000Z-m0-team-r1"
            other_tag = "20260504T030000Z-m0-team-r2"
            current_run = root / "team" / "runs" / current_tag
            other_run = root / "team" / "runs" / other_tag
            current_run.mkdir(parents=True)
            other_run.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            _write_project_index(
                root,
                [
                    "- Auto-updated at: 2026-05-04T00:00:00Z",
                    "- Latest pointers: [team/LATEST.md](team/LATEST.md)",
                    f"- Team latest tag: {current_tag}",
                    "- Team latest status: preflight_ok",
                    "- Latest team: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)",
                    "- Latest artifacts: [artifacts/LATEST.md](artifacts/LATEST.md)",
                ],
            )
            (root / "team" / "LATEST.md").write_text(
                "\n".join(
                    (
                        "# Latest pointers",
                        "",
                        "- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)",
                        "- Draft cycle: [LATEST_DRAFT.md](LATEST_DRAFT.md)",
                        "- Trajectory index: [trajectory_index.json](trajectory_index.json)",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            (root / "team" / "LATEST_TEAM.md").write_text(
                "\n".join(
                    (
                        "# Latest Team Cycle",
                        "",
                        f"- Latest tag: {other_tag}",
                        "- Status: preflight_ok",
                        f"- Run directory: [./runs/{other_tag}](./runs/{other_tag})",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            (root / "team" / "trajectory_index.json").write_text("{\"runs\": []}\n", encoding="utf-8")
            (root / "artifacts").mkdir(parents=True)
            (root / "artifacts" / "LATEST.md").write_text(
                "\n".join(
                    (
                        "# Latest Artifacts",
                        "",
                        f"- Latest tag: {current_tag}",
                        f"- Canonical artifacts directory: [./runs/{current_tag}](./runs/{current_tag})",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            (current_run / f"{current_tag}_member_a.md").write_text("# member a\n", encoding="utf-8")
            (other_run / f"{other_tag}_member_a.md").write_text("# member a\n", encoding="utf-8")

            result = _run_export_paper_bundle(root, "--tag", current_tag, "--out", "export")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            bundle_dir = root / "export" / f"paper_bundle_{current_tag}"
            latest_index = (bundle_dir / "team" / "LATEST.md").read_text(encoding="utf-8")
            project_index = (bundle_dir / "docs" / "project_index.md").read_text(encoding="utf-8")

        self.assertNotIn("LATEST_TEAM.md", latest_index)
        self.assertNotIn("LATEST_DRAFT.md", latest_index)
        self.assertIn("- Trajectory index: [trajectory_index.json](trajectory_index.json)", latest_index)
        self.assertNotIn("Team latest tag:", project_index)
        self.assertNotIn("Team latest status:", project_index)
        self.assertNotIn("Latest team", project_index)
        self.assertNotIn("Latest artifacts", project_index)

    def test_export_bundle_keeps_bundle_navigation_for_live_optional_pointers(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-m0-team-r1"
            team_run = root / "team" / "runs" / tag
            artifacts_run = root / "artifacts" / "runs" / tag
            team_run.mkdir(parents=True)
            artifacts_run.mkdir(parents=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            _write_project_index(
                root,
                [
                    "- Auto-updated at: 2026-05-04T00:00:00Z",
                    "- Latest pointers: [team/LATEST.md](team/LATEST.md)",
                    f"- Team latest tag: {tag}",
                    "- Team latest status: preflight_ok",
                    "- Latest team: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)",
                    "- Latest artifacts: [artifacts/LATEST.md](artifacts/LATEST.md)",
                ],
            )
            (root / "team" / "LATEST.md").write_text("# source should be replaced\n", encoding="utf-8")
            (root / "team" / "LATEST_TEAM.md").write_text(
                "\n".join(
                    (
                        "# Latest Team Cycle",
                        "",
                        f"- Latest tag: {tag}",
                        "- Status: preflight_ok",
                        f"- Run directory: [./runs/{tag}](./runs/{tag})",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            (root / "team" / "trajectory_index.json").write_text("{\"runs\": []}\n", encoding="utf-8")
            (root / "artifacts" / "LATEST.md").write_text(
                "\n".join(
                    (
                        "# Latest Artifacts",
                        "",
                        f"- Latest tag: {tag}",
                        f"- Canonical artifacts directory: [./runs/{tag}](./runs/{tag})",
                        "",
                    )
                ),
                encoding="utf-8",
            )
            (team_run / f"{tag}_member_a.md").write_text("# member a\n", encoding="utf-8")

            result = _run_export_paper_bundle(root, "--tag", tag, "--out", "export")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            bundle_dir = root / "export" / f"paper_bundle_{tag}"
            latest_index = (bundle_dir / "team" / "LATEST.md").read_text(encoding="utf-8")
            project_index = (bundle_dir / "docs" / "project_index.md").read_text(encoding="utf-8")

        self.assertIn("- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)", latest_index)
        self.assertIn("- Trajectory index: [trajectory_index.json](trajectory_index.json)", latest_index)
        self.assertNotIn("LATEST_DRAFT.md", latest_index)
        self.assertIn(f"- Team latest tag: {tag}", project_index)
        self.assertIn("- Team latest status: preflight_ok", project_index)
        self.assertIn("- Latest team: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)", project_index)
        self.assertIn("- Latest artifacts: [artifacts/LATEST.md](artifacts/LATEST.md)", project_index)


if __name__ == "__main__":
    unittest.main()
