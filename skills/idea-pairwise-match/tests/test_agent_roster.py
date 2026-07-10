"""Tests for the third-party agent roster: parsing and validation of
agents.json (schema version 1), the discovery order (explicit path, project
walk-up, user level, built-in pure-native), and the degraded native subagent
panel that runs when the roster cannot field the cross-family floor.

All roster fixtures are inline in this file by design: the tests must not
depend on any roster template shipped elsewhere in the repository.
"""

import json

import pytest

import assemble_match
import commit_criteria
import run_panel

from test_run_panel_mock import (
    CAMPAIGN_ID,
    GEMINI_ABSENT_REASON,
    IDEA_A,
    IDEA_B,
    ROSTER,
    STUB_SOURCE,
    build_materials,
    run_panel_cli,
    runner_arg,
    write_roster,
)


def make_roster(**overrides):
    roster = json.loads(json.dumps(ROSTER))
    roster.update(overrides)
    return roster


# ---------------------------------------------------------------------------
# Roster parsing and validation (in-process)
# ---------------------------------------------------------------------------

def test_parse_roster_full_v1_fixture():
    parsed = run_panel.parse_roster(ROSTER, "inline fixture")
    assert parsed["cross_family_minimum"] == 3
    families = parsed["families"]
    assert list(families) == ["claude", "gpt", "glm", "kimi", "gemini"]
    assert families["claude"] == {
        "runner": "native", "model": "fable", "available": True, "notes": "",
    }
    assert families["gpt"]["runner"] == "codex"
    assert families["gpt"]["model"] == "gpt-5.6-terra"
    assert families["glm"]["runner"] == "opencode"
    assert families["glm"]["model"] == "zhipuai-coding-plan/glm-5.2"
    assert families["kimi"]["runner"] == "kimi"
    assert families["kimi"]["model"] == "kimi-code/kimi-for-coding"
    # An unavailable family may omit its models object entirely (the finalized
    # schema's gemini entry does); it can never be invoked anyway.
    assert families["gemini"]["available"] is False
    assert families["gemini"]["model"] is None
    assert "no local access" in families["gemini"]["notes"]


def test_builtin_roster_is_pure_native_and_parses():
    # The built-in seat is labeled "host": the script cannot verify which
    # model family the host is, so it does not guess one.
    parsed = run_panel.parse_roster(run_panel.builtin_roster(), "built-in")
    assert list(parsed["families"]) == ["host"]
    assert parsed["families"]["host"]["runner"] == "native"
    assert parsed["cross_family_minimum"] == run_panel.MIN_FAMILIES


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (lambda r: r.update(version=2), "version must be the integer 1"),
        # In Python, True == 1 and 1.0 == 1; the parser must reject both.
        (lambda r: r.update(version=True), "version must be the integer 1"),
        (lambda r: r.update(version=1.0), "version must be the integer 1"),
        (lambda r: r.update(extra=1), "unknown top-level keys"),
        (lambda r: r.update(families={}), "non-empty object"),
        (
            lambda r: r["families"].__setitem__(
                "qwen", {"runner": "warp-drive", "models": {"default": "q1"}}
            ),
            "runner must be one of",
        ),
        (
            lambda r: r["families"].__setitem__("gpt", {"runner": "codex", "models": {"fast": "x"}}),
            'must carry a "default" entry',
        ),
        (
            lambda r: r["families"]["kimi"]["models"].__setitem__(
                "default", "<CONFIRM-FROM-RUNNER>"
            ),
            "plain model string",
        ),
        (
            lambda r: r["families"].__setitem__(
                "second-host", {"runner": "native", "models": {"default": "x"}}
            ),
            "exactly one native seat",
        ),
        (
            lambda r: r["families"].__setitem__(
                "BadLabel", {"runner": "codex", "models": {"default": "x"}}
            ),
            "family label",
        ),
        # A trailing newline must fail: with re.match, the pattern's $ would
        # tolerate it while the engine-side JS regex rejects it.
        (
            lambda r: r["families"].__setitem__(
                "qwen\n", {"runner": "codex", "models": {"default": "x"}}
            ),
            "family label",
        ),
        (
            lambda r: r["families"]["gpt"]["models"].__setitem__(
                "default", "gpt-5.6-terra\n"
            ),
            "plain model string",
        ),
        (
            lambda r: r["families"]["gpt"].__setitem__("surprise", 1),
            "unknown keys",
        ),
        (
            lambda r: r["policy"].__setitem__("cross_family_minimum", 2),
            "cannot lower it",
        ),
        (
            lambda r: r["policy"].__setitem__("when_below_minimum", "substitute"),
            "when_below_minimum",
        ),
        (
            lambda r: r["policy"].__setitem__("surprise", 1),
            "policy has unknown keys",
        ),
    ],
)
def test_parse_roster_rejects_bad_shapes(mutate, expected):
    roster = make_roster()
    mutate(roster)
    with pytest.raises(run_panel.PanelError, match=expected):
        run_panel.parse_roster(roster, "inline fixture")


