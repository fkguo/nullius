"""Third-party agents file wiring (family -> runner -> model mapping).

Locks the contract from docs/AGENTS_FILE.md for the review-swarm launcher:
discovery order (explicit flag > project .nullius/agents.json > user
~/.nullius/agents.json > none), missing-file = pure-native (never an error),
malformed-file = input error, family:<name>[:<tier>] spec resolution, and the
independence record (participating families, level, below-minimum labeling).
The checked-in template docs/examples/agents.example.json is parsed here as the
shared fixture that keeps this parser aligned with derivation-verify's.
"""

import contextlib
import importlib.util
import json
import os
import tempfile
import unittest
import unittest.mock
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


_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEMPLATE_FIXTURE = _REPO_ROOT / "docs" / "examples" / "agents.example.json"
# In-repo runs must FAIL (not skip) when the shared fixture is missing — the fixture is
# the anti-drift anchor keeping both self-contained parsers aligned. Only a standalone
# skill install may skip. The marker must be repo-specific: a plain AGENTS.md also exists
# in agent host homes (e.g. a skills dir copied under a host config root), so use the
# checked-in ecosystem contract that only this repository carries.
_IN_REPO = (_REPO_ROOT / "meta" / "ECOSYSTEM_DEV_CONTRACT.md").is_file()


def _write_stub_runner_records_model(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

out=""
model=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub runner missing --out" >&2
  exit 2
fi

printf 'MODEL=%s\\n' "${model}" > "${out}"
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


@contextlib.contextmanager
def _temp_env(**updates):
    """Set (value) or remove (None) environment variables for the duration."""
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
def _temp_chdir(path: Path):
    old = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)


def _run_main_with_argv(mod, argv: list[str]) -> int:
    import sys as _sys

    old_argv = _sys.argv
    try:
        _sys.argv = argv
        return mod.main()
    finally:
        _sys.argv = old_argv


def _roster(families: dict, policy: dict | None = None) -> dict:
    roster: dict = {"version": 1, "families": families}
    if policy is not None:
        roster["policy"] = policy
    return roster


_FULL_FAMILIES = {
    "gpt": {"runner": "codex", "models": {"default": "gpt-x-default", "strong": "gpt-x-strong"}},
    "glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}},
    "kimi": {"runner": "kimi", "models": {"default": "kimi-alias"}},
    "clc": {"runner": "claude-cli", "models": {"default": "claude-tier"}},
    "gem": {"runner": "gemini", "available": False, "notes": "no local access"},
    "host": {"runner": "native", "models": {"default": "fable"}},
}


