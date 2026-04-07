import unittest
import re
import json


def _src_root():
    from pathlib import Path

    return Path(__file__).resolve().parents[1] / "src"


class TestPublicCliSurface(unittest.TestCase):
    def _import_orchestrator_cli(self):
        import importlib
        import sys

        src_root = str(_src_root())
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
        return importlib.import_module("hep_autoresearch.orchestrator_cli")

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

        from hep_autoresearch.cli import main as cli_main

        argv0 = list(sys.argv)
        try:
            sys.argv = list(argv)
            buf_out, buf_err = StringIO(), StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = int(cli_main())
            return rc, buf_out.getvalue(), buf_err.getvalue()
        finally:
            sys.argv = argv0
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def _extract_top_level_commands(self, help_text: str) -> list[str]:
        match = re.search(r"\{([^}]+)\}", help_text)
        self.assertIsNotNone(match, "expected top-level help to contain a command inventory")
        return [part.strip() for part in (match.group(1) or "").split(",") if part.strip()]

    def _extract_run_workflow_ids(self, help_text: str) -> list[str]:
        match = re.search(r"--workflow-id\s+\{([^}]*)\}", help_text, re.MULTILINE)
        self.assertIsNotNone(match, "expected run help to contain a workflow-id inventory")
        return [part.strip() for part in (match.group(1) or "").split(",") if part.strip()]

    def test_help_hides_retired_public_legacy_surfaces(self) -> None:
        cli_mod = self._import_orchestrator_cli()

        rc, out, err = self._run_public_cli(["hepar", "--help"])
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")
        self.assertNotIn(" start ", out)
        self.assertNotIn(" checkpoint ", out)
        self.assertNotIn(" init ", out)
        self.assertNotIn(" status ", out)
        self.assertNotIn(" pause ", out)
        self.assertNotIn(" resume ", out)
        self.assertNotIn(" approve ", out)
        self.assertNotIn(" request-approval ", out)
        self.assertNotIn(" reject ", out)
        self.assertNotIn(" export ", out)
        self.assertNotIn(" literature-gap ", out)
        self.assertNotIn(" doctor ", out)
        self.assertNotIn(" bridge ", out)
        self.assertNotIn(" approvals ", out)
        self.assertNotIn(" report ", out)
        self.assertNotIn(" logs ", out)
        self.assertNotIn(" context ", out)
        self.assertNotIn(" smoke-test ", out)
        self.assertNotIn(" method-design ", out)
        self.assertNotIn(" propose ", out)
        self.assertNotIn(" skill-propose ", out)
        self.assertNotIn(" run-card ", out)
        self.assertNotIn(" branch ", out)
        self.assertNotIn(" migrate ", out)
        self.assertIn("run", out)
        self.assertEqual(self._extract_top_level_commands(out), list(cli_mod.PUBLIC_SHELL_COMMANDS))

    def test_public_run_help_excludes_computation_surface(self) -> None:
        cli_mod = self._import_orchestrator_cli()
        authority_map = self._read_front_door_authority_map()

        rc, out, err = self._run_public_cli(["hepar", "run", "--help"])
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")
        self.assertNotIn("{computation", out)
        self.assertNotIn("|computation|", out)
        self.assertNotIn("--trust-project", out)
        self.assertNotIn("--resume", out)
        self.assertNotIn("--project-dir", out)
        self.assertNotIn("--param", out)
        self.assertNotIn("--draft-tex", out)
        self.assertNotIn("--writer-backend", out)
        self.assertNotIn("--paper-reviser-mode", out)
        self.assertNotIn("ingest", out)
        self.assertNotIn("reproduce", out)
        self.assertNotIn("revision", out)
        self.assertNotIn("literature_survey_polish", out)
        self.assertNotIn("shell_adapter_smoke", out)
        self.assertIn("compatibility wrapper", out)
        self.assertIn("autoresearch run", out)
        self.assertIn("No installable public legacy run workflow ids remain", out)
        self.assertEqual(self._extract_run_workflow_ids(out), sorted(cli_mod._public_run_workflow_ids()))
        self.assertEqual(
            authority_map["surfaces"]["hepar_public_shell"]["run_workflow_ids"],
            list(cli_mod.PUBLIC_RUN_WORKFLOW_IDS),
        )

    def test_public_cli_rejects_retired_public_surfaces(self) -> None:
        for command in (
            "start",
            "checkpoint",
            "init",
            "status",
            "request-approval",
            "reject",
            "export",
            "doctor",
            "bridge",
            "literature-gap",
            "approvals",
            "report",
            "logs",
            "context",
            "smoke-test",
            "method-design",
            "propose",
            "skill-propose",
            "run-card",
            "branch",
            "migrate",
        ):
            rc, _, err = self._run_public_cli(["hepar", command])
            self.assertEqual(rc, 2)
            self.assertIn("invalid choice", err)
            self.assertIn(command, err)

    def test_public_run_rejects_computation_workflow(self) -> None:
        rc, _, err = self._run_public_cli(["hepar", "run", "--run-id", "M1-public", "--workflow-id", "computation"])
        self.assertEqual(rc, 2)
        self.assertIn("invalid choice", err)
        self.assertIn("computation", err)

    def test_public_run_rejects_internal_only_workflows(self) -> None:
        for workflow_id in ("ingest", "reproduce", "revision", "literature_survey_polish", "shell_adapter_smoke"):
            rc, _, err = self._run_public_cli(["hepar", "run", "--run-id", "M1-public", "--workflow-id", workflow_id])
            self.assertEqual(rc, 2)
            self.assertIn("invalid choice", err)
            self.assertIn(workflow_id, err)

    def test_public_run_rejects_retired_paper_reviser_workflow(self) -> None:
        rc, _, err = self._run_public_cli(["hepar", "run", "--run-id", "M1-public", "--workflow-id", "paper_reviser"])
        self.assertEqual(rc, 2)
        self.assertIn("invalid choice", err)
        self.assertIn("paper_reviser", err)

    def test_package_docs_publish_exact_public_command_inventory(self) -> None:
        cli_mod = self._import_orchestrator_cli()

        en_snippet = f"Exact installable public command inventory: {cli_mod.PUBLIC_SHELL_COMMANDS_MARKDOWN}."
        zh_snippet = f"安装态 public shell 的精确命令清单是：{cli_mod.PUBLIC_SHELL_COMMANDS_MARKDOWN}。"

        self.assertIn(en_snippet, self._read_repo_file("packages/hep-autoresearch/README.md"))
        self.assertIn(zh_snippet, self._read_repo_file("packages/hep-autoresearch/README.zh.md"))
        self.assertIn(en_snippet, self._read_repo_file("packages/hep-autoresearch/docs/ORCHESTRATOR_INTERACTION.md"))
        self.assertIn(zh_snippet, self._read_repo_file("packages/hep-autoresearch/docs/ORCHESTRATOR_INTERACTION.zh.md"))

    def test_authority_map_keeps_exact_public_shell_inventory(self) -> None:
        cli_mod = self._import_orchestrator_cli()
        authority_map = self._read_front_door_authority_map()
        surface = authority_map["surfaces"]["hepar_public_shell"]

        self.assertEqual(surface["classification"], "compatibility_public")
        self.assertEqual(surface["surface_kind"], "cli_command_inventory")
        self.assertEqual(
            surface["exact_inventory_source"],
            "packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py#PUBLIC_SHELL_COMMANDS",
        )
        self.assertEqual(surface["commands"], list(cli_mod.PUBLIC_SHELL_COMMANDS))
        self.assertEqual(
            surface["run_workflow_inventory_source"],
            "packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py#PUBLIC_RUN_WORKFLOW_IDS",
        )
        self.assertEqual(surface["run_workflow_ids"], list(cli_mod.PUBLIC_RUN_WORKFLOW_IDS))

    def test_authority_map_explicitly_classifies_internal_only_full_parser_residue(self) -> None:
        authority_map = self._read_front_door_authority_map()
        surface = authority_map["surfaces"]["hepar_internal_full_parser"]
        groups = {entry["group"]: entry["commands"] for entry in surface["command_groups"]}

        self.assertEqual(surface["classification"], "internal_only")
        self.assertEqual(surface["surface_kind"], "compatibility_full_parser")
        self.assertEqual(
            surface["exact_inventory_source"],
            "packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py#main(public_surface=False)",
        )
        self.assertEqual(
            groups["legacy_lifecycle_adapters"],
            ["init", "status", "pause", "resume", "approve", "export"],
        )
        self.assertEqual(
            groups["internal_support_commands"],
            [],
        )
        self.assertEqual(
            groups["retired_public_support_commands"],
            [
                "method-design",
                "run-card",
                "branch",
            ],
        )
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
