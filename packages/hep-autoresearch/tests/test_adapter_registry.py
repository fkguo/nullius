import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestAdapterRegistry(unittest.TestCase):
    def _load_registry(self):
        import sys

        src_root = str(_src_root())
        added_path = False
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
            added_path = True
        try:
            from hep_autoresearch.toolkit.adapters.adapter_plugin import AdapterPlugin
            from hep_autoresearch.toolkit.adapters.base import Adapter, CollectResult, ExecuteResult, PrepareResult, VerifyResult
            from hep_autoresearch.toolkit.adapters.registry import (
                adapter_for_workflow,
                adapter_workflow_ids,
                default_run_card_for_workflow,
                validate_adapter_registry,
            )

            return {
                "AdapterPlugin": AdapterPlugin,
                "Adapter": Adapter,
                "PrepareResult": PrepareResult,
                "ExecuteResult": ExecuteResult,
                "CollectResult": CollectResult,
                "VerifyResult": VerifyResult,
                "adapter_for_workflow": adapter_for_workflow,
                "adapter_workflow_ids": adapter_workflow_ids,
                "default_run_card_for_workflow": default_run_card_for_workflow,
                "validate_adapter_registry": validate_adapter_registry,
            }
        finally:
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def test_builtin_shell_plugin_preserves_existing_surface(self) -> None:
        loaded = self._load_registry()
        workflow_ids = loaded["adapter_workflow_ids"]()
        self.assertEqual(workflow_ids, {"shell_adapter_smoke"})

        adapter = loaded["adapter_for_workflow"]("shell_adapter_smoke")
        self.assertEqual(adapter.adapter_id, "shell")

        run_card = loaded["default_run_card_for_workflow"](
            workflow_id="shell_adapter_smoke",
            run_id="RUN-1",
            state={"artifacts": {"context_md": "a.md"}},
        )
        self.assertEqual(run_card["workflow_id"], "shell_adapter_smoke")
        self.assertEqual(run_card["run_id"], "RUN-1")
        self.assertEqual(run_card["adapter_id"], "shell")

    def test_extra_plugin_extends_registry_without_replacing_builtin(self) -> None:
        loaded = self._load_registry()
        AdapterPlugin = loaded["AdapterPlugin"]
        Adapter = loaded["Adapter"]
        PrepareResult = loaded["PrepareResult"]
        ExecuteResult = loaded["ExecuteResult"]
        CollectResult = loaded["CollectResult"]
        VerifyResult = loaded["VerifyResult"]

        class FakeAdapter(Adapter):
            @property
            def adapter_id(self) -> str:
                return "python"

            @property
            def backend_kind(self) -> str:
                return "internal"

            def prepare(self, run_card, state, *, repo_root, force):
                return PrepareResult(repo_root, tuple(), run_card, repo_root / "run_card.json", "0" * 64)

            def execute(self, prep, state, *, repo_root):
                return ExecuteResult(True, 0, False, 0.0, None, None, None, None, {}, [])

            def collect(self, prep, exec_result, state, *, repo_root, status):
                return CollectResult(prep.artifact_dir, {}, [])

            def verify(self, collected, state, *, repo_root):
                return VerifyResult(True, [])

        plugin = AdapterPlugin(
            plugin_id="python_test_plugin",
            workflow_ids=("python_adapter_smoke",),
            adapter_factory=FakeAdapter,
            default_run_card_factory=lambda workflow_id, run_id, state: {
                "schema_version": 1,
                "run_id": run_id,
                "workflow_id": workflow_id,
                "adapter_id": "python",
            },
        )
        workflow_ids = loaded["adapter_workflow_ids"](extra_plugins=[plugin])
        self.assertEqual(workflow_ids, {"shell_adapter_smoke", "python_adapter_smoke"})
        adapter = loaded["adapter_for_workflow"]("python_adapter_smoke", extra_plugins=[plugin])
        self.assertEqual(adapter.adapter_id, "python")
        loaded["validate_adapter_registry"](extra_plugins=[plugin])

    def test_duplicate_workflow_ids_fail_closed(self) -> None:
        loaded = self._load_registry()
        AdapterPlugin = loaded["AdapterPlugin"]

        plugin = AdapterPlugin(
            plugin_id="dupe_plugin",
            workflow_ids=("shell_adapter_smoke",),
            adapter_factory=lambda: object(),
            default_run_card_factory=lambda workflow_id, run_id, state: {},
        )
        with self.assertRaisesRegex(RuntimeError, "workflow_id collision"):
            loaded["adapter_workflow_ids"](extra_plugins=[plugin])

    def test_validate_adapter_registry_rejects_mismatched_run_card(self) -> None:
        loaded = self._load_registry()
        AdapterPlugin = loaded["AdapterPlugin"]
        Adapter = loaded["Adapter"]
        PrepareResult = loaded["PrepareResult"]
        ExecuteResult = loaded["ExecuteResult"]
        CollectResult = loaded["CollectResult"]
        VerifyResult = loaded["VerifyResult"]

        class FakeAdapter(Adapter):
            @property
            def adapter_id(self) -> str:
                return "docker"

            @property
            def backend_kind(self) -> str:
                return "internal"

            def prepare(self, run_card, state, *, repo_root, force):
                return PrepareResult(repo_root, tuple(), run_card, repo_root / "run_card.json", "0" * 64)

            def execute(self, prep, state, *, repo_root):
                return ExecuteResult(True, 0, False, 0.0, None, None, None, None, {}, [])

            def collect(self, prep, exec_result, state, *, repo_root, status):
                return CollectResult(prep.artifact_dir, {}, [])

            def verify(self, collected, state, *, repo_root):
                return VerifyResult(True, [])

        plugin = AdapterPlugin(
            plugin_id="docker_test_plugin",
            workflow_ids=("docker_adapter_smoke",),
            adapter_factory=FakeAdapter,
            default_run_card_factory=lambda workflow_id, run_id, state: {
                "schema_version": 1,
                "run_id": run_id,
                "workflow_id": workflow_id,
                "adapter_id": "shell",
            },
        )
        with self.assertRaisesRegex(RuntimeError, "mismatched adapter_id"):
            loaded["validate_adapter_registry"](extra_plugins=[plugin])


if __name__ == "__main__":
    unittest.main()
