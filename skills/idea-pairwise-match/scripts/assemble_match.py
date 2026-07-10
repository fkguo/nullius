#!/usr/bin/env python3
"""Tally the judge panel and write the pairwise_match_v1 artifact.

This script closes protocol Step 4: it re-verifies the integrity thread
(commitment hash on every vote, vote timestamps after the commitment, and
the panel composition against the run report: at least MIN_FAMILIES distinct
families on a cross-family panel, or at least MIN_FAMILIES numbered seats of
the one native family on a degraded single-family panel), computes the
outcome, validates the artifact field by field, and writes it to

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
import hashlib
import json
import re
import secrets
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import commit_criteria  # noqa: E402
import run_panel  # noqa: E402

MIN_FAMILIES = run_panel.MIN_FAMILIES
FAMILY_LABEL_RE = run_panel.FAMILY_LABEL_RE
INDEPENDENCE_MODES = run_panel.INDEPENDENCE_MODES
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

# Engine short-id convention for handle ids (match_id, campaign_id, node ids):
# 8 chars of lowercase Crockford base32 — digits + lowercase letters excluding
# i/l/o/u. This is the exact alphabet and length pinned by the engine contracts
# (pairwise_match_v1 / idea_node_v1 schemas) and packages/shared/src/short-id.ts;
# never widen or substitute it here alone.
SHORT_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
SHORT_ID_LENGTH = 8
SHORT_ID_RE = re.compile(r"^[%s]{%d}$" % (SHORT_ID_ALPHABET, SHORT_ID_LENGTH))

PANEL_ENTRY_KEYS = {
    "reviewer_family",
    "model",
    "vote",
    "anchored_arguments",
    "unanchored_arguments_discarded",
}
# A single-family (native subagent) panel numbers its seats; a cross-family
# panel must not carry the key at all.
PANEL_ENTRY_OPTIONAL_KEYS = {"seat"}
ARGUMENT_KEYS = {"argument", "anchor_type", "anchor_ref"}
OUTCOME_KEYS = {"winner", "vote_margin", "decided_at"}
PANEL_INDEPENDENCE_KEYS = {"mode", "families_present", "families_absent"}
ABSENT_ENTRY_KEYS = {"family", "reason"}
TOP_REQUIRED_KEYS = {
    "match_id",
    "campaign_id",
    "idea_a_node_id",
    "idea_b_node_id",
    "criteria_commitment",
    "panel",
    "panel_independence",
    "independent_runners",
    "outcome",
    "observation_write",
}
TOP_OPTIONAL_KEYS = {"rationale", "statement_binding"}
STATEMENT_BINDING_SIDE_KEYS = {"idea_node_id", "content_sha256"}

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

def _is_short_id(value):
    # fullmatch: with re.match, the pattern's `$` would tolerate one trailing
    # newline that the engine-side JS regex rejects; stay exactly as strict.
    return isinstance(value, str) and bool(SHORT_ID_RE.fullmatch(value))


def mint_short_id():
    """Mint an engine-convention short id: SHORT_ID_LENGTH chars drawn
    uniformly from SHORT_ID_ALPHABET with a CSPRNG (stdlib secrets)."""
    return "".join(
        secrets.choice(SHORT_ID_ALPHABET) for _ in range(SHORT_ID_LENGTH)
    )


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
        if key in obj and not _is_short_id(obj[key]):
            errors.append(
                "%s is not an engine short id (%s)" % (key, SHORT_ID_RE.pattern)
            )
    if (
        _is_short_id(obj.get("idea_a_node_id"))
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

    # panel_independence is validated before the panel because the panel's
    # diversity rules depend on its mode.
    independence_mode = None
    families_present = None
    if "panel_independence" in obj:
        block = obj["panel_independence"]
        if not isinstance(block, dict):
            errors.append("panel_independence is not an object")
        else:
            unknown_block = sorted(set(block) - PANEL_INDEPENDENCE_KEYS)
            if unknown_block:
                errors.append(
                    "panel_independence has unknown keys: %s"
                    % ", ".join(unknown_block)
                )
            for key in sorted(PANEL_INDEPENDENCE_KEYS - set(block)):
                errors.append("panel_independence is missing key: %s" % key)
            mode = block.get("mode")
            if "mode" in block:
                if mode not in INDEPENDENCE_MODES:
                    errors.append(
                        "panel_independence.mode must be one of %s"
                        % ", ".join(INDEPENDENCE_MODES)
                    )
                else:
                    independence_mode = mode
            present = block.get("families_present")
            if "families_present" in block:
                if not isinstance(present, list) or not present:
                    errors.append(
                        "panel_independence.families_present must be a non-empty array"
                    )
                elif not all(
                    isinstance(f, str) and FAMILY_LABEL_RE.fullmatch(f) for f in present
                ):
                    errors.append(
                        "panel_independence.families_present entries must be family "
                        "labels matching %s" % FAMILY_LABEL_RE.pattern
                    )
                elif len(set(present)) != len(present):
                    errors.append(
                        "panel_independence.families_present lists a family twice"
                    )
                else:
                    families_present = present
            absent = block.get("families_absent")
            if "families_absent" in block:
                if not isinstance(absent, list):
                    errors.append(
                        "panel_independence.families_absent must be an array"
                    )
                else:
                    absent_families = []
                    for a_index, item in enumerate(absent):
                        a_where = "panel_independence.families_absent[%d]" % a_index
                        if not isinstance(item, dict):
                            errors.append("%s is not an object" % a_where)
                            continue
                        unknown_item = sorted(set(item) - ABSENT_ENTRY_KEYS)
                        if unknown_item:
                            errors.append(
                                "%s has unknown keys: %s"
                                % (a_where, ", ".join(unknown_item))
                            )
                        family = item.get("family")
                        if not isinstance(family, str) or not FAMILY_LABEL_RE.fullmatch(family):
                            errors.append(
                                "%s.family must be a family label matching %s"
                                % (a_where, FAMILY_LABEL_RE.pattern)
                            )
                        else:
                            absent_families.append(family)
                        reason = item.get("reason")
                        if not isinstance(reason, str) or not reason.strip():
                            errors.append("%s.reason must be a non-empty string" % a_where)
                    if families_present is not None:
                        overlap = sorted(set(absent_families) & set(families_present))
                        if overlap:
                            errors.append(
                                "panel_independence lists %s as both present and "
                                "absent" % ", ".join(overlap)
                            )

    panel_votes = []
    if "panel" in obj:
        panel = obj["panel"]
        if not isinstance(panel, list) or not panel:
            errors.append("panel must be a non-empty array")
        else:
            entry_families = []
            entry_seats = []
            for index, entry in enumerate(panel):
                where = "panel[%d]" % index
                if not isinstance(entry, dict):
                    errors.append("%s is not an object" % where)
                    continue
                unknown_entry = sorted(
                    set(entry) - PANEL_ENTRY_KEYS - PANEL_ENTRY_OPTIONAL_KEYS
                )
                if unknown_entry:
                    errors.append(
                        "%s has unknown keys: %s" % (where, ", ".join(unknown_entry))
                    )
                for key in sorted(PANEL_ENTRY_KEYS - set(entry)):
                    errors.append("%s is missing key: %s" % (where, key))
                family = entry.get("reviewer_family")
                if not isinstance(family, str) or not FAMILY_LABEL_RE.fullmatch(family):
                    errors.append(
                        "%s.reviewer_family must be a family label matching %s"
                        % (where, FAMILY_LABEL_RE.pattern)
                    )
                else:
                    entry_families.append(family)
                if "seat" in entry:
                    seat = entry["seat"]
                    if isinstance(seat, bool) or not isinstance(seat, int) or seat < 1:
                        errors.append("%s.seat must be an integer >= 1" % where)
                    else:
                        entry_seats.append((index, seat))
                else:
                    entry_seats.append((index, None))
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

            if independence_mode == "cross_family":
                seen = set()
                for family in entry_families:
                    if family in seen:
                        errors.append(
                            "reviewer_family %r appears more than once (one vote "
                            "per family on a cross-family panel)" % family
                        )
                    seen.add(family)
                if len(seen) < MIN_FAMILIES:
                    errors.append(
                        "panel has %d distinct families; a valid match needs at "
                        "least %d" % (len(seen), MIN_FAMILIES)
                    )
                for index, seat in entry_seats:
                    if seat is not None:
                        errors.append(
                            "panel[%d] carries a seat number; cross-family "
                            "panels do not number seats" % index
                        )
                if families_present is not None and seen != set(families_present):
                    errors.append(
                        "panel families %s do not match "
                        "panel_independence.families_present %s"
                        % (sorted(seen), sorted(families_present))
                    )
            elif independence_mode == "single_family":
                if len(panel) < MIN_FAMILIES:
                    errors.append(
                        "a single-family panel has %d seats; a valid degraded "
                        "match needs at least %d" % (len(panel), MIN_FAMILIES)
                    )
                if len(set(entry_families)) > 1:
                    errors.append(
                        "a single-family panel mixes families %s"
                        % sorted(set(entry_families))
                    )
                if families_present is not None and entry_families:
                    if set(entry_families) != set(families_present) or len(families_present) != 1:
                        errors.append(
                            "panel_independence.families_present %s does not "
                            "match the single panel family %s"
                            % (sorted(families_present), sorted(set(entry_families)))
                        )
                seats_seen = set()
                for index, seat in entry_seats:
                    if seat is None:
                        errors.append(
                            "panel[%d] is missing its seat number; single-family "
                            "seats must be numbered" % index
                        )
                    elif seat in seats_seen:
                        errors.append(
                            "panel seat %d appears more than once" % seat
                        )
                    else:
                        seats_seen.add(seat)

    if "independent_runners" in obj and not isinstance(obj["independent_runners"], bool):
        errors.append("independent_runners must be a boolean")
    if independence_mode == "single_family" and obj.get("independent_runners") is True:
        errors.append(
            "a single_family panel cannot record independent_runners=true; "
            "native subagent seats are never independent runners"
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

    if "statement_binding" in obj:
        binding = obj["statement_binding"]
        if not isinstance(binding, dict):
            errors.append("statement_binding is not an object")
        else:
            unknown_sides = sorted(set(binding) - {"a", "b"})
            if unknown_sides:
                errors.append(
                    "statement_binding has unknown sides: %s" % ", ".join(unknown_sides)
                )
            for side, expected_node_key in (("a", "idea_a_node_id"), ("b", "idea_b_node_id")):
                if side not in binding:
                    errors.append("statement_binding is missing side %r" % side)
                    continue
                entry = binding[side]
                if not isinstance(entry, dict):
                    errors.append("statement_binding.%s is not an object" % side)
                    continue
                unknown_bk = sorted(set(entry) - STATEMENT_BINDING_SIDE_KEYS)
                if unknown_bk:
                    errors.append(
                        "statement_binding.%s has unknown keys: %s"
                        % (side, ", ".join(unknown_bk))
                    )
                node = entry.get("idea_node_id")
                if node != obj.get(expected_node_key):
                    errors.append(
                        "statement_binding.%s.idea_node_id %r does not match %s"
                        % (side, node, expected_node_key)
                    )
                sha = entry.get("content_sha256")
                if not isinstance(sha, str) or not re.match(r"^sha256:[0-9a-f]{64}$", sha or ""):
                    errors.append(
                        "statement_binding.%s.content_sha256 must be sha256:<64 hex>"
                        % side
                    )

    return errors


# ---------------------------------------------------------------------------
# Vote-record loading (run_panel wrapper files)
# ---------------------------------------------------------------------------

def load_vote_records(votes_dir, commitment, report):
    """Load the vote files the panel run report names and re-verify the
    integrity thread.

    The report's votes_collected map is the run's own manifest of the votes
    it wrote: loading exactly those files (and refusing when the votes
    directory holds any other vote file) keeps a stale vote from an earlier
    run in the same directory out of the artifact. The diversity rules depend
    on the report's composition record: a cross-family panel takes one vote
    per distinct family and no seat numbers; a single-family (degraded native
    subagent) panel takes numbered, distinct seats that all belong to the
    report's single present family. The vote floor is the report's own
    min_families (never below the protocol floor MIN_FAMILIES).
    """
    votes_dir = Path(votes_dir)
    independence_mode = report["independence"]
    families_present = report["families_present"]
    # Vote paths in the report are relative to the panel directory (the
    # parent of votes/), e.g. "votes/claude.json", and must stay inside the
    # votes directory: a manifest entry that is absolute, climbs upward, or
    # resolves elsewhere (a symlink) would let a malformed report import a
    # vote file from outside the panel.
    panel_dir = votes_dir.parent
    votes_root = votes_dir.resolve()
    paths = []
    for key in sorted(report["votes_collected"]):
        rel = Path(report["votes_collected"][key])
        if rel.is_absolute() or ".." in rel.parts:
            raise MatchError(
                "panel run report names a vote path that escapes the panel "
                "directory: %r" % str(rel)
            )
        path = panel_dir / rel
        if not path.is_file():
            raise MatchError(
                "vote file %s is named by the panel run report but missing "
                "on disk" % path
            )
        if not path.resolve().is_relative_to(votes_root):
            raise MatchError(
                "vote file %s resolves outside the votes directory %s; a "
                "vote must live inside the panel that produced it"
                % (path, votes_dir)
            )
        paths.append(path)
    listed = {path.resolve() for path in paths}
    stray = [
        path for path in sorted(votes_dir.glob("*.json"))
        if path.resolve() not in listed
    ]
    if stray:
        raise MatchError(
            "vote files not named by the panel run report: %s; a stale or "
            "foreign vote never enters an artifact — clean the panel "
            "directory or assemble from the matching report"
            % ", ".join(str(path) for path in stray)
        )
    committed_at = commit_criteria.parse_rfc3339(commitment["committed_at"])
    records = []
    seen_families = set()
    seen_seats = set()
    for path in paths:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise MatchError("%s is not valid JSON: %s" % (path, exc))
        family = record.get("reviewer_family")
        if not isinstance(family, str) or not FAMILY_LABEL_RE.fullmatch(family):
            raise MatchError(
                "%s: reviewer_family must be a family label matching %s"
                % (path, FAMILY_LABEL_RE.pattern)
            )
        if independence_mode == "cross_family":
            if "seat" in record:
                raise MatchError(
                    "%s carries a seat number, but the panel run report says "
                    "this was a cross-family panel" % path
                )
            if family in seen_families:
                raise MatchError(
                    "duplicate vote for family %r (%s); one vote per family"
                    % (family, path)
                )
        else:
            if family != families_present[0]:
                raise MatchError(
                    "%s: vote from family %r, but the single-family panel "
                    "belongs to %r" % (path, family, families_present[0])
                )
            seat = record.get("seat")
            if isinstance(seat, bool) or not isinstance(seat, int) or seat < 1:
                raise MatchError(
                    "%s: a single-family seat vote must carry an integer "
                    "seat >= 1" % path
                )
            if seat in seen_seats:
                raise MatchError(
                    "duplicate seat %d (%s); one vote per seat" % (seat, path)
                )
            seen_seats.add(seat)
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
    floor = max(MIN_FAMILIES, report["min_families"])
    if len(records) < floor:
        raise MatchError(
            "only %d votes present (minimum %d); the panel is invalid "
            "and no artifact is written" % (len(records), floor)
        )
    if seen_families != set(families_present):
        raise MatchError(
            "vote families %s do not match the panel run report's "
            "families_present %s"
            % (sorted(seen_families), sorted(families_present))
        )
    # Canonical order for a deterministic artifact: family label, then seat.
    if independence_mode == "cross_family":
        records.sort(key=lambda rec: rec["reviewer_family"])
    else:
        records.sort(key=lambda rec: rec["seat"])
    return records


def cross_check_materials(materials_dir, commitment, idea_a, idea_b):
    """Verify each statement carries the committed hash and the node id it
    argues for, and return the statement binding: per-side node id and a
    sha256 over the on-disk statement content. That content is the sole source
    from which run_panel deterministically rebuilds the text the judges read,
    so hashing it pins the judge input to an auditable origin. The binding is
    embedded in the artifact so the judge inputs are an auditable part of the
    record, not just a check that happened at assembly time and left no trace.
    """
    materials_dir = Path(materials_dir)
    node_line_re = re.compile(r"^idea_node_id:\s*(\S+)\s*$")
    binding = {}
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
        content_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        binding[side] = {
            "idea_node_id": node_id,
            "content_sha256": "sha256:" + content_sha,
        }
    return {"a": binding["a"], "b": binding["b"]}


def read_panel_report(votes_dir):
    """Read the panel composition record from the run report next to the votes.

    run_panel.py writes panel_run_report.json in the panel directory (the
    parent of votes/). Four of its fields are carried into the artifact so a
    low-diversity panel is visible in the artifact itself, not only in a side
    file: independent_runners (false for a stub-backed or single-command
    panel), independence ("cross_family" or "single_family"), the families
    that voted, and the absent families with their reasons. All four are
    required; a report that is missing or malformed stops assembly, because an
    artifact that silently omitted the composition record could hide a
    stub-backed or degraded panel.
    """
    report_path = Path(votes_dir).parent / "panel_run_report.json"
    if not report_path.is_file():
        raise MatchError(
            "panel run report not found next to the votes (%s); it carries the "
            "panel composition record that must be written into the artifact"
            % report_path
        )
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise MatchError("%s is not valid JSON: %s" % (report_path, exc))
    flag = report.get("independent_runners")
    if not isinstance(flag, bool):
        raise MatchError(
            "%s has no boolean independent_runners flag; the panel run report "
            "must record whether the family seats were genuinely independent"
            % report_path
        )
    mode = report.get("independence")
    if mode not in INDEPENDENCE_MODES:
        raise MatchError(
            "%s: independence must be one of %s, got %r"
            % (report_path, ", ".join(INDEPENDENCE_MODES), mode)
        )
    present = report.get("families_present")
    if (
        not isinstance(present, list)
        or not present
        or not all(isinstance(f, str) and FAMILY_LABEL_RE.fullmatch(f) for f in present)
        or len(set(present)) != len(present)
    ):
        raise MatchError(
            "%s: families_present must be a non-empty list of distinct family "
            "labels" % report_path
        )
    if mode == "single_family" and len(present) != 1:
        raise MatchError(
            "%s: a single-family panel must list exactly one present family, "
            "got %s" % (report_path, present)
        )
    if mode == "single_family" and flag:
        raise MatchError(
            "%s records a single-family panel with independent_runners=true; "
            "native subagent seats never count as independent runners, so "
            "this report is malformed" % report_path
        )
    panel_valid = report.get("panel_valid")
    if not isinstance(panel_valid, bool):
        raise MatchError(
            "%s has no boolean panel_valid flag" % report_path
        )
    if not panel_valid:
        raise MatchError(
            "%s records panel_valid=false; an invalid panel run is never "
            "assembled into an artifact" % report_path
        )
    min_families = report.get("min_families")
    if (
        isinstance(min_families, bool)
        or not isinstance(min_families, int)
        or min_families < MIN_FAMILIES
    ):
        raise MatchError(
            "%s: min_families must be an integer >= %d (the panel floor the "
            "run was held to)" % (report_path, MIN_FAMILIES)
        )
    votes_collected = report.get("votes_collected")
    if (
        not isinstance(votes_collected, dict)
        or not votes_collected
        or not all(
            isinstance(k, str) and isinstance(v, str) and v.strip()
            for k, v in votes_collected.items()
        )
    ):
        raise MatchError(
            "%s: votes_collected must be a non-empty map of vote keys to "
            "vote file paths" % report_path
        )
    absent = report.get("absent")
    if not isinstance(absent, list):
        raise MatchError("%s: absent must be an array" % report_path)
    for index, item in enumerate(absent):
        if (
            not isinstance(item, dict)
            or sorted(item) != sorted(ABSENT_ENTRY_KEYS)
            or not isinstance(item.get("family"), str)
            or not FAMILY_LABEL_RE.fullmatch(item["family"])
            or not isinstance(item.get("reason"), str)
            or not item["reason"].strip()
        ):
            raise MatchError(
                "%s: absent[%d] must be {family, reason} with a family label "
                "and a non-empty reason" % (report_path, index)
            )
    return {
        "independent_runners": flag,
        "independence": mode,
        "families_present": present,
        "absent": absent,
        "min_families": min_families,
        "votes_collected": votes_collected,
        "report_path": report_path,
    }


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

    The panel composition record (independent_runners, independence mode,
    present and absent families) is always read from panel_run_report.json
    next to the votes and written into the artifact.
    """
    commitment = json.loads(Path(commitment_path).read_text(encoding="utf-8"))
    problems = commit_criteria.validate_commitment(commitment)
    if problems:
        raise MatchError("commitment failed validation: " + "; ".join(problems))

    for label, value in (("campaign_id", campaign_id), ("idea_a", idea_a), ("idea_b", idea_b)):
        if not _is_short_id(value):
            raise MatchError(
                "%s is not an engine short id (%s): %r"
                % (label, SHORT_ID_RE.pattern, value)
            )
    if idea_a == idea_b:
        raise MatchError("idea_a and idea_b are the same node")

    if match_id is None:
        match_id = mint_short_id()
    elif not _is_short_id(match_id):
        raise MatchError(
            "match_id is not an engine short id (%s): %r"
            % (SHORT_ID_RE.pattern, match_id)
        )

    statement_binding = None
    if materials_dir is not None:
        statement_binding = cross_check_materials(
            materials_dir, commitment, idea_a, idea_b
        )

    report = read_panel_report(votes_dir)
    records = load_vote_records(votes_dir, commitment, report)
    independent_runners = report["independent_runners"]

    existing = find_existing_match(campaign_dir, idea_a, idea_b)
    if existing is not None and not rationale:
        raise MatchError(
            "this idea pair already has a match artifact (%s); a rematch "
            "requires --rationale stating the new evidence that justifies it"
            % existing
        )

    tally = tally_votes([record["vote"] for record in records])
    tier, tier_label = observation_tier(tally)

    panel = []
    for record in records:
        entry = {
            "reviewer_family": record["reviewer_family"],
            "model": record["model"],
            "vote": record["vote"],
            "anchored_arguments": record["anchored_arguments"],
            "unanchored_arguments_discarded": record["unanchored_arguments_discarded"],
        }
        if report["independence"] == "single_family":
            entry["seat"] = record["seat"]
        panel.append(entry)

    artifact = {
        "match_id": match_id,
        "campaign_id": campaign_id,
        "idea_a_node_id": idea_a,
        "idea_b_node_id": idea_b,
        "criteria_commitment": commitment,
        "panel": panel,
        "panel_independence": {
            "mode": report["independence"],
            "families_present": report["families_present"],
            "families_absent": report["absent"],
        },
        "independent_runners": independent_runners,
        "outcome": {
            "winner": tally["winner"],
            "vote_margin": tally["vote_margin"],
            "decided_at": decided_at or commit_criteria.utc_now_iso(),
        },
        "observation_write": {"written": False},
    }
    if statement_binding is not None:
        artifact["statement_binding"] = statement_binding
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
        required=True,
        help="Required: cross-check the two advocacy statements against the "
        "commitment and the assembled node ids, and bind a sha256 of each "
        "statement's content into the artifact so the judge inputs are "
        "auditable.",
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
        voter = entry["reviewer_family"]
        if "seat" in entry:
            voter = "%s seat %d" % (voter, entry["seat"])
        print(
            "vote: %s (%s) -> %s, %d anchored arguments credited, %d unanchored discarded"
            % (
                voter,
                entry["model"],
                entry["vote"],
                len(entry["anchored_arguments"]),
                entry["unanchored_arguments_discarded"],
            )
        )
    independence = artifact["panel_independence"]
    print(
        "panel independence: %s (present: %s)"
        % (independence["mode"], ", ".join(independence["families_present"]))
    )
    print("winner: %s (vote_margin %.4f)" % (outcome["winner"], outcome["vote_margin"]))
    print("observation: %s" % tier_label)
    print("artifact: %s" % artifact_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
