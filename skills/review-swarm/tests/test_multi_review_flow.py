import importlib.util
import json
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

    def test_contract_fail_without_fallback_returns_nonzero(self):
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
            self.assertEqual(code, 1)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["success_count"], 1)

    def test_auto_fallback_recovers_invalid_gemini_output(self):
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
            reviewer_b = meta.get("reviewer_b", {})
            self.assertEqual(reviewer_b.get("variant"), "fallback")
            self.assertEqual((reviewer_b.get("resolved") or {}).get("backend"), "claude")

    def test_ask_mode_returns_needs_user_decision(self):
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
            self.assertEqual(code, 4)


if __name__ == "__main__":
    unittest.main()
