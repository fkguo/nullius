from __future__ import annotations

import os
import json
import signal
import subprocess
import time
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

# Count every invocation so tests can assert how many times the runner
# actually called the CLI (deterministic failure => exactly once).
if [[ -n "${FAKE_COUNT_FILE:-}" ]]; then
  printf 'x\\n' >>"${FAKE_COUNT_FILE}"
fi

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
  audit_home|fail_home|sleep_home)
    python3 - <<'PY'
import json, os, stat
from pathlib import Path
home = Path(os.environ["GEMINI_CLI_HOME"])
root = home / ".gemini"
report = {"home": str(home), "home_mode": stat.S_IMODE(home.stat().st_mode),
          "directory_mode": stat.S_IMODE(root.stat().st_mode),
          "file_modes": {p.name: stat.S_IMODE(p.stat().st_mode) for p in root.iterdir()},
          "oauth_present": (root / "oauth_creds.json").is_file(),
          "settings": json.loads((root / "settings.json").read_text())}
Path(os.environ["FAKE_HOME_REPORT"]).write_text(json.dumps(report))
PY
    if [[ "${mode}" == "sleep_home" ]]; then
      exec sleep 60
    fi
    printf 'Observed %s\\n' "${GEMINI_CLI_HOME}"
    if [[ "${mode}" == "fail_home" ]]; then
      printf 'failure at %s\\n' "${GEMINI_CLI_HOME}" >&2
      exit 7
    fi
    ;;
  deterministic_unbound_variable)
    echo 'gemini: line 1: GEMINI_FAKE_VAR: unbound variable' >&2
    exit 1
    ;;
  transient_reset_with_model)
    if [[ -n "${model}" ]]; then
      echo 'stream error: connection reset by peer' >&2
      exit 1
    fi
    echo "OK_FALLBACK"
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
    for key in ("GEMINI_CLI_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA"):
        env.pop(key, None)
    env["HOME"] = str(tmp_path / "fake-home")
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["FAKE_MODE"] = fake_mode
    env["FAKE_COUNT_FILE"] = str(tmp_path / "fake_gemini_calls.log")
    env["FAKE_HOME_REPORT"] = str(tmp_path / "home-observation.json")
    if extra_env:
        env.update(extra_env)

    cmd = [
        "bash",
        str(RUNNER),
        "--prompt-file",
        str(prompt),
        "--out",
        str(out),
        "--no-proxy-first",
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


def test_explicit_gemini_home_does_not_receive_default_oauth(tmp_path: Path) -> None:
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

    assert not isolated_home.exists()


def _fake_oauth_home(tmp_path: Path) -> Path:
    home = tmp_path / "user-home"
    auth = home / ".gemini"
    auth.mkdir(parents=True)
    (auth / "settings.json").write_text('{"security":{"auth":{"selectedType":"oauth-personal"}}}')
    (auth / "oauth_creds.json").write_text('{"token":"dummy-never-valid"}')
    (auth / "google_accounts.json").write_text('{"accounts":[]}')
    return home


@pytest.mark.parametrize("mode,expected", [("audit_home", 0), ("fail_home", 7)])
def test_review_owns_private_temporary_home_and_removes_it(tmp_path: Path, mode: str, expected: int) -> None:
    home = _fake_oauth_home(tmp_path)
    proc, out = _run_runner(tmp_path, args=["--tool-mode", "review", "--no-fallback"], fake_mode=mode,
                            extra_env={"HOME": str(home), "TMPDIR": str(tmp_path)})
    assert proc.returncode == expected, proc.stderr
    report = json.loads((tmp_path / "home-observation.json").read_text())
    assert not Path(report["home"]).exists()
    assert not Path(report["home"]).is_relative_to(tmp_path.resolve())
    assert report["home_mode"] == report["directory_mode"] == 0o700
    assert set(report["file_modes"].values()) == {0o600}
    assert report["oauth_present"]
    assert report["settings"]["mcpServers"] == {}
    assert report["settings"]["security"]["auth"]["selectedType"] == "oauth-personal"
    assert report["home"] not in proc.stdout + proc.stderr + _out_text(out)
    assert "dummy-never-valid" not in proc.stdout + proc.stderr + _out_text(out)


def test_explicit_home_credentials_and_settings_are_untouched(tmp_path: Path) -> None:
    source_home = _fake_oauth_home(tmp_path)
    explicit = tmp_path / "explicit"
    auth = explicit / ".gemini"
    auth.mkdir(parents=True)
    for name in ("settings.json", "oauth_creds.json", "google_accounts.json"):
        (auth / name).write_text('{"user_owned":"dummy-existing"}')
    before = {p.name: p.read_bytes() for p in auth.iterdir()}
    proc, _ = _run_runner(tmp_path, args=["--tool-mode", "review", "--gemini-cli-home", str(explicit)],
                          extra_env={"HOME": str(source_home)})
    assert proc.returncode == 0, proc.stderr
    assert {p.name: p.read_bytes() for p in auth.iterdir()} == before


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT, signal.SIGHUP])
def test_review_signal_cleans_managed_home(tmp_path: Path, signum: int) -> None:
    home = _fake_oauth_home(tmp_path)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_gemini(bin_dir)
    prompt = tmp_path / "prompt"
    prompt.write_text("test")
    report_path = tmp_path / "observation.json"
    env = os.environ.copy()
    for key in ("GEMINI_CLI_HOME", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA"):
        env.pop(key, None)
    env.update(HOME=str(home), PATH=f"{bin_dir}:{env['PATH']}", FAKE_MODE="sleep_home", FAKE_HOME_REPORT=str(report_path))
    proc = subprocess.Popen(["bash", str(RUNNER), "--prompt-file", str(prompt), "--out", str(tmp_path / "out"),
                             "--tool-mode", "review"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 5
        while not report_path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert report_path.exists()
        proc.send_signal(signum)
        stdout, stderr = proc.communicate(timeout=5)
        assert proc.returncode == 128 + signum, (stdout, stderr)
        report = json.loads(report_path.read_text())
        assert not Path(report["home"]).exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def _fake_call_count(tmp_path: Path) -> int:
    count_file = tmp_path / "fake_gemini_calls.log"
    if not count_file.exists():
        return 0
    return len(count_file.read_text(encoding="utf-8").splitlines())


def test_deterministic_failure_skips_model_alias_fallback_and_fails_once(tmp_path: Path) -> None:
    # run_gemini.sh classifies stderr BEFORE the model-alias fallback: a
    # deterministic diagnostic must fail immediately (one CLI call, no
    # fallback without -m) and surface the classification on stderr.
    proc, out_path = _run_runner(
        tmp_path,
        args=["--model", "gemini-3.1-pro-preview", "--no-proxy-first"],
        fake_mode="deterministic_unbound_variable",
    )
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert _fake_call_count(tmp_path) == 1, "deterministic failure must not reach the model-alias fallback"
    assert "Gemini failed with a deterministic error" in proc.stderr
    assert "unbound variable" in proc.stderr
    assert _out_text(out_path) == ""


def test_transient_failure_still_reaches_model_alias_fallback(tmp_path: Path) -> None:
    # Negative control: a transient-looking failure (connection reset, exit 1)
    # must NOT be classified as deterministic — the existing model-alias
    # fallback (retry without -m) still runs and recovers.
    proc, out_path = _run_runner(
        tmp_path,
        args=["--model", "gemini-3.1-pro-preview", "--no-proxy-first"],
        fake_mode="transient_reset_with_model",
    )
    assert proc.returncode == 0, proc.stderr
    assert _fake_call_count(tmp_path) == 2, "transient failure must still fall back to the default model alias"
    assert _out_text(out_path) == "OK_FALLBACK\n"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
