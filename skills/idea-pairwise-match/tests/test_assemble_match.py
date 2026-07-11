"""Tests for assemble_match.py: tally, observation mapping, integrity thread,
artifact validation, rematch guard."""

import copy
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

import assemble_match
import commit_criteria
import run_panel

SCRIPT = Path(assemble_match.__file__)

CRITERIA = ["tension resolution", "verification cost"]
# A well-formed but arbitrary placeholder: correct for tests that never pass
# materials_dir to assemble() (the content-binding rebuild-and-compare in
# read_panel_report only runs when materials_dir is given), so most fixtures
# only need judge_prompt_sha256/word_cap to satisfy the required-field shape
# check, not to actually match any real rendered prompt.
PLACEHOLDER_JUDGE_PROMPT_SHA256 = "sha256:" + "0" * 64
PLACEHOLDER_WORD_CAP = run_panel.DEFAULT_WORD_CAP
# Engine short ids: 8 chars of lowercase Crockford base32 (idea_node_v1 /
# pairwise_match_v1 convention).
IDEA_A = "1f6c9d5e"
IDEA_B = "2a7d0e6f"
CAMPAIGN_ID = "3b8e1f70"


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


def write_votes(votes_dir, votes, names=None, independent_runners=True,
                families_present=None, absent=None,
                judge_prompt_sha256=None, word_cap=None):
    votes_dir.mkdir(parents=True, exist_ok=True)
    votes_collected = {}
    for index, vote in enumerate(votes):
        name = (names or {}).get(index, "%s.json" % vote["reviewer_family"])
        commit_criteria.write_json_atomic(votes_dir / name, vote)
        votes_collected[name[: -len(".json")]] = "votes/" + name
    # assemble() reads the panel composition record from the run report next
    # to the votes; write one so the read path is exercised by default.
    if families_present is None:
        families_present = sorted({vote["reviewer_family"] for vote in votes})
    commit_criteria.write_json_atomic(
        votes_dir.parent / "panel_run_report.json",
        {
            "independent_runners": independent_runners,
            "independence": "cross_family",
            "families_present": families_present,
            "absent": absent if absent is not None else [],
            "min_families": 3,
            "panel_valid": True,
            "votes_collected": votes_collected,
            "judge_prompt_sha256": judge_prompt_sha256 or PLACEHOLDER_JUDGE_PROMPT_SHA256,
            "word_cap": word_cap or PLACEHOLDER_WORD_CAP,
        },
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
# Engine id convention (8-char short ids)
# ---------------------------------------------------------------------------

ENGINE_PAIRWISE_SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "idea-engine"
    / "contracts"
    / "idea-runtime-contracts"
    / "schemas"
    / "pairwise_match_v1.schema.json"
)


def test_short_id_pattern_matches_engine_contract():
    """Anti-drift lock on the tournament seam: the skill validator's id regex
    must be byte-for-byte the engine pairwise_match_v1 pattern for all four id
    fields. Skipped only when the skill runs standalone, away from the engine
    contract tree."""
    if not ENGINE_PAIRWISE_SCHEMA.is_file():
        pytest.skip("engine contract tree not present (standalone install)")
    schema = json.loads(ENGINE_PAIRWISE_SCHEMA.read_text(encoding="utf-8"))
    for key in ("match_id", "campaign_id", "idea_a_node_id", "idea_b_node_id"):
        assert (
            schema["properties"][key]["pattern"]
            == assemble_match.SHORT_ID_RE.pattern
        ), key


def test_mint_short_id_follows_engine_convention():
    minted = [assemble_match.mint_short_id() for _ in range(64)]
    for value in minted:
        assert assemble_match.SHORT_ID_RE.match(value)
    chars = set("".join(minted))
    assert chars <= set(assemble_match.SHORT_ID_ALPHABET)
    # 512 uniform draws over 32 symbols all landing inside the 16 hex symbols
    # has probability 2^-512, so a hex/uuid-prefix shortcut cannot pass this.
    assert any(c not in "0123456789abcdef" for c in chars)
    assert len(set(minted)) == len(minted)


# ---------------------------------------------------------------------------
# Assembly end-to-end
# ---------------------------------------------------------------------------

