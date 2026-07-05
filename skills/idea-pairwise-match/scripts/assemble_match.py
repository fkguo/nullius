#!/usr/bin/env python3
"""Tally the judge panel and write the pairwise_match_v1 artifact.

This script closes protocol Step 4: it re-verifies the integrity thread
(commitment hash on every vote, vote timestamps after the commitment,
distinct families, at least MIN_FAMILIES of them), computes the outcome,
validates the artifact field by field, and writes it to

    <campaign>/artifacts/matches/match-<match_id>.json

with observation_write.written = false. The belief layer flips that flag
when the observation is absorbed into the argument graph.

Rematch guard: if the campaign already holds a match for the same unordered
idea pair, assembling a new one requires --rationale (a new-evidence reason),
which is recorded in the artifact's optional "rationale" field.

The outcome-to-likelihood mapping below is the fixed shared table
(MAPPING_TABLE_TEXT); the identical text appears in SKILL.md and a test keeps
the two copies byte-for-byte in sync.

Standard library only. Python >= 3.9.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import commit_criteria  # noqa: E402
import run_panel  # noqa: E402

MIN_FAMILIES = run_panel.MIN_FAMILIES
FAMILIES = run_panel.FAMILIES
VOTE_VALUES = run_panel.VOTE_VALUES
ANCHOR_TYPES = run_panel.ANCHOR_TYPES

MAPPING_TABLE_TEXT = """\
Fixed vote-outcome to likelihood-tier mapping, shared verbatim between this
skill and the belief-layer skill (idea-posterior); never edit one copy alone.

- Unanimous win: at least 3 valid votes were cast and the losing idea
  received zero votes. Maps to likelihood tier 10. Individual "tie" votes
  count toward the valid-vote total and are not votes for the losing idea,
  so a win with some tie votes but zero opposing votes is still unanimous.
- Split win: a majority winner exists and the losing idea received at least
  one vote. Maps to likelihood tier 3.
- Tie: equal vote counts for the two ideas. No observation is produced.

Direction is symmetric: one match yields one observation; "the winner's
worth rises" and "the loser's worth falls" are the same observation stated
two ways, absorbed once, never double-counted.

