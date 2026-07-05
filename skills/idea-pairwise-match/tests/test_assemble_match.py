"""Tests for assemble_match.py: tally, observation mapping, integrity thread,
artifact validation, rematch guard."""

import copy
import json
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

import assemble_match
import commit_criteria

SCRIPT = Path(assemble_match.__file__)

CRITERIA = ["tension resolution", "verification cost"]
IDEA_A = "1f6c9d5e-4a2b-4c8d-9e3f-7a1b2c3d4e5f"
IDEA_B = "2a7d0e6f-5b3c-4d9e-8f4a-0b1c2d3e4f5a"
CAMPAIGN_ID = "3b8e1f70-6c4d-4e0f-9a5b-1c2d3e4f5a6b"


def make_commitment(tmp_path, committed_at=None):
    commitment = commit_criteria.build_commitment(CRITERIA, committed_at=committed_at)
    path = tmp_path / "commitment.json"
    commit_criteria.write_json_atomic(path, commitment)
    return path, commitment


def make_vote(family, vote, commitment, collected_at=None, discarded=0):
    return {
        "reviewer_family": family,
        "model": "%s/test-model" % family,
        "vote": vote,
        "anchored_arguments": [
            {
                "argument": "decisive anchored point",
                "anchor_type": "literature",
                "anchor_ref": "https://example.org/reference",
            }
        ],
        "unanchored_arguments_discarded": discarded,
        "commitment_hash": commitment["commitment_hash"],
        "collected_at": collected_at or commit_criteria.utc_now_iso(),
    }


def write_votes(votes_dir, votes, names=None, independent_runners=True):
    votes_dir.mkdir(parents=True, exist_ok=True)
    for index, vote in enumerate(votes):
        name = (names or {}).get(index, "%s.json" % vote["reviewer_family"])
        commit_criteria.write_json_atomic(votes_dir / name, vote)
    # assemble() reads independent_runners from the panel run report next to the
    # votes; write a minimal report so the read path is exercised by default.
    commit_criteria.write_json_atomic(
        votes_dir.parent / "panel_run_report.json",
        {"independent_runners": independent_runners},
    )


def standard_setup(tmp_path, votes_spec):
    commitment_path, commitment = make_commitment(tmp_path)
    votes = [make_vote(family, value, commitment) for family, value in votes_spec]
    votes_dir = tmp_path / "votes"
    write_votes(votes_dir, votes)
    campaign = tmp_path / "campaign"
    campaign.mkdir()
    return commitment_path, commitment, votes_dir, campaign


# ---------------------------------------------------------------------------
# Tally and observation mapping
# ---------------------------------------------------------------------------

def test_tally_majority_and_margin():
    tally = assemble_match.tally_votes(["a", "a", "b", "tie"])
    assert tally["winner"] == "a"
    assert tally["votes_a"] == 2 and tally["votes_b"] == 1 and tally["ties"] == 1
    assert tally["vote_margin"] == pytest.approx(0.25)


def test_tally_tie():
    tally = assemble_match.tally_votes(["a", "b", "tie", "tie"])
    assert tally["winner"] == "tie"
    assert tally["vote_margin"] == 0.0


def test_tier_unanimous_win():
    tier, label = assemble_match.observation_tier(
        assemble_match.tally_votes(["a", "a", "a"])
    )
    assert tier == 10
    assert "unanimous" in label


def test_tier_split_win():
    tier, label = assemble_match.observation_tier(
        assemble_match.tally_votes(["a", "a", "b"])
    )
    assert tier == 3
    assert "split" in label


def test_tier_win_with_tie_votes_but_no_opposition_is_unanimous():
    # Pinned shared rule: individual tie votes count toward the valid-vote
    # total and are NOT votes for the losing idea, so zero opposing votes
    # still maps to tier 10.
    tier, _ = assemble_match.observation_tier(
        assemble_match.tally_votes(["a", "a", "tie"])
    )
    assert tier == 10
    tier, _ = assemble_match.observation_tier(
        assemble_match.tally_votes(["a", "tie", "tie"])
    )
    assert tier == 10