def test_parse_roster_accepts_minimum_above_the_floor():
    roster = make_roster()
    roster["policy"]["cross_family_minimum"] = 4
    parsed = run_panel.parse_roster(roster, "inline fixture")
    assert parsed["cross_family_minimum"] == 4


# ---------------------------------------------------------------------------
# Discovery order: explicit > project walk-up > user level > built-in
# ---------------------------------------------------------------------------

def roster_with_only(tmp_path, name, families):
    roster = {
        "version": 1,
        "families": families,
        "policy": {"cross_family_minimum": 3, "when_below_minimum": "native_subagents"},
    }
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(roster), encoding="utf-8")
    return path


def discovery_layout(tmp_path):
    """A project tree with a materials directory three levels below the
    project root, plus a separate home directory."""
    project = tmp_path / "project"
    materials = project / "campaign" / "matches" / "work"
    materials.mkdir(parents=True)
    home = tmp_path / "home"
    home.mkdir()
    return project, materials, home


CLI_FAMILIES = {"cli-only": {"runner": "codex", "models": {"default": "m1"}}}
PROJECT_FAMILIES = {"project-only": {"runner": "codex", "models": {"default": "m2"}}}
USER_FAMILIES = {"user-only": {"runner": "codex", "models": {"default": "m3"}}}


def test_explicit_roster_beats_project_and_user(tmp_path):
    project, materials, home = discovery_layout(tmp_path)
    explicit = roster_with_only(tmp_path, "explicit.json", CLI_FAMILIES)
    roster_with_only(project, ".nullius/agents.json", PROJECT_FAMILIES)
    roster_with_only(home, ".nullius/agents.json", USER_FAMILIES)
    roster, source, path = run_panel.resolve_roster(explicit, materials, home=home)
    assert source == "explicit"
    assert path == explicit
    assert list(roster["families"]) == ["cli-only"]


def test_project_roster_beats_user_roster(tmp_path):
    project, materials, home = discovery_layout(tmp_path)
    project_path = roster_with_only(project, ".nullius/agents.json", PROJECT_FAMILIES)
    roster_with_only(home, ".nullius/agents.json", USER_FAMILIES)
    roster, source, path = run_panel.resolve_roster(None, materials, home=home)
    assert source == "project"
    assert path == project_path
    assert list(roster["families"]) == ["project-only"]


def test_user_roster_when_no_project_file(tmp_path):
    _project, materials, home = discovery_layout(tmp_path)
    user_path = roster_with_only(home, ".nullius/agents.json", USER_FAMILIES)
    roster, source, path = run_panel.resolve_roster(None, materials, home=home)
    assert source == "user"
    assert path == user_path
    assert list(roster["families"]) == ["user-only"]