def test_assemble_writes_valid_artifact(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path,
        [("claude", "a"), ("gpt", "a"), ("glm", "b"), ("kimi", "tie")],
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
    # Canonical artifact order for a cross-family panel: family label.
    families = [entry["reviewer_family"] for entry in artifact["panel"]]
    assert families == ["claude", "glm", "gpt", "kimi"]
    # The panel composition record from the run report is carried into the
    # artifact, so a low-diversity panel is visible in the artifact itself.
    assert artifact["independent_runners"] is True
    assert artifact["panel_independence"] == {
        "mode": "cross_family",
        "families_present": ["claude", "glm", "gpt", "kimi"],
        "families_absent": [],
    }
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
        for family in ("claude", "gpt", "glm")
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
        for family in ("claude", "gpt", "glm")
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
        tmp_path, [("claude", "a"), ("gpt", "b")]
    )
    with pytest.raises(assemble_match.MatchError, match="minimum 3"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assemble_rejects_duplicate_family(tmp_path):
    commitment_path, commitment = make_commitment(tmp_path)
    votes = [
        make_vote("gpt", "a", commitment),
        make_vote("gpt", "b", commitment),
        make_vote("kimi", "a", commitment),
    ]
    votes_dir = tmp_path / "votes"
    write_votes(votes_dir, votes, names={1: "gpt_second.json"})
    campaign = tmp_path / "campaign"
    campaign.mkdir()
    with pytest.raises(assemble_match.MatchError, match="duplicate vote"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assemble_rejects_commitment_hash_mismatch(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("gpt", "a"), ("kimi", "a")]
    )
    tampered_path = votes_dir / "gpt.json"
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
        for family in ("claude", "gpt", "glm")
    ]
    votes_dir = tmp_path / "votes"
    write_votes(votes_dir, votes)
    campaign = tmp_path / "campaign"
    campaign.mkdir()
    with pytest.raises(assemble_match.MatchError, match="stage order violated"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


def test_assemble_rejects_bad_ids_and_same_pair(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("gpt", "a"), ("kimi", "a")]
    )
    with pytest.raises(assemble_match.MatchError, match="not an engine short id"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, "not-a-short-id", IDEA_A, IDEA_B
        )
    # A lowercase dashed uuid (the retired convention) is exactly what the
    # engine contract excludes; it must be rejected, not tolerated.
    with pytest.raises(assemble_match.MatchError, match="not an engine short id"):
        assemble_match.assemble(
            commitment_path,
            votes_dir,
            campaign,
            "3b8e1f70-6c4d-4e0f-9a5b-1c2d3e4f5a6b",
            IDEA_A,
            IDEA_B,
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
        tmp_path, [("claude", "a"), ("gpt", "a"), ("kimi", "a")]
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
        tmp_path, [("claude", "a"), ("gpt", "a"), ("kimi", "a")]
    )
    materials, judge_prompt_sha256, word_cap = write_full_materials(
        tmp_path / "materials", commitment
    )
    patch_report_judge_prompt_hash(votes_dir, judge_prompt_sha256, word_cap)
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


def test_stale_panel_refused_when_materials_edited_after_the_panel_ran(tmp_path):
    # The panel voted on one version of statement_a.md; the source materials
    # are then edited (a different sentence, but the hash-line, idea_node_id,
    # and the one anchor reference are all left intact -- exactly what the
    # PRE-EXISTING cross-check does not catch, because it only binds CURRENT
    # materials to the commitment and node id, never to what the judges
    # actually read). Assembly must refuse: this is precisely the gap the
    # content-binding rebuild-and-compare closes.
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("gpt", "a"), ("kimi", "a")]
    )
    materials, judge_prompt_sha256, word_cap = write_full_materials(
        tmp_path / "materials", commitment
    )
    patch_report_judge_prompt_hash(votes_dir, judge_prompt_sha256, word_cap)

    statement_a = materials / "statement_a.md"
    edited = statement_a.read_text(encoding="utf-8").replace(
        "Resolves the standing tension.",
        "Resolves the standing tension through a substantively different argument.",
    )
    assert edited != statement_a.read_text(encoding="utf-8")
    statement_a.write_text(edited, encoding="utf-8")

    with pytest.raises(assemble_match.MatchError, match="no longer rebuild the judge prompt"):
        assemble_match.assemble(
            commitment_path,
            votes_dir,
            campaign,
            CAMPAIGN_ID,
            IDEA_A,
            IDEA_B,
            materials_dir=materials,
        )