class AgentsFileUnitTests(unittest.TestCase):
    """Pure-function coverage: validation, family-spec resolution, attribution."""

    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()

    def test_validate_rejects_malformed_shapes(self):
        cases = [
            [],  # root not an object
            {"version": 2, "families": {}},
            {"version": 1},  # families missing
            {"version": 1, "families": []},
            {"version": 1, "families": {"x": {"runner": "warp"}}},  # unknown runner
            {"version": 1, "families": {"x": {"runner": "codex", "models": []}}},
            {"version": 1, "families": {"x": {"runner": "codex", "models": {"default": ""}}}},
            {"version": 1, "families": {"x": {"runner": "codex", "available": "yes"}}},
            {"version": 1, "families": {"x": {"runner": "codex", "notes": ["not", "a", "string"]}}},
            {"version": 1, "families": {"GPT": {"runner": "codex"}}},  # family names must be lowercase
            {"version": 1.0, "families": {}},  # float version: 1.0 == 1 must NOT slip through
            {"version": "1", "families": {}},
            {"version": 1, "families": {}, "policy": None},  # explicit null policy is malformed
            {"version": 1, "families": {}, "policy": {"cross_family_minimum": 0}},
            {"version": 1, "families": {}, "policy": {"cross_family_minimum": True}},
            {"version": 1, "families": {}, "policy": {"when_below_minimum": 7}},
            {"version": 1, "families": {}, "policy": {"when_below_minimum": " "}},
            {"version": 1, "families": {}, "policy": {"when_below_minimum": "shrug"}},  # v1 enum
            # One dedicated (non-opencode) runner cannot serve two families.
            {"version": 1, "families": {
                "a": {"runner": "codex", "models": {"default": "m1"}},
                "b": {"runner": "codex", "models": {"default": "m2"}},
            }},
            # One (runner, model string) cannot belong to two families.
            {"version": 1, "families": {
                "a": {"runner": "opencode", "models": {"default": "zed/m"}},
                "b": {"runner": "opencode", "models": {"default": "zed/m"}},
            }},
        ]
        for obj in cases:
            with self.assertRaises(ValueError, msg=repr(obj)):
                self.mod._validate_agents_roster(obj, source="test")

    def test_validate_allows_opencode_gateway_families_and_native_beside_cli(self):
        # opencode is a multi-provider gateway: several families may share it as long
        # as their model strings differ. A native family never occupies a CLI runner.
        roster = {
            "version": 1,
            "families": {
                "glm": {"runner": "opencode", "models": {"default": "zed/one"}},
                "qwen": {"runner": "opencode", "models": {"default": "qwen-cp/two"}},
                "claude": {"runner": "native", "models": {"default": "opus"}},
                "clc": {"runner": "claude-cli", "models": {"default": "opus"}},
            },
        }
        self.assertIs(self.mod._validate_agents_roster(roster, source="test"), roster)

    def test_validate_accepts_unknown_keys_and_empty_policy(self):
        roster = {
            "version": 1,
            "_notes": ["ignored"],
            "families": {"gpt": {"runner": "codex", "models": {"default": "m"}, "extra": 1}},
        }
        self.assertIs(self.mod._validate_agents_roster(roster, source="test"), roster)

    def test_resolve_family_spec_maps_each_runner(self):
        roster = _roster(_FULL_FAMILIES)
        resolve = self.mod._resolve_family_spec
        with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
            self.assertEqual(resolve("family:gpt", roster), "codex/gpt-x-default")
            self.assertEqual(resolve("family:gpt:strong", roster), "codex/gpt-x-strong")
            # OpenCode model strings already carry provider/model; no backend prefix added.
            self.assertEqual(resolve("family:glm", roster), "zed/glm-z")
            self.assertEqual(resolve("family:kimi", roster), "kimi/kimi-alias")
            self.assertEqual(resolve("family:clc", roster), "claude/claude-tier")
            # Family names are lowercase by schema; the request side normalizes the same way.
            self.assertEqual(resolve("family:GPT", roster), "codex/gpt-x-default")

    def test_resolve_family_spec_errors(self):
        roster = _roster(_FULL_FAMILIES)
        resolve = self.mod._resolve_family_spec
        with self.assertRaisesRegex(ValueError, "needs an agents file"):
            resolve("family:gpt", None)
        with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
            with self.assertRaisesRegex(ValueError, "no family"):
                resolve("family:nope", roster)
            with self.assertRaisesRegex(ValueError, "no model tier"):
                resolve("family:gpt:turbo", roster)
            with self.assertRaisesRegex(ValueError, "declared unavailable"):
                resolve("family:gem", roster)
            with self.assertRaisesRegex(ValueError, "native"):
                resolve("family:host", roster)
            with self.assertRaisesRegex(ValueError, "empty family spec"):
                resolve("family:", roster)

    def test_resolve_family_spec_requires_runner_executable(self):
        roster = _roster(_FULL_FAMILIES)
        with unittest.mock.patch.object(
            self.mod, "_agents_runner_available", lambda runner: runner != "codex"
        ):
            with self.assertRaisesRegex(ValueError, "honestly absent"):
                self.mod._resolve_family_spec("family:gpt", roster)
            # Other runners are unaffected by one missing executable.
            self.assertEqual(self.mod._resolve_family_spec("family:glm", roster), "zed/glm-z")

    def test_resolve_family_spec_rejects_reserved_opencode_prefix(self):
        # An opencode model string starting with a reserved launcher prefix would be
        # re-routed by _classify_model to a DIFFERENT runner than the file declares.
        with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
            for bad_model in ("codex/foo", "claude/foo", "gemini/foo", "kimi/foo", "family:x"):
                roster = _roster({"bad": {"runner": "opencode", "models": {"default": bad_model}}})
                with self.assertRaisesRegex(ValueError, "reserved launcher prefix", msg=bad_model):
                    self.mod._resolve_family_spec("family:bad", roster)

    def test_roster_family_attribution(self):
        roster = _roster(_FULL_FAMILIES)
        fam = self.mod._roster_family
        # No roster: the backend name is the family label (pre-agents-file behavior).
        self.assertEqual(fam("codex", "codex/gpt-x-strong", None), "codex")
        # Exact tier match, with and without the backend/ prefix on the model string.
        self.assertEqual(fam("codex", "codex/gpt-x-strong", roster), "gpt")
        self.assertEqual(fam("codex", "gpt-x-default", roster), "gpt")
        # A runner used by exactly one declared family maps to that family even for
        # a model string the file does not list.
        self.assertEqual(fam("codex", "codex/gpt-99-unknown", roster), "gpt")
        self.assertEqual(fam("claude", "claude/other", roster), "clc")
        # OpenCode: exact match, then provider-prefix match, else the backend name.
        self.assertEqual(fam("opencode", "zed/glm-z", roster), "glm")
        self.assertEqual(fam("opencode", "zed/glm-next", roster), "glm")
        self.assertEqual(fam("opencode", "minimax/M", roster), "opencode")
        self.assertEqual(fam("opencode", "default", roster), "opencode")

    def test_roster_family_ambiguous_provider_falls_back(self):
        roster = _roster(
            {
                "glm-a": {"runner": "opencode", "models": {"default": "zed/one"}},
                "glm-b": {"runner": "opencode", "models": {"default": "zed/two"}},
            }
        )
        # Exact tier match still attributes; a provider shared by two families cannot.
        self.assertEqual(self.mod._roster_family("opencode", "zed/one", roster), "glm-a")
        self.assertEqual(self.mod._roster_family("opencode", "zed/three", roster), "opencode")

    def test_usable_families_and_independence_labels(self):
        roster = _roster(_FULL_FAMILIES, policy={"cross_family_minimum": 3, "when_below_minimum": "native_subagents"})
        with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
            usable = self.mod._usable_families(roster)
            self.assertEqual(usable, ["clc", "glm", "gpt", "host", "kimi"])  # gem declared unavailable

            results = [
                {"success": True, "resolved": {"backend": "codex", "model": "codex/gpt-x-strong"}},
                {"success": True, "resolved": {"backend": "opencode", "model": "zed/glm-z"}},
                {"success": False, "resolved": {"backend": "kimi", "model": "kimi/kimi-alias"}},
            ]
            info = self.mod._independence_summary(results, roster)
        self.assertEqual(info["level"], "cross_family")
        self.assertEqual(info["participating_families"], ["glm", "gpt"])
        self.assertEqual(info["declared_available_families"], ["clc", "glm", "gpt", "host", "kimi"])
        self.assertEqual(info["absent_families"], ["clc", "gem", "host", "kimi"])
        self.assertEqual(info["cross_family_minimum"], 3)
        self.assertFalse(info["below_minimum"])
        self.assertEqual(info["when_below_minimum"], "native_subagents")

    def test_independence_below_minimum_and_levels(self):
        roster = _roster(
            {"glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}}},
            policy={"cross_family_minimum": 3},
        )
        with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
            one = self.mod._independence_summary(
                [{"success": True, "resolved": {"backend": "opencode", "model": "zed/glm-z"}}], roster
            )
            none = self.mod._independence_summary(
                [{"success": False, "resolved": {"backend": "opencode", "model": "zed/glm-z"}}], roster
            )
        self.assertEqual(one["level"], "single_family")
        self.assertTrue(one["below_minimum"])
        self.assertEqual(one["when_below_minimum"], "native_subagents")
        self.assertEqual(none["level"], "none")
        self.assertEqual(none["participating_families"], [])

    def test_independence_without_roster_nulls_declaration_fields(self):
        # The field set is identical on every path; without an agents file the
        # declaration-relative fields are null ("nothing was declared"), never
        # an empty list ("everything declared participated").
        info = self.mod._independence_summary(
            [{"success": True, "resolved": {"backend": "codex", "model": "codex/x"}}], None
        )
        self.assertEqual(
            info,
            {
                "level": "single_family",
                "participating_families": ["codex"],
                "declared_available_families": None,
                "absent_families": None,
                "cross_family_minimum": None,
                "below_minimum": None,
                "when_below_minimum": None,
            },
        )

    def test_find_agents_file_discovery_order(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td).resolve()
            home = td_path / "home"
            (home / ".nullius").mkdir(parents=True)
            user_file = home / ".nullius" / "agents.json"
            user_file.write_text(json.dumps(_roster({})), encoding="utf-8")

            project = td_path / "proj"
            (project / ".git").mkdir(parents=True)
            nested = project / "deep" / "inside"
            nested.mkdir(parents=True)

            with _temp_env(HOME=str(home), REVIEW_SWARM_NO_AUTO_CONFIG=None):
                # No project-level file: the git-root walk stops at the project and
                # falls through to the user level.
                found, source = self.mod._find_agents_file(start=nested)
                self.assertEqual((found, source), (user_file, "user"))

                (project / ".nullius").mkdir()
                project_file = project / ".nullius" / "agents.json"
                project_file.write_text(json.dumps(_roster({})), encoding="utf-8")
                found, source = self.mod._find_agents_file(start=nested)
                self.assertEqual((found, source), (project_file, "project"))

            with _temp_env(HOME=str(home), REVIEW_SWARM_NO_AUTO_CONFIG="1"):
                self.assertEqual(self.mod._find_agents_file(start=nested), (None, "none"))

    def test_template_fixture_parses_and_resolves(self):
        if not _TEMPLATE_FIXTURE.is_file():
            if _IN_REPO:
                self.fail(f"in-repo run but the shared template fixture is missing: {_TEMPLATE_FIXTURE}")
            self.skipTest(f"standalone skill install: template fixture not present: {_TEMPLATE_FIXTURE}")
        roster, source, path = self.mod._load_agents_file(str(_TEMPLATE_FIXTURE))
        self.assertEqual(source, "explicit")
        self.assertEqual(path, _TEMPLATE_FIXTURE)
        self.assertEqual(
            sorted(roster["families"]), ["claude", "gemini", "glm", "gpt", "kimi"]
        )
        self.assertEqual(roster["policy"]["cross_family_minimum"], 3)
        self.assertEqual(roster["policy"]["when_below_minimum"], "native_subagents")
        resolve = self.mod._resolve_family_spec
        with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
            self.assertEqual(resolve("family:gpt", roster), "codex/gpt-5.6-terra")
            self.assertEqual(resolve("family:gpt:strong", roster), "codex/gpt-5.6-sol")
            self.assertEqual(resolve("family:glm", roster), "zhipuai-coding-plan/glm-5.2")
            self.assertEqual(resolve("family:kimi", roster), "kimi/kimi-code/kimi-for-coding")
            with self.assertRaisesRegex(ValueError, "native"):
                resolve("family:claude", roster)
            with self.assertRaisesRegex(ValueError, "declared unavailable"):
                resolve("family:gemini", roster)


class AgentsFileEndToEndTests(unittest.TestCase):
    """main() coverage: discovery precedence, meta/trace records, stub runners."""

    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()
        # Hermetic by default; discovery tests re-enable auto-discovery explicitly.
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)

    def _base_argv(self, td_path: Path, *, models: str, runner_flags: dict[str, Path]) -> tuple[list[str], Path]:
        out_dir = td_path / "out"
        sys_prompt = td_path / "system.md"
        user_prompt = td_path / "prompt.md"
        sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
        user_prompt.write_text("USER\n", encoding="utf-8")
        argv = [
            "run_multi_task.py",
            "--out-dir", str(out_dir),
            "--system", str(sys_prompt),
            "--prompt", str(user_prompt),
            "--models", models,
        ]
        for flag, path in runner_flags.items():
            argv.extend([flag, str(path)])
        return argv, out_dir

    def _stub(self, td_path: Path, name: str) -> Path:
        runner = td_path / name
        _write_stub_runner_records_model(runner)
        return runner

    def _read_meta(self, out_dir: Path) -> dict:
        return json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))

    def test_missing_file_is_pure_native_end_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            argv, out_dir = self._base_argv(
                td_path,
                models="zed/anything",
                runner_flags={"--opencode-runner": self._stub(td_path, "run_opencode.sh")},
            )
            rc = _run_main_with_argv(self.mod, argv)
            self.assertEqual(rc, 0)
            meta = self._read_meta(out_dir)
            self.assertEqual(meta["agents_file"], {"path": None, "source": "none"})
            info = meta["independence"]
            self.assertEqual(info["level"], "single_family")
            self.assertEqual(info["participating_families"], ["opencode"])
            for field in (
                "declared_available_families",
                "absent_families",
                "cross_family_minimum",
                "below_minimum",
                "when_below_minimum",
            ):
                self.assertIsNone(info[field], field)
            self.assertNotIn("family_spec", meta["agents"][0])

    def test_family_spec_without_agents_file_is_input_error(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            argv, out_dir = self._base_argv(
                td_path,
                models="family:gpt",
                runner_flags={"--codex-runner": self._stub(td_path, "run_codex.sh")},
            )
            rc = _run_main_with_argv(self.mod, argv)
            self.assertEqual(rc, 2)
            meta = self._read_meta(out_dir)
            self.assertEqual(meta["status"], "input_error")
            self.assertIn("needs an agents file", meta["error"])
            # A rejected input still records the agents-file context and an
            # independence block (no agents ran: level none, null declarations),
            # handing the calling skill its degradation signal from the meta alone.
            self.assertEqual(meta["agents_file"], {"path": None, "source": "none"})
            self.assertEqual(meta["independence"]["level"], "none")
            self.assertIsNone(meta["independence"]["below_minimum"])

    def test_malformed_agents_file_is_input_error(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            bad = td_path / "agents.json"
            bad.write_text("{not json", encoding="utf-8")
            argv, out_dir = self._base_argv(
                td_path,
                models="zed/anything",
                runner_flags={"--opencode-runner": self._stub(td_path, "run_opencode.sh")},
            )
            argv.extend(["--agents-file", str(bad)])
            rc = _run_main_with_argv(self.mod, argv)
            self.assertEqual(rc, 2)
            self.assertEqual(self._read_meta(out_dir)["status"], "input_error")

            bad.write_text(json.dumps({"version": 99, "families": {}}), encoding="utf-8")
            rc = _run_main_with_argv(self.mod, argv)
            self.assertEqual(rc, 2)
            meta = self._read_meta(out_dir)
            self.assertEqual(meta["status"], "input_error")
            self.assertIn("unsupported agents file version", meta["error"])

    def test_family_specs_resolve_and_meta_records_independence(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            agents = td_path / "agents.json"
            agents.write_text(
                json.dumps(_roster(_FULL_FAMILIES, policy={"cross_family_minimum": 3})),
                encoding="utf-8",
            )
            argv, out_dir = self._base_argv(
                td_path,
                models="family:gpt:strong,family:glm,family:kimi,family:clc",
                runner_flags={
                    "--codex-runner": self._stub(td_path, "run_codex.sh"),
                    "--opencode-runner": self._stub(td_path, "run_opencode.sh"),
                    "--kimi-runner": self._stub(td_path, "run_kimi.sh"),
                    "--claude-runner": self._stub(td_path, "run_claude.sh"),
                },
            )
            argv.extend(["--agents-file", str(agents)])
            with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
                rc = _run_main_with_argv(self.mod, argv)
            self.assertEqual(rc, 0)
            meta = self._read_meta(out_dir)

            self.assertEqual(meta["agents_file"]["source"], "explicit")
            self.assertEqual(
                meta["models"],
                ["codex/gpt-x-strong", "zed/glm-z", "kimi/kimi-alias", "claude/claude-tier"],
            )
            by_index = {a["index"]: a for a in meta["agents"]}
            self.assertEqual(by_index[0]["family_spec"], "family:gpt:strong")
            self.assertEqual(by_index[1]["family_spec"], "family:glm")
            self.assertEqual(
                Path(by_index[0]["out"]).read_text(encoding="utf-8").strip(),
                "MODEL=gpt-x-strong",
            )
            self.assertEqual(
                Path(by_index[1]["out"]).read_text(encoding="utf-8").strip(),
                "MODEL=zed/glm-z",
            )
            self.assertEqual(
                Path(by_index[2]["out"]).read_text(encoding="utf-8").strip(),
                "MODEL=kimi-alias",
            )
            self.assertEqual(
                Path(by_index[3]["out"]).read_text(encoding="utf-8").strip(),
                "MODEL=claude-tier",
            )

            info = meta["independence"]
            self.assertEqual(info["level"], "cross_family")
            self.assertEqual(info["participating_families"], ["clc", "glm", "gpt", "kimi"])
            self.assertEqual(info["absent_families"], ["gem", "host"])
            self.assertFalse(info["below_minimum"])
            self.assertEqual(info["when_below_minimum"], "native_subagents")

    def test_below_minimum_run_is_labeled_degraded(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            agents = td_path / "agents.json"
            agents.write_text(
                json.dumps(
                    _roster(
                        {"glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}}},
                        policy={"cross_family_minimum": 3},
                    )
                ),
                encoding="utf-8",
            )
            argv, out_dir = self._base_argv(
                td_path,
                models="family:glm",
                runner_flags={"--opencode-runner": self._stub(td_path, "run_opencode.sh")},
            )
            argv.extend(["--agents-file", str(agents)])
            with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
                rc = _run_main_with_argv(self.mod, argv)
            self.assertEqual(rc, 0)
            info = self._read_meta(out_dir)["independence"]
            self.assertEqual(info["level"], "single_family")
            self.assertEqual(info["participating_families"], ["glm"])
            self.assertTrue(info["below_minimum"])
            self.assertEqual(info["when_below_minimum"], "native_subagents")

    def test_family_spec_agent_never_falls_back(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            agents = td_path / "agents.json"
            agents.write_text(
                json.dumps(_roster({"glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}}})),
                encoding="utf-8",
            )
            failing = td_path / "run_opencode.sh"
            failing.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
            failing.chmod(0o755)
            codex_stub = self._stub(td_path, "run_codex.sh")
            argv, out_dir = self._base_argv(
                td_path,
                models="family:glm",
                runner_flags={"--opencode-runner": failing, "--codex-runner": codex_stub},
            )
            argv.extend(
                [
                    "--agents-file", str(agents),
                    "--fallback-mode", "auto",
                    "--fallback-order", "codex",
                    "--fallback-target-backends", "opencode",
                ]
            )
            with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
                rc = _run_main_with_argv(self.mod, argv)
            # The failed family-spec agent is NOT replaced by another backend.
            self.assertEqual(rc, 2)
            meta = self._read_meta(out_dir)
            agent = meta["agents"][0]
            self.assertEqual(agent["variant"], "canonical")
            self.assertEqual(agent["resolved"]["backend"], "opencode")
            self.assertFalse(agent["success"])
            trace = (out_dir / "trace.jsonl").read_text(encoding="utf-8")
            self.assertIn("fallback_skipped_family_spec", trace)
            self.assertEqual(meta["independence"]["level"], "none")

    def test_explicit_spec_fallback_still_works_with_agents_file(self):
        # The family-spec fallback exclusion must not leak onto explicit model specs.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            agents = td_path / "agents.json"
            agents.write_text(
                json.dumps(_roster({"glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}}})),
                encoding="utf-8",
            )
            failing = td_path / "run_opencode.sh"
            failing.write_text("#!/usr/bin/env bash\nexit 1\n", encoding="utf-8")
            failing.chmod(0o755)
            codex_stub = self._stub(td_path, "run_codex.sh")
            argv, out_dir = self._base_argv(
                td_path,
                models="zed/glm-z",
                runner_flags={"--opencode-runner": failing, "--codex-runner": codex_stub},
            )
            argv.extend(
                [
                    "--agents-file", str(agents),
                    "--fallback-mode", "auto",
                    "--fallback-order", "codex",
                    "--fallback-target-backends", "opencode",
                ]
            )
            with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
                rc = _run_main_with_argv(self.mod, argv)
            self.assertEqual(rc, 0)
            agent = self._read_meta(out_dir)["agents"][0]
            self.assertEqual(agent["variant"], "fallback")
            self.assertEqual(agent["resolved"]["backend"], "codex")
            self.assertTrue(agent["success"])

    def test_discovery_precedence_project_over_user_and_explicit_over_both(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td).resolve()
            home = td_path / "home"
            (home / ".nullius").mkdir(parents=True)
            (home / ".nullius" / "agents.json").write_text(
                json.dumps(_roster({"glm": {"runner": "opencode", "models": {"default": "user/model"}}})),
                encoding="utf-8",
            )
            project = td_path / "proj"
            (project / ".git").mkdir(parents=True)
            (project / ".nullius").mkdir()
            (project / ".nullius" / "agents.json").write_text(
                json.dumps(_roster({"glm": {"runner": "opencode", "models": {"default": "proj/model"}}})),
                encoding="utf-8",
            )
            explicit = td_path / "explicit.json"
            explicit.write_text(
                json.dumps(_roster({"glm": {"runner": "opencode", "models": {"default": "explicit/model"}}})),
                encoding="utf-8",
            )

            def run(models: str, *, extra: list[str] = [], workdir: Path = project) -> dict:
                work = td_path / "work"
                if work.exists():
                    import shutil as _shutil

                    _shutil.rmtree(work)
                work.mkdir()
                argv, out_dir = self._base_argv(
                    work,
                    models=models,
                    runner_flags={"--opencode-runner": self._stub(work, "run_opencode.sh")},
                )
                argv.extend(extra)
                with _temp_chdir(workdir):
                    with unittest.mock.patch.object(self.mod, "_agents_runner_available", lambda runner: True):
                        rc = _run_main_with_argv(self.mod, argv)
                self.assertEqual(rc, 0)
                return self._read_meta(out_dir)

            with _temp_env(HOME=str(home), REVIEW_SWARM_NO_AUTO_CONFIG=None):
                # Project level wins over user level.
                meta = run("family:glm")
                self.assertEqual(meta["agents_file"]["source"], "project")
                self.assertEqual(meta["models"], ["proj/model"])

                # User level applies when no project file exists on the git-root walk.
                outside = td_path / "outside"
                outside.mkdir()
                meta = run("family:glm", workdir=outside)
                self.assertEqual(meta["agents_file"]["source"], "user")
                self.assertEqual(meta["models"], ["user/model"])

                # An explicit flag beats both discovery levels.
                meta = run("family:glm", extra=["--agents-file", str(explicit)])
                self.assertEqual(meta["agents_file"]["source"], "explicit")
                self.assertEqual(meta["models"], ["explicit/model"])

            with _temp_env(HOME=str(home), REVIEW_SWARM_NO_AUTO_CONFIG="1"):
                # The hermetic switch disables discovery only; explicit still works.
                meta = run("zed/anything")
                self.assertEqual(meta["agents_file"], {"path": None, "source": "none"})
                meta = run("family:glm", extra=["--agents-file", str(explicit)])
                self.assertEqual(meta["agents_file"]["source"], "explicit")
                self.assertEqual(meta["models"], ["explicit/model"])


if __name__ == "__main__":
    unittest.main()