def test_missing_files_fall_back_to_builtin_without_error(tmp_path):
    _project, materials, home = discovery_layout(tmp_path)
    roster, source, path = run_panel.resolve_roster(None, materials, home=home)
    assert source == "builtin"
    assert path is None
    assert list(roster["families"]) == ["host"]


def test_project_walkup_finds_nearest_ancestor(tmp_path):
    project, materials, home = discovery_layout(tmp_path)
    # Both the project root and an inner directory carry a roster; the walk-up
    # from the materials directory must take the nearest one.
    roster_with_only(project, ".nullius/agents.json", PROJECT_FAMILIES)
    inner_path = roster_with_only(
        project / "campaign", ".nullius/agents.json", CLI_FAMILIES
    )
    roster, source, path = run_panel.resolve_roster(None, materials, home=home)
    assert source == "project"
    assert path == inner_path
    assert list(roster["families"]) == ["cli-only"]


def test_explicit_roster_must_exist(tmp_path):
    _project, materials, home = discovery_layout(tmp_path)
    with pytest.raises(run_panel.PanelError, match="cannot read roster"):
        run_panel.resolve_roster(tmp_path / "missing.json", materials, home=home)


def test_invalid_discovered_roster_is_a_loud_error(tmp_path):
    # A roster file that exists but is broken must stop the run naming the
    # file, never silently fall through to the next discovery source.
    project, materials, home = discovery_layout(tmp_path)
    bad = project / ".nullius" / "agents.json"
    bad.parent.mkdir(parents=True)
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(run_panel.PanelError, match="not valid JSON"):
        run_panel.resolve_roster(None, materials, home=home)


# ---------------------------------------------------------------------------
# Degraded native subagent panel (end to end)
# ---------------------------------------------------------------------------

VOTE_REPLY = (
    'Reply of seat %d.\n```json\n{"vote": "%s", "anchored_arguments": [], '
    '"unanchored_arguments_discarded": 0}\n```\n'
)


def write_native_votes(tmp_path, votes):
    # Each seat's reply carries its own seat marker: independent subagents
    # never produce byte-identical replies, and run_panel refuses them.
    files = []
    for index, vote in enumerate(votes, start=1):
        path = tmp_path / ("native_reply_%d.txt" % index)
        path.write_text(VOTE_REPLY % (index, vote), encoding="utf-8")
        files.append(path)
    return files


def native_vote_args(files):
    args = []
    for path in files:
        args += ["--native-vote", str(path)]
    return args


def test_no_roster_anywhere_degrades_with_guidance(tmp_path):
    # With no agents.json anywhere the built-in pure-native roster applies:
    # one available family, below the floor of three, so the run stops with
    # the degradation guidance and a report of the aborted attempt.
    materials, _ = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    result = run_panel_cli(materials, out_dir, [])
    assert result.returncode == 3
    assert "native_subagents" in result.stderr
    assert "--native-vote" in result.stderr
    assert (out_dir / "judge_prompt.md").is_file()
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["panel_valid"] is False
    assert report["independence"] == "single_family"
    assert report["native_family"] == "host"
    assert report["seats_provided"] == 0
    assert report["roster"] == {"source": "builtin", "path": None}