def test_tier_split_with_four_votes():
    tier, _ = assemble_match.observation_tier(
        assemble_match.tally_votes(["a", "a", "b", "tie"])
    )
    assert tier == 3


def test_tier_tie_produces_no_observation():
    tier, label = assemble_match.observation_tier(
        assemble_match.tally_votes(["a", "a", "b", "b"])
    )
    assert tier is None
    assert "no observation" in label


def test_tier_undefined_below_min_families():
    with pytest.raises(assemble_match.MatchError):
        assemble_match.observation_tier(assemble_match.tally_votes(["a", "a"]))


# ---------------------------------------------------------------------------
# Assembly end-to-end
# ---------------------------------------------------------------------------

def test_assemble_writes_valid_artifact(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path,
        [("claude", "a"), ("codex", "a"), ("opencode", "b"), ("kimi", "tie")],
    )
    artifact_path, artifact, tier, label = assemble_match.assemble(
        commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
    )
    assert artifact_path.is_file()
    assert artifact_path.parent == campaign / "artifacts" / "matches"
    assert artifact_path.name == "match-%s.json" % artifact["match_id"]
    assert not assemble_match.validate_pairwise_match(artifact)
    assert artifact["outcome"]["winner"] == "a"
    assert artifact["outcome"]["vote_margin"] == pytest.approx(0.25)
    assert tier == 3
    families = [entry["reviewer_family"] for entry in artifact["panel"]]
    assert families == ["claude", "codex", "opencode", "kimi"]
    # The panel run report's independent_runners flag is carried into the
    # artifact, so a low-diversity panel is visible in the artifact itself.
    assert artifact["independent_runners"] is True
    assert artifact["observation_write"] == {"written": False}
    for entry in artifact["panel"]:
        assert set(entry) == assemble_match.PANEL_ENTRY_KEYS
    on_disk = json.loads(artifact_path.read_text(encoding="utf-8"))
    assert on_disk == artifact


def test_stub_backed_panel_flag_is_carried_into_artifact(tmp_path):
    # A panel run under the stub/single-model escape hatch stamps
    # independent_runners = false in its report; assembly must carry that flag
    # into the artifact so the belief layer sees the low diversity.
    commitment_path, commitment = make_commitment(tmp_path)
    votes = [
        make_vote(family, "a", commitment)
        for family in ("claude", "codex", "opencode")
    ]
    votes_dir = tmp_path / "votes"
    write_votes(votes_dir, votes, independent_runners=False)
    campaign = tmp_path / "campaign"
    campaign.mkdir()
    _, artifact, _, _ = assemble_match.assemble(
        commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
    )
    assert artifact["independent_runners"] is False
    assert not assemble_match.validate_pairwise_match(artifact)


