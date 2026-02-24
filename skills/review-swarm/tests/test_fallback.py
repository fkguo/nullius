import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def _load_run_dual_task_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "run_dual_task.py"
    spec = importlib.util.spec_from_file_location("run_dual_task", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_stub_claude_runner(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -z "${out}" ]]; then
  echo "stub_claude: missing --out" >&2
  exit 2
fi

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
""",
        encoding="utf-8",
    )


def _write_stub_gemini_runner_blank_after_sanitize(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -z "${out}" ]]; then
  echo "stub_gemini: missing --out" >&2
  exit 2
fi

# Mimic the known Gemini CLI preamble that review-swarm strips; leaves an empty file after sanitize.
printf '%s\\n' "Hook registry initialized with 0 hook entries" >"${out}"
""",
        encoding="utf-8",
    )


class FallbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_dual_task_module()

    def test_auto_fallback_to_claude_on_empty_gemini(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)

            # Stub runners.
            stub_claude = td_path / "run_claude.sh"
            stub_gemini = td_path / "run_gemini.sh"
            _write_stub_claude_runner(stub_claude)
            _write_stub_gemini_runner_blank_after_sanitize(stub_gemini)

            # Inputs.
            sys_prompt = td_path / "sys.md"
            user_prompt = td_path / "packet.md"
            gem_prompt = td_path / "gem.txt"
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("# Packet\n", encoding="utf-8")
            gem_prompt.write_text("SYSTEM\n\nUSER\n", encoding="utf-8")

            out_dir = td_path / "out"

            argv = [
                "run_dual_task.py",
                "--out-dir",
                str(out_dir),
                "--claude-runner",
                str(stub_claude),
                "--gemini-runner",
                str(stub_gemini),
                "--claude-system",
                str(sys_prompt),
                "--claude-prompt",
                str(user_prompt),
                "--gemini-prompt",
                str(gem_prompt),
                "--check-review-contract",
                "--fallback-mode",
                "auto",
                "--fallback-order",
                "claude",
                "--fallback-claude-model",
                "sonnet",
            ]

            # Run.
            import sys as _sys

            old_argv = _sys.argv
            try:
                _sys.argv = argv
                code = self.mod.main()
            finally:
                _sys.argv = old_argv

            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["reviewer_b"]["variant"], "fallback")
            self.assertEqual(meta["reviewer_b"]["resolved"]["backend"], "claude")
            self.assertEqual(meta["diversity"], "degraded")

    def test_ask_mode_exits_needs_user_decision(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)

            stub_claude = td_path / "run_claude.sh"
            stub_gemini = td_path / "run_gemini.sh"
            _write_stub_claude_runner(stub_claude)
            _write_stub_gemini_runner_blank_after_sanitize(stub_gemini)

            sys_prompt = td_path / "sys.md"
            user_prompt = td_path / "packet.md"
            gem_prompt = td_path / "gem.txt"
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("# Packet\n", encoding="utf-8")
            gem_prompt.write_text("SYSTEM\n\nUSER\n", encoding="utf-8")

            out_dir = td_path / "out"

            argv = [
                "run_dual_task.py",
                "--out-dir",
                str(out_dir),
                "--claude-runner",
                str(stub_claude),
                "--gemini-runner",
                str(stub_gemini),
                "--claude-system",
                str(sys_prompt),
                "--claude-prompt",
                str(user_prompt),
                "--gemini-prompt",
                str(gem_prompt),
                "--check-review-contract",
                "--fallback-mode",
                "ask",
            ]

            import sys as _sys

            old_argv = _sys.argv
            try:
                _sys.argv = argv
                code = self.mod.main()
            finally:
                _sys.argv = old_argv

            self.assertEqual(code, 4)


if __name__ == "__main__":
    unittest.main()