def test_native_panel_collects_three_seats_and_assembles(tmp_path):
    materials, commitment = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    files = write_native_votes(tmp_path, ["a", "a", "tie"])
    result = run_panel_cli(materials, out_dir, native_vote_args(files))
    assert result.returncode == 0, result.stderr
    votes = sorted(path.name for path in (out_dir / "votes").glob("*.json"))
    assert votes == ["host_seat_1.json", "host_seat_2.json", "host_seat_3.json"]
    seat_two = json.loads(
        (out_dir / "votes" / "host_seat_2.json").read_text(encoding="utf-8")
    )
    assert seat_two["reviewer_family"] == "host"
    assert seat_two["seat"] == 2
    assert seat_two["model"] == "host/host-subagent"
    assert seat_two["commitment_hash"] == commitment["commitment_hash"]

    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["panel_valid"] is True
    assert report["independence"] == "single_family"
    assert report["independent_runners"] is False
    assert report["families_present"] == ["host"]
    assert report["seats_provided"] == 3
    assert report["seats_failed"] == []
    assert "single-family, degraded" in result.stdout

    campaign = tmp_path / "campaign"
    campaign.mkdir()
    _, artifact, tier, label = assemble_match.assemble(
        materials / "commitment.json",
        out_dir / "votes",
        campaign,
        CAMPAIGN_ID,
        IDEA_A,
        IDEA_B,
        materials_dir=materials,
    )
    assert assemble_match.validate_pairwise_match(artifact) == []
    assert artifact["panel_independence"]["mode"] == "single_family"
    assert artifact["panel_independence"]["families_present"] == ["host"]
    assert [entry["seat"] for entry in artifact["panel"]] == [1, 2, 3]
    assert artifact["independent_runners"] is False
    # Two votes for A, one tie, zero opposing votes: unanimous tier.
    assert artifact["outcome"]["winner"] == "a"
    assert tier == 10


def test_native_panel_with_declared_unavailable_family_records_it(tmp_path):
    # A roster whose only families are the native host and an unavailable
    # gemini seat cannot field the floor; the degradation report must keep the
    # unavailable family on record with the roster's reason.
    materials, _ = build_materials(tmp_path)
    roster = write_roster(
        tmp_path,
        {
            "version": 1,
            "families": {
                "claude": {"runner": "native", "models": {"default": "fable"}},
                "gemini": {
                    "runner": "gemini",
                    "available": False,
                    "notes": "no local access on this machine",
                },
            },
            "policy": {
                "cross_family_minimum": 3,
                "when_below_minimum": "native_subagents",
            },
        },
    )
    out_dir = tmp_path / "panel"
    files = write_native_votes(tmp_path, ["b", "b", "b"])
    result = run_panel_cli(materials, out_dir, native_vote_args(files), roster=roster)
    assert result.returncode == 0, result.stderr
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["independence"] == "single_family"
    assert report["absent"] == [{"family": "gemini", "reason": GEMINI_ABSENT_REASON}]


def test_native_panel_bad_seat_reply_fails_the_floor(tmp_path):
    materials, _ = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    files = write_native_votes(tmp_path, ["a", "a"])
    garbage = tmp_path / "native_reply_3.txt"
    garbage.write_text("no json here at all\n", encoding="utf-8")
    result = run_panel_cli(materials, out_dir, native_vote_args(files + [garbage]))
    assert result.returncode == 2
    assert "match is terminated" in result.stderr
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["panel_valid"] is False
    assert len(report["votes_collected"]) == 2
    assert len(report["seats_failed"]) == 1
    assert report["seats_failed"][0]["seat"] == 3
    assert "no JSON object" in report["seats_failed"][0]["reason"]


def test_native_panel_refuses_runner_overrides(tmp_path):
    materials, _ = build_materials(tmp_path)
    files = write_native_votes(tmp_path, ["a", "a", "a"])
    result = run_panel_cli(
        materials,
        tmp_path / "panel",
        ["--runner", "host=echo {prompt}"] + native_vote_args(files),
    )
    assert result.returncode == 1
    assert "take no --runner" in result.stderr


def test_native_seat_reply_hash_is_over_raw_bytes(tmp_path):
    # The recorded reply_sha256 is the sha256 of the file's raw bytes: a
    # reply with CRLF line endings hashes as written, without newline
    # translation.
    import hashlib

    materials, _ = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    files = write_native_votes(tmp_path, ["a", "a"])
    crlf = tmp_path / "native_reply_crlf.txt"
    crlf.write_bytes((VOTE_REPLY % (3, "tie")).replace("\n", "\r\n").encode("utf-8"))
    result = run_panel_cli(materials, out_dir, native_vote_args(files + [crlf]))
    assert result.returncode == 0, result.stderr
    seat_three = json.loads(
        (out_dir / "votes" / "host_seat_3.json").read_text(encoding="utf-8")
    )
    expected = hashlib.sha256(crlf.read_bytes()).hexdigest()
    assert seat_three["collection"]["reply_sha256"] == "sha256:" + expected


