import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

_SKILL_ROOT = Path(__file__).resolve().parents[1]


def _load_module(name: str):
    module_path = _SKILL_ROOT / "scripts" / "bin" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_trace_events(trace_path: Path) -> list[dict]:
    if not trace_path.exists():
        return []
    return [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_stub_runner(path: Path) -> None:
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
    path.chmod(0o755)


def _write_empty_then_valid_runner(path: Path, state_dir: Path) -> None:
    """Runner that writes an empty file on the first call, valid output after."""
    state_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
count_file="{state_dir}/count"
n=0
if [[ -f "${{count_file}}" ]]; then
  n=$(cat "${{count_file}}")
fi
n=$((n + 1))
echo "${{n}}" >"${{count_file}}"
if [[ "${{n}}" -ge 2 ]]; then
  printf 'VERDICT: READY\\n' >"${{out}}"
else
  : >"${{out}}"
fi
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


@contextlib.contextmanager
def _temp_env(**updates):
    old = {}
    for k, v in updates.items():
        old[k] = os.environ.get(k)
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@contextlib.contextmanager
def _chdir(path: Path):
    prior = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(prior)


class ReviewOneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_module("review_one")
        # Hermetic: never let a real project config leak into these tests.
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)

    def _basic_argv(self, td_path: Path, out_dir: Path, artifact: Path, *extra: str) -> list[str]:
        runner = td_path / "run_codex.sh"
        if not runner.exists():
            _write_stub_runner(runner)
        return [
            "--model",
            "codex/default",
            "--artifact",
            str(artifact),
            "--codex-runner",
            str(runner),
            "--out-dir",
            str(out_dir),
            *extra,
        ]

    def test_packet_assembly_banner_artifact_and_template(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("ARTIFACT MARKER alpha-beta-gamma\n", encoding="utf-8")

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                rc = self.mod.main(self._basic_argv(td_path, out_dir, artifact))
            self.assertEqual(rc, 0)

            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            self.assertTrue(packet.startswith(self.mod.ADVISORY_BANNER))
            self.assertIn("ARTIFACT MARKER alpha-beta-gamma", packet)
            self.assertIn(f"=== ARTIFACT: {artifact.resolve()} ===", packet)

            # Default role: the delegated system prompt is templates/generic.md verbatim.
            system_text = (out_dir / "inputs" / "system.md").read_text(encoding="utf-8")
            template_text = (_SKILL_ROOT / "templates" / "generic.md").read_text(encoding="utf-8")
            self.assertEqual(system_text, template_text)
            self.assertIn("VERDICT: READY", template_text)
            self.assertIn("## Blockers", template_text)

            # stdout summary: verdict line, contract_ok, output paths.
            printed = stdout.getvalue()
            self.assertIn("verdict: VERDICT: READY", printed)
            self.assertIn("contract_ok: true", printed)
            self.assertIn("output: ", printed)
            self.assertIn("meta: ", printed)

    def test_meta_shape_for_single_run(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(self._basic_argv(td_path, out_dir, artifact))
            self.assertEqual(rc, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["n_agents"], 1)
            self.assertEqual(meta["models"], ["codex/default"])
            self.assertEqual(meta["success_count"], 1)
            self.assertEqual(meta["unavailable_backends"], [])
            agent = meta["agents"][0]
            self.assertEqual(agent["verdict"], "VERDICT: READY")
            self.assertTrue(agent["contract_ok"])
            self.assertIsNone(agent["failure_reason"])
            self.assertIsNone(agent["failure_class"])
            self.assertEqual(len(meta["paths"]["outputs"]), 1)

    def test_role_selects_template(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(self._basic_argv(td_path, out_dir, artifact, "--role", "source-fidelity"))
            self.assertEqual(rc, 0)
            system_text = (out_dir / "inputs" / "system.md").read_text(encoding="utf-8")
            template_text = (_SKILL_ROOT / "templates" / "source-fidelity.md").read_text(encoding="utf-8")
            self.assertEqual(system_text, template_text)

    def test_all_role_templates_carry_contract_format(self):
        for role in self.mod._ROLES:
            template = (_SKILL_ROOT / "templates" / f"{role}.md").read_text(encoding="utf-8")
            for required in (
                "VERDICT: READY",
                "VERDICT: NOT_READY",
                "## Blockers",
                "## Non-blocking",
                "## Real-research fit",
                "## Robustness & safety",
                "## Specific patch suggestions",
            ):
                self.assertIn(required, template, f"{role}.md missing {required!r}")

    def test_artifact_embedding_hits_size_guard(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "big.md"
            artifact.write_text("X" * 10_000, encoding="utf-8")

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(td_path, out_dir, artifact, "--max-prompt-bytes", "5000")
                )
            self.assertEqual(rc, 2)
            self.assertIn("exceeds configured prompt limit", stderr.getvalue())

            events = _read_trace_events(out_dir / "trace.jsonl")
            violations = [e for e in events if e.get("event") == "prompt_guard_violation"]
            self.assertTrue(violations)
            self.assertEqual(violations[-1]["label"], "prompt")
            # Refused before any delegation: no runner ran, no meta was written.
            self.assertFalse((out_dir / "meta.json").exists())

    def test_model_is_required(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    self.mod.main(["--artifact", str(artifact)])
            self.assertEqual(ctx.exception.code, 2)

    def test_model_rejects_multiple_specs(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                rc = self.mod.main(
                    ["--model", "codex/default,gemini/default", "--artifact", str(artifact)]
                )
            self.assertEqual(rc, 2)
            self.assertIn("exactly one model spec", stderr.getvalue())

    def test_host_family_refusal_points_to_in_host_review(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--artifact",
                        str(artifact),
                        "--host-family",
                        "codex",
                    ]
                )
            self.assertEqual(rc, 2)
            message = stderr.getvalue()
            self.assertIn("your own (host) family", message)
            self.assertIn("in-host", message)

    def test_host_family_mismatch_runs_normally(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(td_path, out_dir, artifact, "--host-family", "claude")
                )
            self.assertEqual(rc, 0)

    def test_diff_mode_embeds_git_diff_output(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            repo = td_path / "repo"
            repo.mkdir()
            git_env = {
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@example.invalid",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@example.invalid",
            }

            def _git(*argv: str) -> None:
                subprocess.run(
                    ["git", *argv],
                    cwd=repo,
                    check=True,
                    capture_output=True,
                    env={**os.environ, **git_env},
                )

            _git("init", "-q")
            (repo / "f.txt").write_text("old line\n", encoding="utf-8")
            _git("add", "f.txt")
            _git("commit", "-q", "-m", "one")
            (repo / "f.txt").write_text("new marker line\n", encoding="utf-8")
            _git("add", "f.txt")
            _git("commit", "-q", "-m", "two")

            out_dir = td_path / "out"
            runner = td_path / "run_codex.sh"
            _write_stub_runner(runner)
            with _chdir(repo), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--diff",
                        "HEAD~1..HEAD",
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(out_dir),
                    ]
                )
            self.assertEqual(rc, 0)
            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            self.assertIn("=== DIFF (HEAD~1..HEAD)", packet)
            self.assertIn("+new marker line", packet)

    def test_diff_value_starting_with_dash_is_rejected(self):
        # Injection guard: a --diff value with a leading "-" would be read by
        # git as an option (e.g. --output=PATH writes a file), not a revision
        # range. It must be refused before git ever runs.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            injected = td_path / "pwned.txt"
            runner = td_path / "run_codex.sh"
            _write_stub_runner(runner)

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        f"--diff=--output={injected}",
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(out_dir),
                    ]
                )
            self.assertEqual(rc, 2)
            message = stderr.getvalue()
            self.assertIn("git option", message)
            self.assertIn("starts with '-'", message)
            # git never ran: no option-injected file, no delegation, no meta.
            self.assertFalse(injected.exists())
            self.assertFalse((out_dir / "meta.json").exists())

    def test_empty_output_retried_once_via_delegated_launcher(self):
        # review_one passes --retry-empty-output 1 explicitly (the launcher
        # default is 0): a runner that recovers on its second call must yield a
        # successful single-reviewer run with one recorded retry.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            runner = td_path / "run_codex.sh"
            _write_empty_then_valid_runner(runner, td_path / "state")

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--artifact",
                        str(artifact),
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(out_dir),
                    ]
                )
            self.assertEqual(rc, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertTrue(agent["success"])
            self.assertEqual(agent["empty_output_retries"], 1)
            events = _read_trace_events(out_dir / "trace.jsonl")
            self.assertEqual(
                len([e for e in events if e.get("event") == "empty_output_retry"]), 1
            )

    def test_project_config_suppressed_by_default_and_optable(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            project = td_path / "project"
            (project / ".git").mkdir(parents=True)
            cfg_dir = project / ".nullius"
            cfg_dir.mkdir()
            # A config that would make any run fail its prompt-size guard: only
            # loaded when --use-project-config re-enables auto-discovery.
            (cfg_dir / "review-swarm.json").write_text(
                json.dumps({"max_prompt_bytes": 10}), encoding="utf-8"
            )
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            runner = td_path / "run_codex.sh"
            _write_stub_runner(runner)

            common = [
                "--model",
                "codex/default",
                "--artifact",
                str(artifact),
                "--codex-runner",
                str(runner),
            ]
            with _temp_env(REVIEW_SWARM_NO_AUTO_CONFIG=None), _chdir(project):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    rc_default = self.mod.main([*common, "--out-dir", str(td_path / "out_default")])
                    rc_opt_in = self.mod.main(
                        [*common, "--out-dir", str(td_path / "out_optin"), "--use-project-config"]
                    )
                env_leaked = "REVIEW_SWARM_NO_AUTO_CONFIG" in os.environ
            # Default: hermetic (config ignored) -> success.
            self.assertEqual(rc_default, 0)
            # Opt-in: config's 10-byte guard applies inside the launcher -> failure.
            self.assertEqual(rc_opt_in, 2)
            # And the default run must not leave the suppression env behind.
            self.assertFalse(env_leaked)

    def test_use_project_config_overrides_inherited_suppression_env(self):
        # If the caller's environment already carries REVIEW_SWARM_NO_AUTO_CONFIG=1
        # (as this test class itself does), --use-project-config must still win:
        # the variable is removed for the delegated run and restored afterward.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            project = td_path / "project"
            (project / ".git").mkdir(parents=True)
            cfg_dir = project / ".nullius"
            cfg_dir.mkdir()
            # Only visible to the launcher when auto-discovery is truly re-enabled.
            (cfg_dir / "review-swarm.json").write_text(
                json.dumps({"max_prompt_bytes": 10}), encoding="utf-8"
            )
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            runner = td_path / "run_codex.sh"
            _write_stub_runner(runner)

            with _temp_env(REVIEW_SWARM_NO_AUTO_CONFIG="1"), _chdir(project):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    rc_opt_in = self.mod.main(
                        [
                            "--model",
                            "codex/default",
                            "--artifact",
                            str(artifact),
                            "--codex-runner",
                            str(runner),
                            "--out-dir",
                            str(td_path / "out"),
                            "--use-project-config",
                        ]
                    )
                env_after = os.environ.get("REVIEW_SWARM_NO_AUTO_CONFIG")
            # Config's 10-byte guard applied inside the launcher -> failure,
            # proving the inherited suppression was cleared for the child run.
            self.assertEqual(rc_opt_in, 2)
            # The caller's prior value is restored afterward.
            self.assertEqual(env_after, "1")


if __name__ == "__main__":
    unittest.main()