def test_placeholder_hash_is_refused_against_valid_unedited_materials(tmp_path):
    # Complementary to the edited-materials case above: materials_dir is
    # supplied and the materials on disk are entirely valid and unedited,
    # but the report was never actually rebuilt against them (it still
    # carries the placeholder judge_prompt_sha256 write_votes stamps by
    # default). The rebuild-and-compare must still refuse: a hash that was
    # never derived from these materials in the first place is exactly as
    # stale as one that was but no longer matches.
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("gpt", "a"), ("kimi", "a")]
    )
    materials, _judge_prompt_sha256, _word_cap = write_full_materials(
        tmp_path / "materials", commitment
    )
    # Deliberately do NOT call patch_report_judge_prompt_hash: the report
    # keeps write_votes' PLACEHOLDER_JUDGE_PROMPT_SHA256/PLACEHOLDER_WORD_CAP.
    with pytest.raises(assemble_match.MatchError, match="no longer rebuild the judge prompt"):
        assemble_match.assemble(
            commitment_path,
            votes_dir,
            campaign,
            CAMPAIGN_ID,
            IDEA_A,
            IDEA_B,
            materials_dir=materials,
        )


def test_assembly_requires_judge_prompt_sha256_and_word_cap_in_the_report(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path, [("claude", "a"), ("gpt", "a"), ("kimi", "a")]
    )
    report_path = votes_dir.parent / "panel_run_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))

    missing_hash = dict(report)
    del missing_hash["judge_prompt_sha256"]
    commit_criteria.write_json_atomic(report_path, missing_hash)
    with pytest.raises(assemble_match.MatchError, match="judge_prompt_sha256"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )

    missing_cap = dict(report)
    del missing_cap["word_cap"]
    commit_criteria.write_json_atomic(report_path, missing_cap)
    with pytest.raises(assemble_match.MatchError, match="word_cap"):
        assemble_match.assemble(
            commitment_path, votes_dir, campaign, CAMPAIGN_ID, IDEA_A, IDEA_B
        )


# ---------------------------------------------------------------------------
# Artifact validator, field by field
# ---------------------------------------------------------------------------