def test_native_seat_that_is_not_utf8_fails_that_seat_only(tmp_path):
    # A reply that is not UTF-8 text fails its own seat with a recorded
    # reason; it does not crash the run. With only two valid seats left the
    # panel then fails the floor.
    materials, _ = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    files = write_native_votes(tmp_path, ["a", "a"])
    binary = tmp_path / "native_reply_binary.txt"
    binary.write_bytes(b"\xff\xfe\x00 not text")
    result = run_panel_cli(materials, out_dir, native_vote_args(files + [binary]))
    assert result.returncode == 2
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert len(report["seats_failed"]) == 1
    assert "not UTF-8 text" in report["seats_failed"][0]["reason"]


def test_cross_family_native_vote_that_is_not_utf8_is_absent(tmp_path):
    # The cross-family native seat handles a non-UTF-8 reply the same way:
    # the family is absent with the read failure as the reason.
    materials, _ = build_materials(tmp_path)
    roster = write_roster(tmp_path)
    stub_path = tmp_path / "stub_judge.py"
    stub_path.write_text(STUB_SOURCE, encoding="utf-8")
    binary = tmp_path / "native_reply_binary.txt"
    binary.write_bytes(b"\xff\xfe\x00 not text")
    out_dir = tmp_path / "panel"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--native-vote", str(binary),
            "--runner", "gpt=" + runner_arg(stub_path, "a"),
            "--runner", "glm=" + runner_arg(stub_path, "b"),
            "--runner", "kimi=" + runner_arg(stub_path, "a"),
        ],
        roster=roster,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    reasons = {item["family"]: item["reason"] for item in report["absent"]}
    assert "as UTF-8 text" in reasons["claude"]


def test_native_panel_refuses_reused_reply_file(tmp_path):
    # One reply wearing three seat numbers is not a panel; the same file
    # given twice is refused before any seat is stored.
    materials, _ = build_materials(tmp_path)
    files = write_native_votes(tmp_path, ["a", "a"])
    result = run_panel_cli(
        materials,
        tmp_path / "panel",
        native_vote_args([files[0], files[1], files[0]]),
    )
    assert result.returncode == 1
    assert "every seat needs its own" in result.stderr


def test_native_panel_refuses_byte_identical_replies(tmp_path):
    materials, _ = build_materials(tmp_path)
    files = write_native_votes(tmp_path, ["a", "a", "tie"])
    clone = tmp_path / "native_reply_clone.txt"
    clone.write_text(files[0].read_text(encoding="utf-8"), encoding="utf-8")
    result = run_panel_cli(
        materials,
        tmp_path / "panel",
        native_vote_args([files[0], files[1], clone]),
    )
    assert result.returncode == 1
    assert "byte-identical" in result.stderr
    # Refusal happens before any seat is written: no vote files appear.
    assert not (tmp_path / "panel" / "votes").exists()