def test_assemble_refuses_when_panel_report_missing(tmp_path):
    # No panel_run_report.json next to the votes: assembly refuses rather than
    # silently omitting the independent_runners flag.
    commitment_path, commitment = make_commitment(tmp_path)
    votes = [
        make_vote(family, "a", commitment)
        for family in ("claude", "codex", "opencode")
    ]
    votes_dir = tmp_path / "votes"
    write_votes(votes_dir, votes)
    (votes_dir.parent / "panel_run_report.json").unlink()
    campaign = tmp_path / "campaign"
    campaign.mkdir()
    with pytest.raises(assemble_match.MatchError, match="panel run report not found"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assemble_rejects_fewer_than_three_families(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("codex", "b")]
    )
    with pytest.raises(assemble_match.MatchError, match="minimum 3"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assemble_rejects_duplicate_family(tmp_path):
    commitment_path, commitment = make_commitment(tmp_path)
    votes = [
        make_vote("codex", "a", commitment),
        make_vote("codex", "b", commitment),
        make_vote("kimi", "a", commitment),
    ]
    votes_dir = tmp_path / "votes"
    write_votes(votes_dir, votes, names={1: "codex_second.json"})
    campaign = tmp_path / "campaign"
    campaign.mkdir()
    with pytest.raises(assemble_match.MatchError, match="duplicate vote"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assemble_rejects_commitment_hash_mismatch(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("codex", "a"), ("kimi", "a")]
    )
    tampered_path = votes_dir / "codex.json"
    record = json.loads(tampered_path.read_text(encoding="utf-8"))
    record["commitment_hash"] = "sha256:" + "0" * 64
    commit_criteria.write_json_atomic(tampered_path, record)
    with pytest.raises(assemble_match.MatchError, match="thread is broken"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assemble_rejects_votes_collected_before_commitment(tmp_path):
    commitment_path, commitment = make_commitment(
        tmp_path, committed_at="2999-01-01T00:00:00+00:00"
    )
    votes = [
        make_vote(family, "a", commitment)
        for family in ("claude", "codex", "opencode")
    ]
    votes_dir = tmp_path / "votes"
    write_votes(votes_dir, votes)
    campaign = tmp_path / "campaign"
    campaign.mkdir()
    with pytest.raises(assemble_match.MatchError, match="stage order violated"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assemble_rejects_bad_uuids_and_same_pair(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("codex", "a"), ("kimi", "a")]
    )
    with pytest.raises(assemble_match.MatchError, match="not a lowercase dashed uuid"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, "not-a-uuid", IDEA_A, IDEA_B
        )
    with pytest.raises(assemble_match.MatchError, match="same node"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_A
        )


# ---------------------------------------------------------------------------
# Rematch guard
# ---------------------------------------------------------------------------

def test_rematch_requires_rationale(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("codex", "a"), ("kimi", "a")]
    )
    assemble_match.assemble(
        commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
    )
    with pytest.raises(assemble_match.MatchError, match="rematch"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )
    # The unordered pair is what counts: swapped labels are still a rematch.
    with pytest.raises(assemble_match.MatchError, match="rematch"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_B, IDEA_A
        )
    path, artifact, tier, _ = assemble_match.assemble(
        commitment_path,
        votes_dir,
        campaign,
        CAMPAIGN_ID,
        IDEA_A,
        IDEA_B,
        rationale="new computation artifact changes the verification-cost picture",
    )
    assert artifact["rationale"].startswith("new computation")
    assert not assemble_match.validate_pairwise_match(artifact)


# ---------------------------------------------------------------------------
# Materials cross-check
# ---------------------------------------------------------------------------

def _write_statement(path, commitment, node_id):
    path.write_text(
        "criteria_commitment: %s\nidea_node_id: %s\n\nBody. [anchor: literature -> https://example.org/reference]\n"
        % (commitment["commitment_hash"], node_id),
        encoding="utf-8",
    )


def test_materials_cross_check(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("codex", "a"), ("kimi", "a")]
    )
    materials = tmp_path / "materials"
    materials.mkdir()
    _write_statement(materials / "statement_a.md", commitment, IDEA_A)
    _write_statement(materials / "statement_b.md", commitment, IDEA_B)
    artifact_path, artifact, _, _ = assemble_match.assemble(
        commitment_path,
        votes_dir,
        campaign,
        CAMPAIGN_ID,
        IDEA_A,
        IDEA_B,
        materials_dir=materials,
    )
    assert artifact_path.is_file()

    campaign2 = tmp_path / "campaign2"
    campaign2.mkdir()
    swapped = tmp_path / "materials_swapped"
    swapped.mkdir()
    _write_statement(swapped / "statement_a.md", commitment, IDEA_B)
    _write_statement(swapped / "statement_b.md", commitment, IDEA_A)
    with pytest.raises(assemble_match.MatchError, match="argues for node"):
        assemble_match.assemble(
            commitment_path,
            votes_dir,
            campaign2,
            CAMPAIGN_ID,
            IDEA_A,
            IDEA_B,
            materials_dir=swapped,
        )


# ---------------------------------------------------------------------------
# Artifact validator, field by field
# ---------------------------------------------------------------------------

