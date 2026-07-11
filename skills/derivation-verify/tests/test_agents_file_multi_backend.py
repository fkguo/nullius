#!/usr/bin/env python3
"""Third-party agents file wiring for derivation-verify Executor 2.

Locks the contract from docs/AGENTS_FILE.md for the gate: discovery order
(explicit flag > project .nullius/agents.json > user ~/.nullius/agents.json >
none), missing-file = pure-native (never an error), malformed-file = input
error, family:<name>[:<tier>] spec resolution, roster-aware family identity
(cross-family counting + diversity tie-break), and the independence record in
the summary. The checked-in template docs/examples/agents.example.json is
parsed here as the shared fixture that keeps this parser aligned with
review-swarm's.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_MOD_PATH = Path(__file__).resolve().parents[1] / "scripts" / "run_multi_backend.py"
_spec = importlib.util.spec_from_file_location("run_multi_backend_agents", _MOD_PATH)
mb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mb)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEMPLATE_FIXTURE = _REPO_ROOT / "docs" / "examples" / "agents.example.json"
# In-repo runs must FAIL (not skip) when the shared fixture is missing — the fixture is
# the anti-drift anchor keeping both self-contained parsers aligned. Only a standalone
# skill install may skip. The marker must be repo-specific: a plain AGENTS.md also exists
# in agent host homes (e.g. a skills dir copied under a host config root), so use the
# checked-in ecosystem contract that only this repository carries.
_IN_REPO = (_REPO_ROOT / "meta" / "ECOSYSTEM_DEV_CONTRACT.md").is_file()

ROSTER = {
    "version": 1,
    "families": {
        "gpt": {"runner": "codex", "models": {"default": "gpt-x-default", "strong": "gpt-x-strong"}},
        "glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}},
        "kimi": {"runner": "kimi", "models": {"default": "kimi-alias"}},
        "gem": {"runner": "gemini", "available": False, "notes": "no local access"},
        "host": {"runner": "native", "models": {"default": "fable"}},
    },
    "policy": {"cross_family_minimum": 3, "when_below_minimum": "native_subagents"},
}


@pytest.fixture(autouse=True)
def _reset_roster():
    """The roster is module-level state; every test leaves the module pure-native."""
    yield
    mb.set_agents_roster(None)


# ---------------------------------------------------------------- validation
def test_validate_rejects_malformed_shapes():
    bad = [
        [],
        {"version": 2, "families": {}},
        {"version": 1},
        {"version": 1, "families": []},
        {"version": 1, "families": {"x": {"runner": "warp"}}},
        {"version": 1, "families": {"x": {"runner": "codex", "models": {"default": ""}}}},
        {"version": 1, "families": {"x": {"runner": "codex", "available": "yes"}}},
        {"version": 1, "families": {"x": {"runner": "codex", "notes": ["nope"]}}},
        {"version": 1, "families": {"GPT": {"runner": "codex"}}},  # family names must be lowercase
        {"version": 1.0, "families": {}},  # float version: 1.0 == 1 must NOT slip through
        {"version": "1", "families": {}},
        {"version": 1, "families": {}, "policy": None},  # explicit null policy is malformed
        {"version": 1, "families": {}, "policy": {"cross_family_minimum": 0}},
        {"version": 1, "families": {}, "policy": {"when_below_minimum": 7}},
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
    for obj in bad:
        with pytest.raises(ValueError):
            mb.validate_agents_roster(obj, source="test")


def test_validate_allows_opencode_gateway_families():
    # opencode is a multi-provider gateway: several families may share it as long as
    # their model strings differ; a native family never occupies a CLI runner.
    roster = {
        "version": 1,
        "families": {
            "glm": {"runner": "opencode", "models": {"default": "zed/one"}},
            "qwen": {"runner": "opencode", "models": {"default": "qwen-cp/two"}},
            "claude": {"runner": "native", "models": {"default": "opus"}},
        },
    }
    assert mb.validate_agents_roster(roster, source="test") is roster


def test_validate_rejects_unknown_keys_at_every_level():
    # Unknown-key handling is a cross-parser contract (docs/AGENTS_FILE.md): a
    # misspelled field name (modle, availble) must be a parse error, never a
    # field silently treated as absent. All three self-contained parsers
    # (this one, review-swarm's, idea-pairwise-match's) reject the same files.
    bad = [
        {"version": 1, "families": {}, "extra": 1},
        {"version": 1, "families": {"gpt": {"runner": "codex", "modle": {"default": "m"}}}},
        {"version": 1, "families": {"gpt": {"runner": "codex", "models": {"default": "m"}, "availble": False}}},
        {"version": 1, "families": {}, "policy": {"cross_family_minimum": 3, "extra": 1}},
        # "_notes" is legal at the TOP level only; below it, it is an unknown key.
        {"version": 1, "families": {"gpt": {"runner": "codex", "models": {"default": "m"}, "_notes": "x"}}},
        {"version": 1, "families": {}, "policy": {"cross_family_minimum": 3, "_notes": "x"}},
    ]
    for obj in bad:
        with pytest.raises(ValueError, match="unknown"):
            mb.validate_agents_roster(obj, source="test")


def test_validate_accepts_top_level_notes():
    # "_notes" is the one sanctioned comment carrier: top level only, any JSON value.
    for notes in (["ok"], "ok", {"k": "v"}, 7):
        roster = {"version": 1, "_notes": notes, "families": {"gpt": {"runner": "codex"}}}
        assert mb.validate_agents_roster(roster, source="test") is roster


# ---------------------------------------------------------------- discovery order
def test_find_agents_file_project_then_user_then_none(tmp_path, monkeypatch):
    monkeypatch.delenv("DERIVATION_VERIFY_NO_AUTO_CONFIG", raising=False)
    home = tmp_path / "home"
    (home / ".nullius").mkdir(parents=True)
    user_file = home / ".nullius" / "agents.json"
    user_file.write_text(json.dumps({"version": 1, "families": {}}), encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))

    project = tmp_path / "proj"
    nested = project / "deep"
    (project / ".git").mkdir(parents=True)
    nested.mkdir()

    # Git root found but no project file -> user level.
    assert mb.find_agents_file(start=nested) == (user_file, "user")

    (project / ".nullius").mkdir()
    project_file = project / ".nullius" / "agents.json"
    project_file.write_text(json.dumps({"version": 1, "families": {}}), encoding="utf-8")
    assert mb.find_agents_file(start=nested) == (project_file, "project")

    # The hermetic switch disables auto-discovery entirely.
    monkeypatch.setenv("DERIVATION_VERIFY_NO_AUTO_CONFIG", "1")
    assert mb.find_agents_file(start=nested) == (None, "none")


def test_load_agents_file_missing_is_pure_native(monkeypatch):
    monkeypatch.setenv("DERIVATION_VERIFY_NO_AUTO_CONFIG", "1")
    assert mb.load_agents_file(None) == (None, "none", None)


def test_load_agents_file_explicit_beats_discovery(tmp_path, monkeypatch):
    monkeypatch.delenv("DERIVATION_VERIFY_NO_AUTO_CONFIG", raising=False)
    home = tmp_path / "home"
    (home / ".nullius").mkdir(parents=True)
    (home / ".nullius" / "agents.json").write_text(
        json.dumps({"version": 1, "families": {"glm": {"runner": "opencode", "models": {"default": "user/m"}}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(home))
    explicit = tmp_path / "explicit.json"
    explicit.write_text(
        json.dumps({"version": 1, "families": {"glm": {"runner": "opencode", "models": {"default": "explicit/m"}}}}),
        encoding="utf-8",
    )
    roster, source, path = mb.load_agents_file(str(explicit))
    assert source == "explicit" and path == explicit
    assert roster["families"]["glm"]["models"]["default"] == "explicit/m"
    # Explicit paths still work when auto-discovery is disabled.
    monkeypatch.setenv("DERIVATION_VERIFY_NO_AUTO_CONFIG", "1")
    assert mb.load_agents_file(str(explicit))[1] == "explicit"


def test_load_agents_file_errors(tmp_path, monkeypatch):
    monkeypatch.setenv("DERIVATION_VERIFY_NO_AUTO_CONFIG", "1")
    with pytest.raises(FileNotFoundError):
        mb.load_agents_file(str(tmp_path / "nope.json"))
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        mb.load_agents_file(str(bad))
    bad.write_text(json.dumps({"version": 7, "families": {}}), encoding="utf-8")
    with pytest.raises(ValueError):
        mb.load_agents_file(str(bad))


# ---------------------------------------------------------------- family spec resolution
def test_resolve_family_spec_maps_runners_and_tiers(monkeypatch):
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    assert mb.resolve_family_spec("family:gpt", ROSTER) == "codex/gpt-x-default"
    assert mb.resolve_family_spec("family:gpt:strong", ROSTER) == "codex/gpt-x-strong"
    assert mb.resolve_family_spec("family:glm", ROSTER) == "zed/glm-z"
    assert mb.resolve_family_spec("family:kimi", ROSTER) == "kimi/kimi-alias"
    # Family names are lowercase by schema; the request side normalizes the same way.
    assert mb.resolve_family_spec("family:GPT", ROSTER) == "codex/gpt-x-default"


def test_resolve_family_spec_errors(monkeypatch):
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    with pytest.raises(ValueError, match="needs an agents file"):
        mb.resolve_family_spec("family:gpt", None)
    with pytest.raises(ValueError, match="no family"):
        mb.resolve_family_spec("family:nope", ROSTER)
    with pytest.raises(ValueError, match="no model tier"):
        mb.resolve_family_spec("family:gpt:turbo", ROSTER)
    with pytest.raises(ValueError, match="declared unavailable"):
        mb.resolve_family_spec("family:gem", ROSTER)
    with pytest.raises(ValueError, match="native_derivations"):
        mb.resolve_family_spec("family:host", ROSTER)


def test_resolve_family_spec_requires_runner_executable(monkeypatch):
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: runner != "codex")
    with pytest.raises(ValueError, match="honestly absent"):
        mb.resolve_family_spec("family:gpt", ROSTER)
    assert mb.resolve_family_spec("family:glm", ROSTER) == "zed/glm-z"


def test_resolve_family_spec_rejects_reserved_opencode_prefix(monkeypatch):
    # An opencode model string starting with a reserved launcher prefix would be
    # re-routed by the spec classifier to a DIFFERENT runner than the file declares.
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    for bad_model in ("codex/foo", "claude/foo", "gemini/foo", "kimi/foo", "family:x"):
        roster = {"version": 1, "families": {"bad": {"runner": "opencode", "models": {"default": bad_model}}}}
        with pytest.raises(ValueError, match="reserved launcher prefix"):
            mb.resolve_family_spec("family:bad", roster)


# ---------------------------------------------------------------- roster-aware family identity
def test_roster_family_of_without_roster_is_family_of():
    assert mb.roster_family_of("codex/gpt-x-strong") == "codex"
    assert mb.roster_family_of("zed/glm-z") == "opencode"


def test_roster_family_of_with_roster():
    mb.set_agents_roster(ROSTER)
    assert mb.roster_family_of("codex/gpt-x-strong") == "gpt"    # exact tier match
    assert mb.roster_family_of("codex/gpt-99-unknown") == "gpt"  # sole family on this runner
    assert mb.roster_family_of("zed/glm-z") == "glm"             # opencode exact match
    assert mb.roster_family_of("zed/glm-next") == "glm"          # opencode provider prefix
    assert mb.roster_family_of("minimax/M") == "opencode"        # unattributed keeps backend label
    assert mb.roster_family_of("kimi/kimi-alias") == "kimi"
    # The launcher-backend routing must stay in the backend namespace regardless.
    assert mb.family_of("codex/gpt-x-strong") == "codex"


def test_normalize_family_keeps_roster_names():
    assert mb.normalize_family("gpt") == "opencode"  # unknown bare tag folds (pre-roster behavior)
    mb.set_agents_roster(ROSTER)
    assert mb.normalize_family("gpt") == "gpt"       # declared family name kept verbatim
    assert mb.normalize_family("claude") == "claude"
    assert mb.normalize_family("zed/glm-z") == "glm"


def test_normalize_family_maps_backend_alias_into_roster_namespace():
    """A host tagging itself with a backend alias ('codex') and a CLI derivation the
    roster attributes to 'gpt' are ONE physical family; the alias must land in the
    same namespace or the gate would count one family twice."""
    mb.set_agents_roster(ROSTER)
    assert mb.normalize_family("codex") == "gpt"
    assert mb.normalize_family("Codex/default") == "gpt"
    assert mb.normalize_family("kimi") == "kimi"       # roster family name and alias coincide
    assert mb.normalize_family("claude") == "claude"   # no claude-cli family declared -> unchanged
    assert mb.normalize_family("opencode") == "opencode"


def test_native_backend_alias_cannot_fake_cross_family(monkeypatch):
    """Regression: native family tag 'codex' + a codex-CLI derivation (roster family
    'gpt') must be auto-excluded as the SAME family and never converge by themselves."""
    mb.set_agents_roster(ROSTER)
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    claim = {
        **_CLAIM,
        "native_derivations": [
            {"family": "codex", "canonical_answer": "42", "derivation_summary": "n", "confidence": "high"}
        ],
    }
    tags = []

    def run(spec, system, prompt, tag):
        tags.append(tag)
        return _mk_run()(spec, system, prompt, tag)

    out = mb.run_gate(
        {"context": "t", "claims": [claim]},
        pool=["codex/gpt-x-default"],
        comparators=["codex/gpt-x-default"],
        run=run,
    )
    row = out["matrix"][0]
    assert row["families"] == ["gpt"]          # one physical family, not ["codex", "gpt"]
    assert row["converged"] is False           # a family cannot self-certify cross-family
    assert row["native_dropped"] == []         # the alias attributed cleanly, nothing dropped
    # Auto-exclusion held: the gate never shelled out a derivation or tie-break to the
    # host's own family; only comparator-panel calls may appear.
    assert not any("derive" in t or "tiebreak" in t for t in tags), tags


def test_unattributable_native_tag_is_dropped_visibly(monkeypatch):
    """Regression: a native tag the agents file cannot attribute (the gateway alias
    'opencode') must not sit beside a roster-attributed CLI family and count one
    physical family twice — it is dropped, and the drop is visible in the row."""
    roster = {
        "version": 1,
        "families": {"glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}}},
    }
    mb.set_agents_roster(roster)
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    claim = {
        **_CLAIM,
        "native_derivations": [
            {"family": "opencode", "canonical_answer": "42", "derivation_summary": "n", "confidence": "high"}
        ],
    }
    out = mb.run_gate(
        {"context": "t", "claims": [claim]},
        pool=["zed/glm-z", "zed/glm-w"],
        comparators=["zed/glm-z"],
        run=_mk_run(),
    )
    row = out["matrix"][0]
    assert row["native_dropped"] == ["opencode"]
    assert row["native_seeded"] == 0
    assert row["families"] == ["glm"]          # never ["glm", "opencode"]
    assert row["converged"] is False
    assert out["family_pool"] == ["glm"]       # the dropped tag does not pad the pool


def test_native_tag_of_unavailable_family_is_dropped_visibly(monkeypatch):
    """A native tag claiming a family the agents file declares unavailable on this
    machine is most plausibly a mislabel; it must not corroborate a CLI family into
    a cross-family convergence. Dropped visibly, like an unattributable tag."""
    roster = {
        "version": 1,
        "families": {
            "glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}},
            "gem": {"runner": "gemini", "available": False},
        },
    }
    mb.set_agents_roster(roster)
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    claim = {
        **_CLAIM,
        "native_derivations": [
            {"family": "gem", "canonical_answer": "42", "derivation_summary": "n", "confidence": "high"}
        ],
    }
    out = mb.run_gate(
        {"context": "t", "claims": [claim]},
        pool=["zed/glm-z", "zed/glm-w"],
        comparators=["zed/glm-z"],
        run=_mk_run(),
    )
    row = out["matrix"][0]
    assert row["native_dropped"] == ["gem"]
    assert row["families"] == ["glm"]
    assert row["converged"] is False
    assert out["family_pool"] == ["glm"]


def test_pick_next_spec_uses_roster_families():
    mb.set_agents_roster(ROSTER)
    # zed/glm-z and zed/glm-next are ONE family per the roster: not diversity.
    pool = ["zed/glm-next", "codex/gpt-x-default"]
    assert mb.pick_next_spec(pool, used=["zed/glm-z"]) == "codex/gpt-x-default"


# ---------------------------------------------------------------- gate summary record
def _mk_run(answer="42"):
    def run(spec, system, prompt, tag):
        if "compare" in tag:
            return json.dumps({
                "majority_answer": answer, "majority_size": 2, "majority_indices": [0, 1],
                "all_equivalent": True, "outliers": "none",
                "correct_answer_adjudicated": answer, "adjudicated_matches_majority": True,
            })
        return json.dumps({"canonical_answer": answer, "derivation_summary": "s", "confidence": "high"})
    return run


_CLAIM = {"id": "T1", "statement": "Compute 17+25.", "report_format": "an integer"}


def test_run_gate_summary_records_roster_independence(monkeypatch):
    mb.set_agents_roster(ROSTER, source="explicit", path=Path("/x/agents.json"))
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    out = mb.run_gate(
        {"context": "t", "claims": [_CLAIM]},
        pool=["codex/gpt-x-default", "zed/glm-z"],
        comparators=["codex/gpt-x-default"],
        run=_mk_run(),
    )
    assert out["converged"] == 1
    assert out["family_pool"] == ["glm", "gpt"]
    assert out["matrix"][0]["families"] == ["glm", "gpt"]
    assert out["agents_file"] == {"path": "/x/agents.json", "source": "explicit"}
    info = out["independence"]
    assert info["level"] == "cross_family"
    assert info["participating_families"] == ["glm", "gpt"]
    # gem is declared unavailable; host is native and always usable.
    assert info["declared_available_families"] == ["glm", "gpt", "host", "kimi"]
    assert info["absent_families"] == ["gem", "host", "kimi"]
    assert info["cross_family_minimum"] == 3
    assert info["below_minimum"] is False
    assert info["when_below_minimum"] == "native_subagents"


def test_run_gate_below_minimum_is_labeled(monkeypatch):
    roster = {
        "version": 1,
        "families": {"glm": {"runner": "opencode", "models": {"default": "zed/glm-z"}}},
        "policy": {"cross_family_minimum": 3},
    }
    mb.set_agents_roster(roster, source="user", path=Path("/y/agents.json"))
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    out = mb.run_gate(
        {"context": "t", "claims": [_CLAIM]},
        pool=["zed/glm-z", "zed/glm-next"],
        comparators=["zed/glm-z"],
        run=_mk_run(),
    )
    # One roster family: R1 cannot be satisfied — the claim honestly stays unconverged.
    assert out["converged"] == 0
    info = out["independence"]
    assert info["level"] == "single_family"
    assert info["participating_families"] == ["glm"]
    assert info["below_minimum"] is True
    assert info["when_below_minimum"] == "native_subagents"


def test_run_gate_without_roster_keeps_pre_agents_file_summary():
    out = mb.run_gate(
        {"context": "t", "claims": [_CLAIM]},
        pool=["claude/default", "codex/default"],
        comparators=["codex/default"],
        run=_mk_run(),
    )
    assert out["agents_file"] == {"path": None, "source": "none"}
    info = out["independence"]
    assert info["level"] == "cross_family"
    assert info["participating_families"] == ["claude", "codex"]
    # Declaration-relative fields are present but null: nothing was declared.
    assert info["absent_families"] is None
    assert info["below_minimum"] is None
    assert info["when_below_minimum"] is None


# ---------------------------------------------------------------- availability
def test_usable_families_checks_declaration_and_binary(monkeypatch):
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: runner in ("native", "codex"))
    assert mb.usable_families(ROSTER) == ["gpt", "host"]  # gem declared off; glm/kimi binaries absent
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    assert mb.usable_families(ROSTER) == ["glm", "gpt", "host", "kimi"]


def test_agents_runner_available_native_and_binary(monkeypatch):
    assert mb.agents_runner_available("native") is True
    monkeypatch.setattr(mb.shutil, "which", lambda name: None)
    assert mb.agents_runner_available("codex") is False
    monkeypatch.setattr(mb.shutil, "which", lambda name: "/usr/bin/" + name)
    assert mb.agents_runner_available("codex") is True
    assert mb.agents_runner_available("claude-cli") is True


# ---------------------------------------------------------------- shared template fixture
def test_template_fixture_parses_and_resolves(monkeypatch):
    if not _TEMPLATE_FIXTURE.is_file():
        if _IN_REPO:
            pytest.fail(f"in-repo run but the shared template fixture is missing: {_TEMPLATE_FIXTURE}")
        pytest.skip(f"standalone skill install: template fixture not present: {_TEMPLATE_FIXTURE}")
    monkeypatch.setattr(mb, "agents_runner_available", lambda runner: True)
    roster = mb.validate_agents_roster(
        json.loads(_TEMPLATE_FIXTURE.read_text(encoding="utf-8")), source=_TEMPLATE_FIXTURE
    )
    assert sorted(roster["families"]) == ["claude", "gemini", "glm", "gpt", "kimi"]
    assert roster["policy"] == {"cross_family_minimum": 3, "when_below_minimum": "native_subagents"}
    assert mb.resolve_family_spec("family:gpt", roster) == "codex/gpt-5.6-terra"
    assert mb.resolve_family_spec("family:gpt:fast", roster) == "codex/gpt-5.6-luna"
    assert mb.resolve_family_spec("family:glm", roster) == "zhipuai-coding-plan/glm-5.2"
    assert mb.resolve_family_spec("family:kimi", roster) == "kimi/kimi-code/kimi-for-coding"
    with pytest.raises(ValueError, match="native_derivations"):
        mb.resolve_family_spec("family:claude", roster)
    with pytest.raises(ValueError, match="declared unavailable"):
        mb.resolve_family_spec("family:gemini", roster)
    # Roster-aware family identity round-trips through the resolved specs.
    mb.set_agents_roster(roster)
    assert mb.roster_family_of("codex/gpt-5.6-terra") == "gpt"
    assert mb.roster_family_of("zhipuai-coding-plan/glm-5.2") == "glm"
    assert mb.roster_family_of("kimi/kimi-code/kimi-for-coding") == "kimi"
