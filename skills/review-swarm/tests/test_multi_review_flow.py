import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


def _load_run_multi_task_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "run_multi_task.py"
    spec = importlib.util.spec_from_file_location("run_multi_task", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_runner(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def _runner_valid_contract() -> str:
    return """#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >"${out}" <<'MD'
VERDICT: READY

## Blockers
- none

## Non-blocking
- none

## Real-research fit
- n/a

## Robustness & safety
- n/a

## Specific patch suggestions
- n/a
MD
"""


def _runner_invalid_contract() -> str:
    return """#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >"${out}" <<'TXT'
hello from invalid reviewer output
TXT
"""


def _run_main_with_argv(mod, argv: list[str]) -> int:
    import sys as _sys

    old_argv = _sys.argv
    try:
        _sys.argv = argv
        return mod.main()
    finally:
        _sys.argv = old_argv


class MultiReviewFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()
        # Disable project config auto-discovery so tests are hermetic.
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)

    def test_contract_fail_is_informational_only(self):
        """contract_fail is recorded in meta but does NOT affect exit code or success."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            claude_runner = td_path / "run_claude.sh"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"
            codex_runner = td_path / "run_codex.sh"

            _write_runner(claude_runner, _runner_valid_contract())
            _write_runner(gemini_runner, _runner_invalid_contract())
            _write_runner(opencode_runner, _runner_valid_contract())
            _write_runner(codex_runner, _runner_valid_contract())
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
                "--codex-runner",
                str(codex_runner),
                "--system",
                str(system),
                "--prompt",
                str(prompt),
                "--models",
                "claude/default,gemini/default",
                "--check-review-contract",
                "--fallback-mode",
                "off",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            # Contract failure is informational — exit code 0, all agents succeed.
            self.assertEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["success_count"], 2)
            # The gemini agent should have contract_ok=False recorded.
            gemini_agent = [a for a in meta["agents"] if a.get("backend") == "gemini"][0]
            self.assertFalse(gemini_agent.get("contract_ok"))

    def test_auto_fallback_not_triggered_by_contract_fail(self):
        """contract_fail does NOT trigger fallback — both agents stay canonical."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            claude_runner = td_path / "run_claude.sh"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"
            codex_runner = td_path / "run_codex.sh"

            _write_runner(claude_runner, _runner_valid_contract())
            _write_runner(gemini_runner, _runner_invalid_contract())
            _write_runner(opencode_runner, _runner_valid_contract())
            _write_runner(codex_runner, _runner_valid_contract())
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
                "--codex-runner",
                str(codex_runner),
                "--system",
                str(system),
                "--prompt",
                str(prompt),
                "--models",
                "claude/default,gemini/default",
                "--check-review-contract",
                "--fallback-mode",
                "auto",
                "--fallback-order",
                "claude",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            # No fallback triggered — all agents are canonical.
            self.assertEqual(meta["success_count"], 2)
            for agent in meta["agents"]:
                self.assertNotEqual(agent.get("variant"), "fallback")

    def test_ask_mode_not_triggered_by_contract_fail(self):
        """contract_fail does NOT trigger ask mode — exit code 0."""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            claude_runner = td_path / "run_claude.sh"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"
            codex_runner = td_path / "run_codex.sh"

            _write_runner(claude_runner, _runner_valid_contract())
            _write_runner(gemini_runner, _runner_invalid_contract())
            _write_runner(opencode_runner, _runner_valid_contract())
            _write_runner(codex_runner, _runner_valid_contract())
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
                "--codex-runner",
                str(codex_runner),
                "--system",
                str(system),
                "--prompt",
                str(prompt),
                "--models",
                "claude/default,gemini/default",
                "--check-review-contract",
                "--fallback-mode",
                "ask",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            # Contract failure doesn't trigger ask mode — succeeds normally.
            self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