@pytest.fixture()
def valid_artifact(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path,
        [("claude", "a"), ("codex", "a"), ("opencode", "b"), ("kimi", "tie")],
    )
    _, artifact, _, _ = assemble_match.assemble(
        commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
    )
    return artifact


def _mutated(artifact, mutate):
    clone = copy.deepcopy(artifact)
    mutate(clone)
    return assemble_match.validate_pairwise_match(clone)


def test_validator_accepts_the_assembled_artifact(valid_artifact):
    assert assemble_match.validate_pairwise_match(valid_artifact) == []


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (lambda a: a.pop("match_id"), "missing top-level key: match_id"),
        (lambda a: a.__setitem__("match_id", "XYZ"), "not a lowercase dashed uuid"),
        (lambda a: a.__setitem__("idea_b_node_id", IDEA_A), "equals"),
        (lambda a: a.__setitem__("extra", 1), "unknown top-level keys"),
        (
            lambda a: a["criteria_commitment"].__setitem__("criteria", ["x", "y"]),
            "does not match",
        ),
        (lambda a: a.__setitem__("panel", []), "non-empty array"),
        (
            lambda a: a["panel"][0].__setitem__("reviewer_family", "gemini"),
            "reviewer_family must be one of",
        ),
        (
            lambda a: a["panel"][1].__setitem__(
                "reviewer_family", a["panel"][0]["reviewer_family"]
            ),
            "more than once",
        ),
        (lambda a: a["panel"][0].__setitem__("vote", "abstain"), "vote must be one of"),
        (
            lambda a: a["panel"][0].__setitem__("surprise", 1),
            "unknown keys: surprise",
        ),
        (
            lambda a: a["panel"][0]["anchored_arguments"][0].__setitem__("anchor_type", "vibes"),
            "anchor_type must be one of",
        ),
        (
            lambda a: a["panel"][0]["anchored_arguments"][0].__setitem__("anchor_ref", "  "),
            "anchor_ref must be a non-empty string",
        ),
        (
            lambda a: a["panel"][0].__setitem__("unanchored_arguments_discarded", -1),
            "integer >= 0",
        ),
        (
            lambda a: a["panel"][0].__setitem__("unanchored_arguments_discarded", True),
            "integer >= 0",
        ),
        (
            lambda a: a["panel"][0].__setitem__("model", ""),
            "model must be a non-empty string",
        ),
        (lambda a: a["outcome"].__setitem__("winner", "b"), "does not match the panel tally"),
        (lambda a: a["outcome"].__setitem__("vote_margin", 0.9), "does not match the panel tally"),
        (lambda a: a["outcome"].__setitem__("vote_margin", 1.5), "must lie in"),
        (
            lambda a: a["outcome"].__setitem__("decided_at", "2001-01-01T00:00:00+00:00"),
            "precedes",
        ),
        (lambda a: a["outcome"].pop("decided_at"), "outcome is missing key: decided_at"),
        (
            lambda a: a["observation_write"].__setitem__("written", "no"),
            "must be a boolean",
        ),
        (
            lambda a: a["observation_write"].__setitem__("gaia_package_ref", ""),
            "gaia_package_ref must be a non-empty string",
        ),
        (
            lambda a: a["observation_write"].__setitem__("surprise", 1),
            "observation_write has unknown keys",
        ),
        (lambda a: a.__setitem__("rationale", "   "), "non-empty string"),
        (lambda a: a.__setitem__("panel", a["panel"][:2]), "at least 3"),
        (lambda a: a.pop("independent_runners"), "missing top-level key: independent_runners"),
        (lambda a: a.__setitem__("independent_runners", "yes"), "independent_runners must be a boolean"),
    ],
)
def test_validator_catches_mutations(valid_artifact, mutate, expected):
    problems = _mutated(valid_artifact, mutate)
    assert any(expected in problem for problem in problems), problems


def test_validator_accepts_written_observation(valid_artifact):
    done = copy.deepcopy(valid_artifact)
    done["observation_write"] = {
        "written": True,
        "gaia_package_ref": "artifact://campaign/gaia/observations/obs-1.json",
    }
    assert assemble_match.validate_pairwise_match(done) == []


