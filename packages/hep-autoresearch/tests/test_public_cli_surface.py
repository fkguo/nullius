import json
import unittest


def _src_root():
    from pathlib import Path

    return Path(__file__).resolve().parents[1] / "src"


class TestPublicCliSurface(unittest.TestCase):
    def _read_repo_file(self, rel_path: str) -> str:
        from pathlib import Path

        return Path(__file__).resolve().parents[3].joinpath(rel_path).read_text(encoding="utf-8")

    def _read_front_door_authority_map(self) -> dict:
        return json.loads(self._read_repo_file("meta/front_door_authority_map_v1.json"))

    def _run_public_cli(self, argv: list[str]) -> tuple[int, str, str]:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        src_root = str(_src_root())
        added_path = False
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
            added_path = True

        from hep_autoresearch.cli import RETIRED_MESSAGE
        from hep_autoresearch.cli import main as cli_main

        argv0 = list(sys.argv)
        try:
            sys.argv = list(argv)
            buf_out, buf_err = StringIO(), StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = int(cli_main())
            self.assertEqual(buf_out.getvalue(), "")
            self.assertIn(RETIRED_MESSAGE, buf_err.getvalue())
            return rc, buf_out.getvalue(), buf_err.getvalue()
        finally:
            sys.argv = argv0
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def test_public_cli_fails_closed_for_help(self) -> None:
        rc, _, err = self._run_public_cli(["hepar", "--help"])
        self.assertEqual(rc, 1)
        self.assertIn("retired", err)
        self.assertIn("autoresearch", err)

    def test_public_cli_fails_closed_for_legacy_commands(self) -> None:
        for argv in (
            ["hepar", "run", "--help"],
            ["hepar", "run", "--run-id", "M1-public", "--workflow-id", "computation"],
            ["hepar", "status"],
            ["hepar", "literature-gap"],
        ):
            rc, _, err = self._run_public_cli(argv)
            self.assertEqual(rc, 1)
            self.assertIn("retired", err)

    def test_package_docs_publish_retired_shell_truth(self) -> None:
        self.assertIn("use `autoresearch` as the front door", self._read_repo_file("packages/hep-autoresearch/README.md"))
        self.assertIn("前门是 `autoresearch`", self._read_repo_file("packages/hep-autoresearch/README.zh.md"))
        self.assertIn("do not expect an installable `hepar` / `hep-autoresearch` public shell", self._read_repo_file("packages/hep-autoresearch/README.md"))
        self.assertIn("不要期待安装态 `hepar` / `hep-autoresearch` public shell 继续存在", self._read_repo_file("packages/hep-autoresearch/README.zh.md"))

    def test_authority_map_no_longer_exposes_hepar_public_shell(self) -> None:
        authority_map = self._read_front_door_authority_map()
        self.assertNotIn("hepar_public_shell", authority_map["surfaces"])

    def test_authority_map_keeps_internal_full_parser_residue_explicit(self) -> None:
        authority_map = self._read_front_door_authority_map()
        surface = authority_map["surfaces"]["hep_autoresearch_internal_parser"]
        groups = {entry["group"]: entry["commands"] for entry in surface["command_groups"]}

        self.assertEqual(surface["classification"], "internal_only")
        self.assertEqual(surface["surface_kind"], "internal_full_parser")
        self.assertEqual(
            surface["exact_inventory_source"],
            "packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py#main",
        )
        self.assertEqual(
            groups["legacy_lifecycle_adapters"],
            ["init", "status", "pause", "resume", "approve", "export"],
        )
        self.assertEqual(groups["internal_support_commands"], ["branch"])
        self.assertEqual(groups["retired_public_support_commands"], ["method-design", "run-card"])
        self.assertEqual(
            groups["internal_workflow_paths"],
            [
                "run --workflow-id computation",
                "run --workflow-id ingest",
                "run --workflow-id paper_reviser",
                "run --workflow-id reproduce",
                "run --workflow-id revision",
                "run --workflow-id literature_survey_polish",
            ],
        )
        self.assertEqual(groups["internal_adapter_workflow_paths"], ["run --workflow-id shell_adapter_smoke"])


if __name__ == "__main__":
    unittest.main()
