from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = SKILL_DIR / "scripts" / "run_gemini.sh"


def _write_fake_gemini(bin_dir: Path) -> Path:
    fake = bin_dir / "gemini"
    fake.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

mode="${FAKE_MODE:-success}"
model=""
approval_mode=""
output_format=""
extensions=""
sandbox=0
prompt=""
stdin_file="$(mktemp)"
trap 'rm -f "${stdin_file}"' EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)
      model="${2:-}"
      shift 2
      ;;
    --approval-mode)
      approval_mode="${2:-}"
      shift 2
      ;;
    -o|--output-format)
      output_format="${2:-}"
      shift 2
      ;;
    --extensions)
      extensions="${2:-}"
      shift 2
      ;;
    -p|--prompt)
      prompt="${2:-}"
      shift 2
      ;;
    --sandbox)
      sandbox=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done

cat >"${stdin_file}" || true

  case "${mode}" in
  echo_input)
    cat "${stdin_file}"
    ;;
  mcp_status_noise)
    printf 'MCP issues detected. Run /mcp list for status.\\n\\n'
    echo "OK_AFTER_SANITIZE"
    ;;
  inline_json_noise)
    printf 'MCP issues detected. Run /mcp list for status.{"verdict":"PASS","blocking_issues":[],"summary":"usable"}\\n'
    ;;
  thought_then_json)
    printf 'MCP issues detected. Run /mcp list for status.thought: checking packet\\n{"verdict":"PASS","blocking_issues":[],"summary":"usable"}\\n'
    ;;
  emit_metadata)
    printf 'sandbox=%s\\n' "${sandbox}"
    printf 'approval_mode=%s\\n' "${approval_mode}"
    printf 'output_format=%s\\n' "${output_format}"
    printf 'extensions=%s\\n' "${extensions}"
    printf 'model=%s\\n' "${model}"
    printf 'prompt=%s\\n' "${prompt}"
    ;;
  emit_env)
    printf 'gemini_api_key=%s\\n' "${GEMINI_API_KEY:-}"
    printf 'google_gemini_base_url=%s\\n' "${GOOGLE_GEMINI_BASE_URL:-}"
    ;;
  *)
    echo "OK_DEFAULT"
    ;;
esac
""",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    return fake


def _run_runner(
    tmp_path: Path,
    *,
    args: list[str],
    fake_mode: str = "success",
    prompt_text: str = "hello\n",
    system_text: str | None = None,
    extra_env: dict[str, str] | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    _write_fake_gemini(bin_dir)

    prompt = tmp_path / "prompt.txt"
    prompt.write_text(prompt_text, encoding="utf-8")
    out = tmp_path / "out.txt"
    system = tmp_path / "system.txt"

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["FAKE_MODE"] = fake_mode
    if extra_env:
        env.update(extra_env)

    cmd = [
        "bash",
        str(RUNNER),
        "--prompt-file",
        str(prompt),
        "--out",
        str(out),
    ]
    if system_text is not None:
        system.write_text(system_text, encoding="utf-8")
        cmd.extend(["--system-prompt-file", str(system)])
    cmd.extend(args)
    proc = subprocess.run(cmd, text=True, capture_output=True, env=env, check=False)
    return proc, out


def _out_text(out_path: Path) -> str:
    if not out_path.exists():
        return ""
    return out_path.read_text(encoding="utf-8")


def test_tool_mode_none_executes_without_unbound_array_failure(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--model", "gemini-3.1-pro-preview", "--no-fallback"],
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_DEFAULT\n"


def test_review_mode_dry_run_shows_plan_sandbox_and_no_extensions(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--tool-mode", "review", "--model", "gemini-3.1-pro-preview", "--dry-run"],
    )
    assert proc.returncode == 0, proc.stderr
    assert "tool_mode: review" in proc.stdout
    assert "approval_mode: plan" in proc.stdout
    assert "extensions: none" in proc.stdout
    assert "sandbox: 1" in proc.stdout
    assert "command: gemini --sandbox -m gemini-3.1-pro-preview --approval-mode plan -o text --extensions none -p" in proc.stdout
    assert _out_text(out_path) == ""


def test_system_prompt_prepended_with_single_blank_line(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--no-fallback"],
        fake_mode="echo_input",
        prompt_text="PROMPT\n",
        system_text="SYSTEM\n",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "SYSTEM\n\nPROMPT\n"


def test_sanitizes_known_mcp_status_prefix(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--no-fallback"],
        fake_mode="mcp_status_noise",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_AFTER_SANITIZE\n"


def test_sanitizes_inline_mcp_prefix_before_json(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--no-fallback"],
        fake_mode="inline_json_noise",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == '{"verdict":"PASS","blocking_issues":[],"summary":"usable"}\n'


def test_sanitizes_thought_preamble_before_json(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--no-fallback"],
        fake_mode="thought_then_json",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == '{"verdict":"PASS","blocking_issues":[],"summary":"usable"}\n'


def test_isolated_gemini_home_bootstraps_auth_env_from_default_home(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    home_gemini_dir = home_dir / ".gemini"
    home_gemini_dir.mkdir(parents=True, exist_ok=True)
    (home_gemini_dir / ".env").write_text(
        "GEMINI_API_KEY=test-key\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:5000\n",
        encoding="utf-8",
    )

    proc, out_path = _run_runner(
        tmp_path,
        args=[
            "--gemini-cli-home",
            str(tmp_path / "isolated-home"),
            "--model",
            "gemini-3.1-pro-preview",
            "--no-fallback",
        ],
        fake_mode="emit_env",
        extra_env={"HOME": str(home_dir)},
    )
    assert proc.returncode == 0, proc.stderr
    assert "gemini_api_key=test-key" in _out_text(out_path)
    assert "google_gemini_base_url=http://127.0.0.1:5000" in _out_text(out_path)


def test_isolated_gemini_home_bridges_oauth_personal_from_default_home(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    home_gemini_dir = home_dir / ".gemini"
    isolated_home = tmp_path / "isolated-home"
    home_gemini_dir.mkdir(parents=True, exist_ok=True)
    (home_gemini_dir / "settings.json").write_text(
        '{"security":{"auth":{"selectedType":"oauth-personal"}}}\n',
        encoding="utf-8",
    )
    (home_gemini_dir / "oauth_creds.json").write_text('{"token":"secret"}\n', encoding="utf-8")
    (home_gemini_dir / "google_accounts.json").write_text('{"accounts":[]}\n', encoding="utf-8")

    proc, out_path = _run_runner(
        tmp_path,
        args=[
            "--gemini-cli-home",
            str(isolated_home),
            "--model",
            "gemini-3.1-pro-preview",
            "--no-fallback",
        ],
        extra_env={"HOME": str(home_dir)},
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_DEFAULT\n"

    settings_payload = (isolated_home / ".gemini" / "settings.json").read_text(encoding="utf-8")
    assert '"selectedType": "oauth-personal"' in settings_payload
    assert (isolated_home / ".gemini" / "oauth_creds.json").exists()
    assert (isolated_home / ".gemini" / "google_accounts.json").exists()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
