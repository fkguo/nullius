import json
import os
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
    # Positive controls start with the generic scaffold's carrier already present.
    if not (root / "project_index.md").is_file():
        _write_project_index(root, [])
    before = (root / "project_index.md").read_bytes()
    mode = (root / "project_index.md").stat().st_mode
    result = subprocess.run(
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
    assert (root / "project_index.md").read_bytes() == before
    assert (root / "project_index.md").stat().st_mode == mode
    return result



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
    def test_root_index_reverse_aliases_refuse_before_any_navigation_write(self) -> None:
        for rel in ("team/LATEST.md", "team/LATEST_TEAM.md", "team/LATEST_DRAFT.md", "artifacts/LATEST.md"):
            with self.subTest(rel=rel), tempfile.TemporaryDirectory() as td:
                root = Path(td)
                (root / "project_charter.md").write_text("# Charter\n", encoding="utf-8")
                (root / "research_contract.md").write_text("# Contract\n", encoding="utf-8")
                pointer = root / rel
                pointer.parent.mkdir(parents=True)
                protected = b"# Human index\r\nLast updated: owner\r\n<!-- PROJECT_INDEX_AUTO_START -->\r\nowner\r\n<!-- PROJECT_INDEX_AUTO_END -->\r\n"
                pointer.write_bytes(protected)
                pointer.chmod(0o640)
                index = root / "project_index.md"
                index.symlink_to(rel)
                before = {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mode, p.stat().st_ino, p.stat().st_mtime_ns)
                          for p in root.rglob("*") if p.is_file()}
                result = _run_update_project_map(root)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn("root index must be an unshared regular file", result.stdout)
                self.assertEqual(index.readlink(), Path(rel))
                after = {str(p.relative_to(root)): (p.read_bytes(), p.stat().st_mode, p.stat().st_ino, p.stat().st_mtime_ns)
                         for p in root.rglob("*") if p.is_file()}
                self.assertEqual(after, before)

    def test_all_pointer_aliases_refuse_before_any_navigation_write(self) -> None:
        for rel in ("team/LATEST.md", "team/LATEST_TEAM.md", "team/LATEST_DRAFT.md", "artifacts/LATEST.md"):
            for kind in ("symlink", "hardlink"):
                with self.subTest(rel=rel, kind=kind), tempfile.TemporaryDirectory() as td:
                    root = Path(td) / "proj"
                    root.mkdir()
                    (root / "project_charter.md").write_text("# Charter\n", encoding="utf-8")
                    (root / "research_contract.md").write_text("# Contract\n", encoding="utf-8")
                    _write_project_index(root, ["Human-owned prior auto bytes"])
                    index = root / "project_index.md"
                    index.chmod(0o640)
                    pointer = root / rel
                    pointer.parent.mkdir(parents=True, exist_ok=True)
                    if kind == "symlink":
                        pointer.symlink_to(index)
                    else:
                        os.link(index, pointer)
                    before_paths = sorted(str(p.relative_to(root)) for p in root.rglob("*"))
                    result = _run_update_project_map(root)
                    self.assertEqual(result.returncode, 2, result.stdout)
                    self.assertIn("ERROR:", result.stdout)
                    self.assertEqual(sorted(str(p.relative_to(root)) for p in root.rglob("*")), before_paths)
                    self.assertEqual(index.stat().st_mode & 0o7777, 0o640)

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
            (root / "team").mkdir(exist_ok=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "artifacts" / "runs").mkdir(parents=True, exist_ok=True)
            (root / "artifacts" / "runs").mkdir(parents=True, exist_ok=True)

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
            (root / "team").mkdir(exist_ok=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "artifacts" / "runs").mkdir(parents=True, exist_ok=True)

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
            run_dir = root / "artifacts" / "runs" / tag / "research_team"
            run_dir.mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
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
            artifacts_pointer_exists = (root / "artifacts" / "LATEST.md").is_file()

        self.assertIn(f"- Latest tag: {tag}", latest_team)
        self.assertIn("- Status: preflight_ok", latest_team)
        self.assertIn(f"- Run directory: [../artifacts/runs/{tag}/research_team](../artifacts/runs/{tag}/research_team)", latest_team)
        self.assertIn(f"- Member A report: [../artifacts/runs/{tag}/research_team/{tag}_member_a.md](../artifacts/runs/{tag}/research_team/{tag}_member_a.md)", latest_team)
        self.assertIn("- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)", latest_index)
        self.assertTrue(artifacts_pointer_exists)

    def test_stale_existing_latest_team_and_artifacts_pointers_are_not_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            team_dir = root / "team"
            team_dir.mkdir(exist_ok=True)
            artifacts_dir = root / "artifacts"
            stale_tag = "20260504T020000Z-m0-team-r1"
            (root / "team").mkdir(exist_ok=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (team_dir / "runs").mkdir(parents=True, exist_ok=True)
            artifacts_dir.mkdir(parents=True, exist_ok=True)
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
            team_dir.mkdir(exist_ok=True)
            run_tag = "M1-team-r1"
            (root / "artifacts" / "runs" / run_tag / "research_team").mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
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
            team_dir.mkdir(exist_ok=True)
            stale_tag = "20260504T020000Z-d0-draft-r1"
            team_tag = "20260504T020000Z-m0-team-r1"
            team_run = root / "artifacts" / "runs" / team_tag / "research_team"
            team_run.mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
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
        self.assertIn("Latest draft", project_index)
        self.assertIn("Draft latest tag:", project_index)
        self.assertIn("Draft latest status:", project_index)

    def test_artifacts_latest_is_created_only_for_real_artifact_run_and_is_indexed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-m0-team-r1"
            team_run = root / "artifacts" / "runs" / tag / "research_team"
            art_run = root / "artifacts" / "runs" / tag
            team_run.mkdir(parents=True, exist_ok=True)
            art_run.mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
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

    def test_explicit_draft_state_creates_live_latest_run_pointer_and_indexes_it(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-d0-draft-r1"
            run_dir = root / "artifacts" / "runs" / tag / "research_team"
            run_dir.mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
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
        self.assertIn(f"- Run directory: [../artifacts/runs/{tag}/research_team](../artifacts/runs/{tag}/research_team)", latest_draft)
        self.assertIn(f"- Draft packet: [../artifacts/runs/{tag}/research_team/{tag}_draft_packet.md](../artifacts/runs/{tag}/research_team/{tag}_draft_packet.md)", latest_draft)
        self.assertNotIn("optional / not configured", latest_draft)
        self.assertNotIn("Status: not configured", latest_draft)
        self.assertIn("- Draft cycle: [LATEST_DRAFT.md](LATEST_DRAFT.md)", latest_index)

    def test_placeholder_latest_draft_is_deleted_when_no_explicit_draft_state(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            team_dir = root / "team"
            team_dir.mkdir(exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (team_dir / "runs").mkdir(parents=True, exist_ok=True)
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
            draft_run = root / "artifacts" / "runs" / draft_tag / "research_team"
            draft_run.mkdir(parents=True, exist_ok=True)
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
            any("not default" in item["reason"] for item in live_team_items),
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
            run_dir = root / "artifacts" / "runs" / tag / "research_team"
            run_dir.mkdir(parents=True, exist_ok=True)
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
            run_dir = root / "artifacts" / "runs" / tag / "research_team"
            run_dir.mkdir(parents=True, exist_ok=True)
            (run_dir / f"{tag}_member_a.md").write_text("# member a\n", encoding="utf-8")

            result = _run_export_paper_bundle(root, "--tag", tag, "--out", "export",
                                             "--without-project-docs", "--include",
                                             f"artifacts/runs/{tag}/research_team/{tag}_member_a.md")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            bundle_dir = root / "export" / f"paper_bundle_{tag}"
            manifest = (bundle_dir / "MANIFEST.md").read_text(encoding="utf-8")
            has_latest_index = (bundle_dir / "team" / "LATEST.md").is_file()
            has_latest_team = (bundle_dir / "team" / "LATEST_TEAM.md").exists()
            has_latest_draft = (bundle_dir / "team" / "LATEST_DRAFT.md").exists()
            has_latest_artifacts = (bundle_dir / "artifacts" / "LATEST.md").exists()

        self.assertFalse(has_latest_index)
        self.assertFalse(has_latest_team)
        self.assertFalse(has_latest_draft)
        self.assertFalse(has_latest_artifacts)
        self.assertNotIn("LATEST_TEAM.md", manifest)
        self.assertNotIn("LATEST_DRAFT.md", manifest)
        self.assertNotIn("artifacts/LATEST.md", manifest)

    def test_export_bundle_copies_canonical_team_payload(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T120000Z-m1-pointer-r1"
            team_dir = root / "team"
            team_dir.mkdir(exist_ok=True)
            team_dir.mkdir(parents=True, exist_ok=True)
            payload = root / "artifacts" / "runs" / tag / "research_team"
            payload.mkdir(parents=True, exist_ok=True)
            legacy_member = payload / f"{tag}_member_a.md"
            legacy_member.write_text("# legacy member output\n", encoding="utf-8")
            (root / "team").mkdir(exist_ok=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")

            result = _run_export_paper_bundle(root, "--tag", tag, "--out", "export")

            self.assertEqual(result.returncode, 0, msg=result.stdout)
            exported = root / "export" / f"paper_bundle_{tag}" / "artifacts" / "runs" / tag / "research_team" / legacy_member.name
            exported_exists = exported.is_file()
            exported_text = exported.read_text(encoding="utf-8") if exported_exists else ""

        self.assertTrue(exported_exists, msg=result.stdout)
        self.assertEqual(exported_text, "# legacy member output\n")

    def test_export_bundle_does_not_add_unreferenced_latest_team_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            current_tag = "20260504T020000Z-m0-team-r1"
            other_tag = "20260504T030000Z-m0-team-r2"
            current_run = root / "artifacts" / "runs" / current_tag / "research_team"
            other_run = root / "artifacts" / "runs" / other_tag / "research_team"
            current_run.mkdir(parents=True, exist_ok=True)
            other_run.mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
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
        self.assertNotIn("team/LATEST_TEAM.md", manifest)
        self.assertNotIn("Use `team/LATEST_TEAM.md`", manifest)

    def test_export_bundle_does_not_add_unreferenced_artifacts_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-m0-team-r1"
            team_run = root / "artifacts" / "runs" / tag / "research_team"
            team_run.mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
            (root / "project_charter.md").write_text("Project: Pointer Demo\n", encoding="utf-8")
            (root / "research_contract.md").write_text("# contract\n", encoding="utf-8")
            (root / "artifacts").mkdir(parents=True, exist_ok=True)
            (root / "artifacts" / "LATEST.md").write_text(
                "\n".join(
                    (
                        "# Latest Artifacts",
                        "",
                        f"- Latest tag: {tag}",
                        f"- Canonical artifacts directory: [../artifacts/runs/{tag}/research_team](../artifacts/runs/{tag}/research_team)",
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
        self.assertNotIn("artifacts/LATEST.md", manifest)
        self.assertNotIn("Use `artifacts/LATEST.md`", manifest)

    def test_export_bundle_rejects_broken_navigation_without_rewriting_it(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            current_tag = "20260504T020000Z-m0-team-r1"
            other_tag = "20260504T030000Z-m0-team-r2"
            current_run = root / "artifacts" / "runs" / current_tag / "research_team"
            other_run = root / "artifacts" / "runs" / other_tag / "research_team"
            current_run.mkdir(parents=True, exist_ok=True)
            other_run.mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
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
            (root / "artifacts").mkdir(parents=True, exist_ok=True)
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

            original_index = (root / "project_index.md").read_bytes()
            result = _run_export_paper_bundle(root, "--tag", current_tag, "--out", "export")

            self.assertEqual(result.returncode, 2, msg=result.stdout)
            self.assertIn("incomplete bundle", result.stdout)
            self.assertEqual((root / "project_index.md").read_bytes(), original_index)
            self.assertFalse((root / "export" / f"paper_bundle_{current_tag}").exists())

    def test_export_bundle_keeps_bundle_navigation_for_live_optional_pointers(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            tag = "20260504T020000Z-m0-team-r1"
            team_run = root / "artifacts" / "runs" / tag / "research_team"
            artifacts_run = root / "artifacts" / "runs" / tag
            team_run.mkdir(parents=True, exist_ok=True)
            artifacts_run.mkdir(parents=True, exist_ok=True)
            (root / "team").mkdir(exist_ok=True)
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
                        f"- Run directory: [../artifacts/runs/{tag}/research_team](../artifacts/runs/{tag}/research_team)",
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
            project_index = (bundle_dir / "project_index.md").read_text(encoding="utf-8")
            self.assertEqual((bundle_dir / "project_index.md").read_bytes(), (root / "project_index.md").read_bytes())
            self.assertTrue((bundle_dir / "team/LATEST_TEAM.md").is_file())

        self.assertEqual(latest_index, "# source should be replaced\n")
        self.assertIn(f"- Team latest tag: {tag}", project_index)
        self.assertIn("- Team latest status: preflight_ok", project_index)
        self.assertIn("- Latest team: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)", project_index)
        self.assertIn("- Latest artifacts: [artifacts/LATEST.md](artifacts/LATEST.md)", project_index)


if __name__ == "__main__":
    unittest.main()