def test_failed_rerun_never_leaves_an_assemblable_hybrid(tmp_path):
    # A valid degraded panel is run and its report written; later reruns into
    # the same directory are refused for different reasons at different
    # points (a duplicated reply's content, the same file given twice, a
    # roster usage error). Every refused rerun must have invalidated the
    # earlier report already, so the directory can never present the previous
    # run's votes under a panel_valid report while the materials may have
    # changed; assembly then refuses for want of a report.
    materials, _ = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    files = write_native_votes(tmp_path, ["a", "a", "tie"])

    def valid_run():
        result = run_panel_cli(materials, out_dir, native_vote_args(files))
        assert result.returncode == 0, result.stderr
        assert (out_dir / "panel_run_report.json").is_file()

    def assert_not_assemblable():
        campaign = tmp_path / "campaign"
        if not campaign.is_dir():
            campaign.mkdir()
        with pytest.raises(assemble_match.MatchError, match="panel run report not found"):
            assemble_match.assemble(
                materials / "commitment.json",
                out_dir / "votes",
                campaign,
                CAMPAIGN_ID,
                IDEA_A,
                IDEA_B,
                materials_dir=materials,
            )

    # Refusal during reply validation: byte-identical contents.
    valid_run()
    clone = tmp_path / "native_reply_clone.txt"
    clone.write_text(files[0].read_text(encoding="utf-8"), encoding="utf-8")
    rerun = run_panel_cli(
        materials, out_dir, native_vote_args([files[0], files[1], clone])
    )
    assert rerun.returncode == 1
    assert "byte-identical" in rerun.stderr
    assert not (out_dir / "panel_run_report.json").exists()
    assert_not_assemblable()

    # Refusal at the earlier usage check: the same file given for two seats.
    valid_run()
    rerun = run_panel_cli(
        materials, out_dir, native_vote_args([files[0], files[1], files[0]])
    )
    assert rerun.returncode == 1
    assert "every seat needs its own" in rerun.stderr
    assert not (out_dir / "panel_run_report.json").exists()
    assert_not_assemblable()


def test_thin_roster_with_unavailable_native_family_cannot_run(tmp_path):
    # A thin roster whose only native family is itself declared unavailable
    # has nothing to degrade to; the run stops loudly.
    materials, _ = build_materials(tmp_path)
    roster = write_roster(
        tmp_path,
        {
            "version": 1,
            "families": {
                "claude": {
                    "runner": "native",
                    "available": False,
                    "notes": "host offline for maintenance",
                },
            },
            "policy": {
                "cross_family_minimum": 3,
                "when_below_minimum": "native_subagents",
            },
        },
    )
    files = write_native_votes(tmp_path, ["a", "a", "a"])
    result = run_panel_cli(
        materials, tmp_path / "panel", native_vote_args(files), roster=roster
    )
    assert result.returncode == 1
    assert "unavailable" in result.stderr
    assert "cannot run" in result.stderr


def test_families_subset_never_degrades_a_capable_roster(tmp_path):
    # The degradation decision is over the whole roster: requesting two
    # families of a roster that can field the floor runs a cross-family
    # panel that fails the vote floor (exit 2), it does not produce a
    # single-family native panel.
    materials, _ = build_materials(tmp_path)
    roster = write_roster(tmp_path)
    stub_path = tmp_path / "stub_judge.py"
    stub_path.write_text(STUB_SOURCE, encoding="utf-8")
    out_dir = tmp_path / "panel"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--families", "gpt,glm",
            "--runner", "gpt=" + runner_arg(stub_path, "a"),
            "--runner", "glm=" + runner_arg(stub_path, "b"),
        ],
        roster=roster,
    )
    assert result.returncode == 2
    assert "match is terminated" in result.stderr
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["independence"] == "cross_family"
    assert report["panel_valid"] is False


def test_cross_family_panel_takes_exactly_one_native_vote(tmp_path):
    materials, _ = build_materials(tmp_path)
    roster = write_roster(tmp_path)
    files = write_native_votes(tmp_path, ["a", "a"])
    result = run_panel_cli(
        materials, tmp_path / "panel", native_vote_args(files), roster=roster
    )
    assert result.returncode == 1
    assert "seats one native vote" in result.stderr