Why the tiers stop at 10: the tiers are Jeffreys-style Bayes-factor grades
(3 / 10 / 30). A single pairwise match is capped at the substantial grade
(10) and never earns the strong grade (30), so that one panel's votes cannot
overwhelm the literature and computation anchors accumulated in the argument
graph. The cap is part of the honesty discipline on evidence weights.
"""

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

PANEL_ENTRY_KEYS = {
    "reviewer_family",
    "model",
    "vote",
    "anchored_arguments",
    "unanchored_arguments_discarded",
}
ARGUMENT_KEYS = {"argument", "anchor_type", "anchor_ref"}
OUTCOME_KEYS = {"winner", "vote_margin", "decided_at"}
TOP_REQUIRED_KEYS = {
    "match_id",
    "campaign_id",
    "idea_a_node_id",
    "idea_b_node_id",
    "criteria_commitment",
    "panel",
    "outcome",
    "observation_write",
}
TOP_OPTIONAL_KEYS = {"rationale"}

MARGIN_TOLERANCE = 1e-9


class MatchError(RuntimeError):
    """Raised for protocol violations that must stop assembly."""


# ---------------------------------------------------------------------------
# Tally and observation mapping
# ---------------------------------------------------------------------------

def tally_votes(votes):
    """Compute the outcome from a list of vote values ("a" / "b" / "tie")."""
    votes_a = sum(1 for vote in votes if vote == "a")
    votes_b = sum(1 for vote in votes if vote == "b")
    ties = sum(1 for vote in votes if vote == "tie")
    n_valid = len(votes)
    if n_valid == 0:
        raise MatchError("cannot tally an empty vote list")
    if votes_a + votes_b + ties != n_valid:
        raise MatchError("vote list contains values outside a/b/tie")
    if votes_a > votes_b:
        winner = "a"
    elif votes_b > votes_a:
        winner = "b"
    else:
        winner = "tie"
    return {
        "votes_a": votes_a,
        "votes_b": votes_b,
        "ties": ties,
        "n_valid": n_valid,
        "winner": winner,
        "vote_margin": abs(votes_a - votes_b) / n_valid,
    }


def observation_tier(tally):
    """Map a tally to (tier, label) per MAPPING_TABLE_TEXT.

    tier is 10, 3, or None (None = no observation, for a tie). The mapping is
    defined only for a valid panel; an invalid panel never reaches the belief
    layer, so mapping it would be meaningless.
    """
    if tally["n_valid"] < MIN_FAMILIES:
        raise MatchError(
            "observation mapping is defined only for a valid panel "
            "(>= %d votes); got %d" % (MIN_FAMILIES, tally["n_valid"])
        )
    if tally["winner"] == "tie":
        return None, "tie: no observation is produced"
    loser_votes = tally["votes_b"] if tally["winner"] == "a" else tally["votes_a"]
    if loser_votes == 0 and tally["n_valid"] >= MIN_FAMILIES:
        return 10, "unanimous win: likelihood tier 10"
    return 3, "split win: likelihood tier 3"


# ---------------------------------------------------------------------------
# Artifact validation (hand-rolled, field by field)
# ---------------------------------------------------------------------------

def _is_uuid(value):
    return isinstance(value, str) and bool(UUID_RE.match(value))


def _check_timestamp(errors, label, value):
    try:
        return commit_criteria.parse_rfc3339(value)
    except ValueError as exc:
        errors.append("%s is invalid: %s" % (label, exc))
        return None


def validate_pairwise_match(obj):
    """Validate a pairwise_match_v1 object. Returns a list of problems."""
    errors = []
    if not isinstance(obj, dict):
        return ["artifact is not a JSON object"]

    unknown = sorted(set(obj) - TOP_REQUIRED_KEYS - TOP_OPTIONAL_KEYS)
    if unknown:
        errors.append("unknown top-level keys: %s" % ", ".join(unknown))
    for key in sorted(TOP_REQUIRED_KEYS - set(obj)):
        errors.append("missing top-level key: %s" % key)

    for key in ("match_id", "campaign_id", "idea_a_node_id", "idea_b_node_id"):
        if key in obj and not _is_uuid(obj[key]):
            errors.append("%s is not a lowercase dashed uuid" % key)
    if (
        _is_uuid(obj.get("idea_a_node_id"))
        and obj.get("idea_a_node_id") == obj.get("idea_b_node_id")
    ):
        errors.append("idea_a_node_id equals idea_b_node_id")

    committed_at = None
    if "criteria_commitment" in obj:
        problems = commit_criteria.validate_commitment(obj["criteria_commitment"])
        errors.extend(problems)
        if not problems:
            committed_at = commit_criteria.parse_rfc3339(
                obj["criteria_commitment"]["committed_at"]
            )

    panel_votes = []
    if "panel" in obj:
        panel = obj["panel"]
        if not isinstance(panel, list) or not panel:
            errors.append("panel must be a non-empty array")
        else:
            seen_families = []
            for index, entry in enumerate(panel):
                where = "panel[%d]" % index
                if not isinstance(entry, dict):
                    errors.append("%s is not an object" % where)
                    continue
                unknown_entry = sorted(set(entry) - PANEL_ENTRY_KEYS)
                if unknown_entry:
                    errors.append(
                        "%s has unknown keys: %s" % (where, ", ".join(unknown_entry))
                    )
                for key in sorted(PANEL_ENTRY_KEYS - set(entry)):
                    errors.append("%s is missing key: %s" % (where, key))
                family = entry.get("reviewer_family")
                if family not in FAMILIES:
                    errors.append(
                        "%s.reviewer_family must be one of %s"
                        % (where, ", ".join(FAMILIES))
                    )
                elif family in seen_families:
                    errors.append(
                        "%s.reviewer_family %r appears more than once (one vote "
                        "per family)" % (where, family)
                    )
                else:
                    seen_families.append(family)
                model = entry.get("model")
                if not isinstance(model, str) or not model.strip():
                    errors.append("%s.model must be a non-empty string" % where)
                vote = entry.get("vote")
                if vote not in VOTE_VALUES:
                    errors.append(
                        "%s.vote must be one of %s" % (where, ", ".join(VOTE_VALUES))
                    )
                else:
                    panel_votes.append(vote)
                arguments = entry.get("anchored_arguments")
                if not isinstance(arguments, list):
                    errors.append("%s.anchored_arguments must be an array" % where)
                else:
                    for arg_index, argument in enumerate(arguments):
                        arg_where = "%s.anchored_arguments[%d]" % (where, arg_index)
                        if not isinstance(argument, dict):
                            errors.append("%s is not an object" % arg_where)
                            continue
                        unknown_arg = sorted(set(argument) - ARGUMENT_KEYS)
                        if unknown_arg:
                            errors.append(
                                "%s has unknown keys: %s"
                                % (arg_where, ", ".join(unknown_arg))
                            )
                        for key in ("argument", "anchor_ref"):
                            value = argument.get(key)
                            if not isinstance(value, str) or not value.strip():
                                errors.append(
                                    "%s.%s must be a non-empty string" % (arg_where, key)
                                )
                        if argument.get("anchor_type") not in ANCHOR_TYPES:
                            errors.append(
                                "%s.anchor_type must be one of %s"
                                % (arg_where, ", ".join(ANCHOR_TYPES))
                            )
                discarded = entry.get("unanchored_arguments_discarded")
                if isinstance(discarded, bool) or not isinstance(discarded, int) or discarded < 0:
                    errors.append(
                        "%s.unanchored_arguments_discarded must be an integer >= 0"
                        % where
                    )
            if len(seen_families) < MIN_FAMILIES:
                errors.append(
                    "panel has %d distinct families; a valid match needs at "
                    "least %d" % (len(seen_families), MIN_FAMILIES)
                )

    decided_at = None
    if "outcome" in obj:
        outcome = obj["outcome"]
        if not isinstance(outcome, dict):
            errors.append("outcome is not an object")
        else:
            unknown_outcome = sorted(set(outcome) - OUTCOME_KEYS)
            if unknown_outcome:
                errors.append(
                    "outcome has unknown keys: %s" % ", ".join(unknown_outcome)
                )
            for key in sorted(OUTCOME_KEYS - set(outcome)):
                errors.append("outcome is missing key: %s" % key)
            winner = outcome.get("winner")
            if winner not in VOTE_VALUES:
                errors.append("outcome.winner must be one of %s" % ", ".join(VOTE_VALUES))
            margin = outcome.get("vote_margin")
            if isinstance(margin, bool) or not isinstance(margin, (int, float)):
                errors.append("outcome.vote_margin must be a number")
            elif not 0.0 <= float(margin) <= 1.0:
                errors.append("outcome.vote_margin must lie in [0, 1]")
            if "decided_at" in outcome:
                decided_at = _check_timestamp(errors, "outcome.decided_at", outcome["decided_at"])
            # Cross-check the recorded outcome against the recorded panel.
            if panel_votes and winner in VOTE_VALUES:
                recomputed = tally_votes(panel_votes)
                if recomputed["winner"] != winner:
                    errors.append(
                        "outcome.winner %r does not match the panel tally %r"
                        % (winner, recomputed["winner"])
                    )
                if isinstance(margin, (int, float)) and not isinstance(margin, bool):
                    if abs(float(margin) - recomputed["vote_margin"]) > MARGIN_TOLERANCE:
                        errors.append(
                            "outcome.vote_margin %r does not match the panel tally %r"
                            % (margin, recomputed["vote_margin"])
                        )

    if committed_at is not None and decided_at is not None and decided_at < committed_at:
        errors.append("outcome.decided_at precedes criteria_commitment.committed_at")

    if "observation_write" in obj:
        observation = obj["observation_write"]
        if not isinstance(observation, dict):
            errors.append("observation_write is not an object")
        else:
            unknown_obs = sorted(set(observation) - {"written", "gaia_package_ref"})
            if unknown_obs:
                errors.append(
                    "observation_write has unknown keys: %s" % ", ".join(unknown_obs)
                )
            if not isinstance(observation.get("written"), bool):
                errors.append("observation_write.written must be a boolean")
            if "gaia_package_ref" in observation:
                ref = observation["gaia_package_ref"]
                if not isinstance(ref, str) or not ref.strip():
                    errors.append(
                        "observation_write.gaia_package_ref must be a non-empty string"
                    )

    if "rationale" in obj:
        rationale = obj["rationale"]
        if not isinstance(rationale, str) or not rationale.strip():
            errors.append("rationale, when present, must be a non-empty string")

    return errors


# ---------------------------------------------------------------------------
# Vote-record loading (run_panel wrapper files)
# ---------------------------------------------------------------------------

def load_vote_records(votes_dir, commitment):
    """Load votes/*.json wrappers and re-verify the integrity thread."""
    votes_dir = Path(votes_dir)
    paths = sorted(votes_dir.glob("*.json"))
    if not paths:
        raise MatchError("no vote files found in %s" % votes_dir)
    committed_at = commit_criteria.parse_rfc3339(commitment["committed_at"])
    records = []
    seen_families = set()
    for path in paths:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise MatchError("%s is not valid JSON: %s" % (path, exc))
        family = record.get("reviewer_family")
        if family not in FAMILIES:
            raise MatchError("%s: reviewer_family must be one of %s" % (path, ", ".join(FAMILIES)))
        if family in seen_families:
            raise MatchError(
                "duplicate vote for family %r (%s); one vote per family" % (family, path)
            )
        seen_families.add(family)
        model = record.get("model")
        if not isinstance(model, str) or not model.strip():
            raise MatchError("%s: model must be a non-empty string" % path)
        problems = run_panel.validate_vote_payload(record)
        if problems:
            raise MatchError("%s: %s" % (path, "; ".join(problems)))
        if record.get("commitment_hash") != commitment["commitment_hash"]:
            raise MatchError(
                "%s: vote is stamped with %r, expected the committed %s; the "
                "criteria commitment thread is broken"
                % (path, record.get("commitment_hash"), commitment["commitment_hash"])
            )
        collected_at = record.get("collected_at")
        try:
            collected = commit_criteria.parse_rfc3339(collected_at)
        except ValueError as exc:
            raise MatchError("%s: collected_at is invalid: %s" % (path, exc))
        if collected < committed_at:
            raise MatchError(
                "%s: vote collected at %s, before the commitment at %s; stage "
                "order violated" % (path, collected_at, commitment["committed_at"])
            )
        records.append(record)
    if len(records) < MIN_FAMILIES:
        raise MatchError(
            "only %d family votes present (minimum %d); the panel is invalid "
            "and no artifact is written" % (len(records), MIN_FAMILIES)
        )
    # Canonical family order for a deterministic artifact.
    records.sort(key=lambda rec: FAMILIES.index(rec["reviewer_family"]))
    return records


def cross_check_materials(materials_dir, commitment, idea_a, idea_b):
    """Optional extra thread: statements carry the committed hash and the
    node ids they argue for; verify both against the assembly arguments."""
    materials_dir = Path(materials_dir)
    node_line_re = re.compile(r"^idea_node_id:\s*(\S+)\s*$")
    for side, expected_node in (("a", idea_a), ("b", idea_b)):
        path = materials_dir / ("statement_%s.md" % side)
        if not path.is_file():
            raise MatchError("materials cross-check: %s is missing" % path)
        text = path.read_text(encoding="utf-8")
        declared_hash = run_panel.statement_hash_line(text)
        if declared_hash != commitment["commitment_hash"]:
            raise MatchError(
                "materials cross-check: %s declares hash %r, expected %s"
                % (path, declared_hash, commitment["commitment_hash"])
            )
        node_id = None
        for line in text.splitlines():
            match = node_line_re.match(line.strip())
            if match:
                node_id = match.group(1)
                break
        if node_id != expected_node:
            raise MatchError(
                "materials cross-check: %s argues for node %r, but the match "
                "is being assembled for %r" % (path, node_id, expected_node)
            )


def find_existing_match(campaign_dir, idea_a, idea_b):
    """Return the path of an existing artifact for the same unordered pair."""
    matches_dir = Path(campaign_dir) / "artifacts" / "matches"
    if not matches_dir.is_dir():
        return None
    wanted = frozenset((idea_a, idea_b))
    for path in sorted(matches_dir.glob("match-*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        pair = frozenset(
            (data.get("idea_a_node_id"), data.get("idea_b_node_id"))
        )
        if pair == wanted:
            return path
    return None


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def assemble(
    commitment_path,
    votes_dir,
    campaign_dir,
    campaign_id,
    idea_a,
    idea_b,
    match_id=None,
    rationale=None,
    materials_dir=None,
    decided_at=None,
):
    """Assemble, validate, and write the pairwise_match_v1 artifact.

    Returns (artifact_path, artifact, tier, tier_label).
    Raises MatchError on any protocol violation.
    """
    commitment = json.loads(Path(commitment_path).read_text(encoding="utf-8"))
    problems = commit_criteria.validate_commitment(commitment)
    if problems:
        raise MatchError("commitment failed validation: " + "; ".join(problems))

    for label, value in (("campaign_id", campaign_id), ("idea_a", idea_a), ("idea_b", idea_b)):
        if not _is_uuid(value):
            raise MatchError("%s is not a lowercase dashed uuid: %r" % (label, value))
    if idea_a == idea_b:
        raise MatchError("idea_a and idea_b are the same node")

    if match_id is None:
        match_id = str(uuid.uuid4())
    elif not _is_uuid(match_id):
        raise MatchError("match_id is not a lowercase dashed uuid: %r" % match_id)

    if materials_dir is not None:
        cross_check_materials(materials_dir, commitment, idea_a, idea_b)

    records = load_vote_records(votes_dir, commitment)

    existing = find_existing_match(campaign_dir, idea_a, idea_b)
    if existing is not None and not rationale:
        raise MatchError(
            "this idea pair already has a match artifact (%s); a rematch "
            "requires --rationale stating the new evidence that justifies it"
            % existing
        )

    tally = tally_votes([record["vote"] for record in records])
    tier, tier_label = observation_tier(tally)

    panel = [
        {
            "reviewer_family": record["reviewer_family"],
            "model": record["model"],
            "vote": record["vote"],
            "anchored_arguments": record["anchored_arguments"],
            "unanchored_arguments_discarded": record["unanchored_arguments_discarded"],
        }
        for record in records
    ]

    artifact = {
        "match_id": match_id,
        "campaign_id": campaign_id,
        "idea_a_node_id": idea_a,
        "idea_b_node_id": idea_b,
        "criteria_commitment": commitment,
        "panel": panel,
        "outcome": {
            "winner": tally["winner"],
            "vote_margin": tally["vote_margin"],
            "decided_at": decided_at or commit_criteria.utc_now_iso(),
        },
        "observation_write": {"written": False},
    }
    if rationale:
        artifact["rationale"] = rationale

    problems = validate_pairwise_match(artifact)
    if problems:
        raise MatchError(
            "assembled artifact failed validation: " + "; ".join(problems)
        )

    matches_dir = Path(campaign_dir) / "artifacts" / "matches"
    artifact_path = matches_dir / ("match-%s.json" % match_id)
    if artifact_path.exists():
        raise MatchError("artifact already exists: %s" % artifact_path)
    commit_criteria.write_json_atomic(artifact_path, artifact)
    return artifact_path, artifact, tier, tier_label


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Tally panel votes and write the pairwise_match_v1 artifact."
    )
    parser.add_argument("--commitment", required=True, type=Path)
    parser.add_argument("--votes-dir", required=True, type=Path)
    parser.add_argument("--campaign-dir", required=True, type=Path)
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument("--idea-a", required=True, help="node_id of idea A")
    parser.add_argument("--idea-b", required=True, help="node_id of idea B")
    parser.add_argument("--match-id", default=None)
    parser.add_argument(
        "--rationale",
        default=None,
        help="Required for a rematch of an already-matched pair: the new "
        "evidence that justifies running it again.",
    )
    parser.add_argument(
        "--materials-dir",
        type=Path,
        default=None,
        help="Optional: cross-check statement hash lines and node ids.",
    )
    args = parser.parse_args(argv)

    try:
        artifact_path, artifact, tier, tier_label = assemble(
            args.commitment,
            args.votes_dir,
            args.campaign_dir,
            args.campaign_id,
            args.idea_a,
            args.idea_b,
            match_id=args.match_id,
            rationale=args.rationale,
            materials_dir=args.materials_dir,
        )
    except MatchError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2

    outcome = artifact["outcome"]
    for entry in artifact["panel"]:
        print(
            "vote: %s (%s) -> %s, %d anchored arguments credited, %d unanchored discarded"
            % (
                entry["reviewer_family"],
                entry["model"],
                entry["vote"],
                len(entry["anchored_arguments"]),
                entry["unanchored_arguments_discarded"],
            )
        )
    print("winner: %s (vote_margin %.4f)" % (outcome["winner"], outcome["vote_margin"]))
    print("observation: %s" % tier_label)
    print("artifact: %s" % artifact_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
