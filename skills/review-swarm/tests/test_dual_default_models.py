import importlib.util
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


def _write_stub_runner_requires_default_model(path: Path, label: str) -> None:
    path.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail

out=""
has_model=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model) has_model=1; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -z "${{out}}" ]]; then
  echo "{label}: missing --out" >&2
  exit 2
fi
if [[ "${{has_model}}" -ne 0 ]]; then
  echo "{label}: unexpected --model" >&2
  exit 13
fi

cat >"${{out}}" <<'MD'
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
    path.chmod(0o755)


def _run_main_with_argv(mod, argv: list[str]) -> int:
    import sys as _sys

    old_argv = _sys.argv
    try:
        _sys.argv = argv
        return mod.main()
    finally:
        _sys.argv = old_argv


class DualDefaultModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_dual_task_module()

    def test_dual_task_omits_model_flags_when_not_specified(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            stub_claude = td_path / "run_claude.sh"
            stub_gemini = td_path / "run_gemini.sh"
            _write_stub_runner_requires_default_model(stub_claude, "claude")
            _write_stub_runner_requires_default_model(stub_gemini, "gemini")

            sys_prompt = td_path / "sys.md"
            user_prompt = td_path / "packet.md"
            gem_prompt = td_path / "gem.txt"
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("# Packet\n", encoding="utf-8")
            gem_prompt.write_text("SYSTEM\n\nUSER\n", encoding="utf-8")

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
            ]

            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