def test_native_vote_conflicts_with_native_runner_override(tmp_path):
    # Wiring the native seat to BOTH an injected reply file and a --runner
    # override is ambiguous; the run refuses instead of silently preferring
    # one of them.
    materials, _ = build_materials(tmp_path)
    roster = write_roster(tmp_path)
    stub_path = tmp_path / "stub_judge.py"
    stub_path.write_text(STUB_SOURCE, encoding="utf-8")
    files = write_native_votes(tmp_path, ["a"])
    result = run_panel_cli(
        materials,
        tmp_path / "panel",
        ["--runner", "claude=" + runner_arg(stub_path, "a")] + native_vote_args(files),
        roster=roster,
    )
    assert result.returncode == 1
    assert "give one or the other" in result.stderr


def test_roster_minimum_above_three_is_enforced_at_collection(tmp_path):
    # A roster demanding four families makes four the panel floor: with one
    # runner replying garbage only three votes arrive and the panel is
    # invalid, even though three would satisfy the protocol minimum.
    materials, _ = build_materials(tmp_path)
    roster_obj = make_roster()
    roster_obj["policy"]["cross_family_minimum"] = 4
    roster = write_roster(tmp_path, roster_obj)
    stub_path = tmp_path / "stub_judge.py"
    stub_path.write_text(STUB_SOURCE, encoding="utf-8")
    out_dir = tmp_path / "panel"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--runner", "claude=" + runner_arg(stub_path, "a"),
            "--runner", "gpt=" + runner_arg(stub_path, "a"),
            "--runner", "glm=" + runner_arg(stub_path, "b"),
            "--runner", "kimi=" + runner_arg(stub_path, "garbage"),
        ],
        roster=roster,
    )
    assert result.returncode == 2
    assert "minimum 4" in result.stderr
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["min_families"] == 4
    assert report["panel_valid"] is False


# ---------------------------------------------------------------------------
# Single-family assembly guards
# ---------------------------------------------------------------------------

def single_family_setup(tmp_path, votes, seats=None, families_present=None):
    commitment = commit_criteria.build_commitment(["tension resolution"])
    commitment_path = tmp_path / "commitment.json"
    commit_criteria.write_json_atomic(commitment_path, commitment)
    votes_dir = tmp_path / "votes"
    votes_dir.mkdir()
    votes_collected = {}
    for index, vote in enumerate(votes):
        seat = (seats or list(range(1, len(votes) + 1)))[index]
        record = {
            "reviewer_family": "claude",
            "model": "claude/host-subagent",
            "vote": vote,
            "anchored_arguments": [],
            "unanchored_arguments_discarded": 0,
            "commitment_hash": commitment["commitment_hash"],
            "collected_at": commit_criteria.utc_now_iso(),
            "seat": seat,
        }
        name = "vote_%d.json" % index
        commit_criteria.write_json_atomic(votes_dir / name, record)
        votes_collected["vote_%d" % index] = "votes/" + name
    commit_criteria.write_json_atomic(
        votes_dir.parent / "panel_run_report.json",
        {
            "independent_runners": False,
            "independence": "single_family",
            "families_present": families_present or ["claude"],
            "absent": [],
            "min_families": 3,
            "panel_valid": True,
            "votes_collected": votes_collected,
        },
    )
    campaign = tmp_path / "campaign"
    campaign.mkdir()
    return commitment_path, votes_dir, campaign


def add_vote_to_report(votes_dir, key, relpath):
    report_path = votes_dir.parent / "panel_run_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["votes_collected"][key] = relpath
    commit_criteria.write_json_atomic(report_path, report)