@pytest.fixture()
def valid_artifact(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path,
        [("claude", "a"), ("gpt", "a"), ("glm", "b"), ("kimi", "tie")],
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
        (lambda a: a.__setitem__("match_id", "XYZ"), "not an engine short id"),
        # The retired dashed-uuid convention must fail the engine pattern.
        (
            lambda a: a.__setitem__(
                "match_id", "4c9a2d10-7e5f-4b8a-9c3d-6e1f2a3b4c5d"
            ),
            "not an engine short id",
        ),
        # 8 lowercase chars, but i/l/o/u sit outside the Crockford alphabet.
        (lambda a: a.__setitem__("campaign_id", "abcdilou"), "not an engine short id"),
        # Right length, wrong case: the alphabet is lowercase-only.
        (lambda a: a.__setitem__("campaign_id", "ABCDEFGH"), "not an engine short id"),
        # Right alphabet, wrong length.
        (lambda a: a.__setitem__("idea_a_node_id", "1f6c9d5"), "not an engine short id"),
        # A trailing newline must fail: fullmatch keeps the Python validator as
        # strict as the engine-side JS regex, which `$`+re.match would not.
        (lambda a: a.__setitem__("idea_a_node_id", "1f6c9d5e\n"), "not an engine short id"),
        (lambda a: a.__setitem__("idea_b_node_id", IDEA_A), "equals"),
        (lambda a: a.__setitem__("extra", 1), "unknown top-level keys"),
        (
            lambda a: a["criteria_commitment"].__setitem__("criteria", ["x", "y"]),
            "does not match",
        ),
        (lambda a: a.__setitem__("panel", []), "non-empty array"),
        # Family labels are roster keys; the pattern rejects anything that
        # could not be one (uppercase, leading digit), not unfamiliar names.
        (
            lambda a: a["panel"][0].__setitem__("reviewer_family", "GPT"),
            "family label",
        ),
        # A trailing newline must fail: with re.match, the pattern's $ would
        # tolerate it while the engine-side JS regex rejects it.
        (
            lambda a: a["panel"][0].__setitem__("reviewer_family", "gpt\n"),
            "family label",
        ),
        (
            lambda a: a["panel"][1].__setitem__(
                "reviewer_family", a["panel"][0]["reviewer_family"]
            ),
            "more than once",
        ),
        (
            lambda a: a["panel"][0].__setitem__("seat", 1),
            "do not number seats",
        ),
        (
            lambda a: a.pop("panel_independence"),
            "missing top-level key: panel_independence",
        ),
        (
            lambda a: a["panel_independence"].__setitem__("mode", "mixed"),
            "mode must be one of",
        ),
        (
            lambda a: a["panel_independence"].__setitem__("families_present", []),
            "non-empty array",
        ),
        (
            lambda a: a["panel_independence"].__setitem__(
                "families_present", ["claude", "glm", "gpt"]
            ),
            "do not match",
        ),
        (
            lambda a: a["panel_independence"].__setitem__(
                "families_absent", [{"family": "gemini"}]
            ),
            "reason must be a non-empty string",
        ),
        (
            lambda a: a["panel_independence"]["families_absent"].append(
                {"family": a["panel"][0]["reviewer_family"], "reason": "also voted"}
            ),
            "both present and absent",
        ),
        (
            lambda a: a["panel_independence"].__setitem__("surprise", 1),
            "panel_independence has unknown keys",
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

def write_materials(materials_dir, commitment, nodes=None):
    """Write the two statements assemble_match needs for its mandatory
    materials cross-check and statement binding. nodes optionally overrides
    the {"a": ..., "b": ...} idea_node_id each side's statement declares
    (default IDEA_A/IDEA_B), for tests that need a deliberately wrong
    binding.
    """
    nodes = nodes or {"a": IDEA_A, "b": IDEA_B}
    materials_dir.mkdir(parents=True, exist_ok=True)
    for side in ("a", "b"):
        text = (
            "criteria_commitment: %s\n"
            "idea_node_id: %s\n\n"
            "# Advocacy statement: Idea %s\n\n"
            "## tension resolution\n\n"
            "Resolves the standing tension. "
            "[anchor: literature -> https://example.org/reference]\n"
            % (commitment["commitment_hash"], nodes[side], side.upper())
        )
        (materials_dir / ("statement_%s.md" % side)).write_text(text, encoding="utf-8")
    return materials_dir


def write_full_materials(materials_dir, commitment, word_cap=None, nodes=None):
    """Write a complete, load_materials-compatible materials directory (the
    two statements plus commitment.json and both card summaries, matching
    the same evidence reference the statements anchor to) and return
    (materials_dir, judge_prompt_sha256, word_cap): the exact hash a
    panel_run_report.json fixture must carry for read_panel_report's
    content-binding rebuild-and-compare to accept these materials.
    """
    word_cap = word_cap or PLACEHOLDER_WORD_CAP
    write_materials(materials_dir, commitment, nodes=nodes)
    commit_criteria.write_json_atomic(materials_dir / "commitment.json", commitment)
    for side in ("a", "b"):
        (materials_dir / ("card_summary_%s.md" % side)).write_text(
            "1. Placeholder card claim "
            "[support: literature; evidence: https://example.org/reference]\n",
            encoding="utf-8",
        )
    texts, loaded_commitment = run_panel.load_materials(materials_dir, word_cap=word_cap)
    prompt = run_panel.render_judge_prompt(texts, loaded_commitment)
    judge_prompt_sha256 = "sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    return materials_dir, judge_prompt_sha256, word_cap


def patch_report_judge_prompt_hash(votes_dir, judge_prompt_sha256, word_cap):
    """Overwrite judge_prompt_sha256/word_cap on an already-written
    panel_run_report.json, for tests that build materials AFTER standard_setup
    has already written a placeholder-hashed report."""
    report_path = votes_dir.parent / "panel_run_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["judge_prompt_sha256"] = judge_prompt_sha256
    report["word_cap"] = word_cap
    commit_criteria.write_json_atomic(report_path, report)


def test_cli_smoke(tmp_path):
    commitment_path, commitment, votes_dir, campaign = standard_setup(
        tmp_path,
        [("claude", "a"), ("gpt", "a"), ("glm", "b"), ("kimi", "tie")],
    )
    materials, judge_prompt_sha256, word_cap = write_full_materials(
        tmp_path / "materials", commitment
    )
    patch_report_judge_prompt_hash(votes_dir, judge_prompt_sha256, word_cap)
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
        [("claude", "a"), ("gpt", "a"), ("glm", "b")],
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