def _binding(node_a, node_b):
    return {
        "a": {"idea_node_id": node_a, "content_sha256": "sha256:" + "a" * 64},
        "b": {"idea_node_id": node_b, "content_sha256": "sha256:" + "b" * 64},
    }


def test_validator_accepts_correct_statement_binding(valid_artifact):
    ok = copy.deepcopy(valid_artifact)
    ok["statement_binding"] = _binding(IDEA_A, IDEA_B)
    assert assemble_match.validate_pairwise_match(ok) == []


def test_validator_rejects_statement_binding_wrong_node(valid_artifact):
    bad = copy.deepcopy(valid_artifact)
    bad["statement_binding"] = _binding(IDEA_B, IDEA_B)  # side a points at B
    problems = assemble_match.validate_pairwise_match(bad)
    assert any("statement_binding.a.idea_node_id" in p for p in problems)


def test_validator_rejects_statement_binding_bad_hash(valid_artifact):
    bad = copy.deepcopy(valid_artifact)
    binding = _binding(IDEA_A, IDEA_B)
    binding["a"]["content_sha256"] = "not-a-hash"
    bad["statement_binding"] = binding
    problems = assemble_match.validate_pairwise_match(bad)
    assert any("content_sha256 must be sha256" in p for p in problems)


# ---------------------------------------------------------------------------
# CLI smoke
# ---------------------------------------------------------------------------

def write_materials(materials_dir, commitment):
    """Write the two statements assemble_match needs for its mandatory
    materials cross-check and statement binding."""
    materials_dir.mkdir(parents=True, exist_ok=True)
    for side, node in (("a", IDEA_A), ("b", IDEA_B)):
        text = (
            "criteria_commitment: %s\n"
            "idea_node_id: %s\n\n"
            "# Advocacy statement: Idea %s\n\n"
            "## tension resolution\n\n"
            "Resolves the standing tension. "
            "[anchor: literature -> https://example.org/reference]\n"
            % (commitment["commitment_hash"], node, side.upper())
        )
        (materials_dir / ("statement_%s.md" % side)).write_text(text, encoding="utf-8")
    return materials_dir


def test_cli_smoke(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path,
        [("claude", "a"), ("codex", "a"), ("opencode", "b"), ("kimi", "tie")],
    )
    materials = write_materials(tmp_path / "materials", commitment)
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--commitment",
            str(commitment_path),
            "--votes-dir",
            str(votes_dir),
            "--campaign-dir",
            str(campaign),
            "--campaign-id",
            CAMPAIGN_ID,
            "--idea-a",
            IDEA_A,
            "--idea-b",
            IDEA_B,
            "--materials-dir",
            str(materials),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "winner: a" in result.stdout
    assert "split win" in result.stdout
    matches = list((campaign / "artifacts" / "matches").glob("match-*.json"))
    assert len(matches) == 1
    artifact = json.loads(matches[0].read_text(encoding="utf-8"))
    # The mandatory materials binding is embedded and auditable.
    assert artifact["statement_binding"]["a"]["idea_node_id"] == IDEA_A
    assert artifact["statement_binding"]["b"]["idea_node_id"] == IDEA_B
    assert artifact["statement_binding"]["a"]["content_sha256"].startswith("sha256:")


def test_cli_requires_materials_dir(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path,
        [("claude", "a"), ("codex", "a"), ("opencode", "b")],
    )
    result = subprocess.run(
        [
            sys.executable, str(SCRIPT),
            "--commitment", str(commitment_path),
            "--votes-dir", str(votes_dir),
            "--campaign-dir", str(campaign),
            "--campaign-id", CAMPAIGN_ID,
            "--idea-a", IDEA_A,
            "--idea-b", IDEA_B,
        ],
        capture_output=True,
        text=True,
    )
    # argparse refuses the run: no artifact can be written without the
    # statement binding proof.
    assert result.returncode == 2
    assert "materials-dir" in result.stderr