def test_single_family_assembly_rejects_duplicate_seats(tmp_path):
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"], seats=[1, 2, 2]
    )
    with pytest.raises(assemble_match.MatchError, match="duplicate seat"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_single_family_assembly_rejects_foreign_family_vote(tmp_path):
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    stray = json.loads(
        (sorted(votes_dir.glob("*.json"))[0]).read_text(encoding="utf-8")
    )
    stray["reviewer_family"] = "gpt"
    stray["seat"] = 9
    commit_criteria.write_json_atomic(votes_dir / "zz_stray.json", stray)
    add_vote_to_report(votes_dir, "zz_stray", "votes/zz_stray.json")
    with pytest.raises(assemble_match.MatchError, match="belongs to"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assembly_refuses_manifest_paths_outside_the_votes_directory(tmp_path):
    # A malformed report must not be able to import a vote file from outside
    # the panel: upward-climbing and absolute manifest paths are refused.
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    outside = tmp_path / "outside_vote.json"
    outside.write_text(
        (sorted(votes_dir.glob("*.json"))[0]).read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    for bad in ("../outside_vote.json", str(outside)):
        add_vote_to_report(votes_dir, "smuggled", bad)
        with pytest.raises(assemble_match.MatchError, match="escapes the panel directory"):
            assemble_match.assemble(
                commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
            )


def test_assembly_refuses_symlinked_vote_escaping_the_votes_directory(tmp_path):
    # A manifest path that LOOKS panel-relative but is a symlink resolving
    # outside the votes directory is refused too.
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    outside = tmp_path / "outside_vote.json"
    record = json.loads(
        (sorted(votes_dir.glob("*.json"))[0]).read_text(encoding="utf-8")
    )
    record["seat"] = 9
    commit_criteria.write_json_atomic(outside, record)
    (votes_dir / "vote_9.json").symlink_to(outside)
    add_vote_to_report(votes_dir, "vote_9", "votes/vote_9.json")
    with pytest.raises(assemble_match.MatchError, match="resolves outside the votes directory"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assembly_refuses_vote_file_not_named_by_report(tmp_path):
    # A stale seat from an earlier run sitting in the votes directory must
    # stop assembly, not silently join (or be silently ignored by) the panel.
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    stale = json.loads(
        (sorted(votes_dir.glob("*.json"))[0]).read_text(encoding="utf-8")
    )
    stale["seat"] = 9
    commit_criteria.write_json_atomic(votes_dir / "zz_stale.json", stale)
    with pytest.raises(assemble_match.MatchError, match="not named by the panel run report"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assembly_refuses_report_with_panel_valid_false(tmp_path):
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    report_path = votes_dir.parent / "panel_run_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["panel_valid"] = False
    commit_criteria.write_json_atomic(report_path, report)
    with pytest.raises(assemble_match.MatchError, match="panel_valid"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assembly_enforces_the_report_min_families(tmp_path):
    # A run held to a roster floor of four cannot be assembled from three
    # votes, even though three satisfies the protocol minimum.
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    report_path = votes_dir.parent / "panel_run_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["min_families"] = 4
    commit_criteria.write_json_atomic(report_path, report)
    with pytest.raises(assemble_match.MatchError, match="minimum 4"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assembly_refuses_single_family_report_claiming_independent_runners(tmp_path):
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    report_path = votes_dir.parent / "panel_run_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["independent_runners"] = True
    commit_criteria.write_json_atomic(report_path, report)
    with pytest.raises(assemble_match.MatchError, match="never count as independent"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_validator_rejects_single_family_artifact_claiming_independent_runners(tmp_path):
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    _, artifact, _, _ = assemble_match.assemble(
        commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
    )
    assert assemble_match.validate_pairwise_match(artifact) == []
    dishonest = json.loads(json.dumps(artifact))
    dishonest["independent_runners"] = True
    problems = assemble_match.validate_pairwise_match(dishonest)
    assert any("never independent runners" in p for p in problems)


def test_single_family_assembly_requires_seat_numbers(tmp_path):
    commitment_path, votes_dir, campaign = single_family_setup(
        tmp_path, ["a", "a", "b"]
    )
    first = sorted(votes_dir.glob("*.json"))[0]
    record = json.loads(first.read_text(encoding="utf-8"))
    del record["seat"]
    commit_criteria.write_json_atomic(first, record)
    with pytest.raises(assemble_match.MatchError, match="seat"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )
