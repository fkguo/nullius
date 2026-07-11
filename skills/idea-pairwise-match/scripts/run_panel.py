#!/usr/bin/env python3
"""Collect independent judge votes from a cross-family panel for one pairwise
idea match.

Materials directory contract (produced in protocol Steps 1 and 2):

    commitment.json      criteria commitment written by commit_criteria.py
    card_summary_a.md    deterministic summary of idea card A
    card_summary_b.md    deterministic summary of idea card B
    statement_a.md       anchored advocacy statement for idea A
    statement_b.md       anchored advocacy statement for idea B

Stage order is enforced, not assumed: the commitment file must validate
(hash recomputed from its own criteria), and each statement must open with a
"criteria_commitment:" line carrying the same hash, or this script refuses to
run the panel. Every collected vote record is stamped with the commitment
hash and a collection timestamp, which assemble_match.py re-checks.

The statement a judge reads is REBUILT from verified elements, never passed
through verbatim: after NFKC normalization only headings that name a committed
criterion or the weaknesses section, argument lines whose anchor reference
cross-matches the side's card evidence, and weakness admissions survive into
the rebuilt text (see load_materials / analyze_statement / reconstruct_
statement). This gives the panel a clean, criteria-organized, anchor-checked
input; it is a signal-quality rebuild for pipeline-authored statements, not a
sandbox against a third-party adversary (see SKILL.md "Scope of the rebuild").

Judge execution:

The panel's family list, each family's runner, and each family's model string
come from a third-party agent roster (an agents.json file, schema version 1;
see "Third-party agent roster" below and in SKILL.md). Runner dispatch:

  native      host-subagent vote injected via --native-vote FILE; run_panel
              never spawns a host subagent itself
  codex       review-swarm launcher (scripts/bin/run_multi_task.py)
  claude-cli  review-swarm launcher (claude/<model> spec)
  opencode    opencode-cli-runner script, invoked directly
  gemini      gemini-cli-runner script, invoked directly
  kimi        kimi-cli-runner script, invoked directly

The directly invoked runner scripts get their strict-model flag whenever the
roster pins a specific model, because those scripts would otherwise retry
with the CLI's own configured default model when the pinned model is
unavailable — and for a multi-provider CLI that default may not even belong
to the seat's model family. Under the strict flag a failing pinned model
makes the seat absent, never silently re-modeled.

Launcher subprocesses run with REVIEW_SWARM_NO_AUTO_CONFIG=1 so that a
project-level review-swarm configuration can never silently alter panel
composition, models, or fallback behavior. Family substitution is never
performed: an unavailable family is recorded absent, not replaced.

Each family gets at most two invocation attempts (initial + one retry on any
failure: nonzero exit, timeout, empty output, unparseable or invalid vote
JSON). After that the family is recorded absent with a reason in
panel_run_report.json. A panel is valid only when votes from at least
MIN_FAMILIES distinct families were collected; otherwise this script exits
nonzero and the match is terminated (assemble_match.py enforces the same
floor independently).

When the roster itself cannot field the cross-family floor (fewer available
families than policy.cross_family_minimum), the panel degrades to NATIVE
SUBAGENT SEATS per the roster policy when_below_minimum = native_subagents:
the host runs at least the floor's worth of independent subagent instances,
each answering the rendered judge prompt blind, and injects one reply file
per seat with repeated --native-vote flags. Such a panel is stamped
independence = "single_family" (and independent_runners = false) in
panel_run_report.json, and assemble_match.py carries the same record into
the artifact, so a degraded panel can never pass for a cross-family one.

Vote JSON is extracted fence-first: fenced ```json blocks are tried before
the whole text and before a brace-delimited substring.

Standard library only. Python >= 3.9.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import unicodedata
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import commit_criteria  # noqa: E402

MIN_FAMILIES = 3
MAX_ATTEMPTS = 2

# ---------------------------------------------------------------------------
# Third-party agent roster (agents.json, schema version 1)
# ---------------------------------------------------------------------------
# The roster names the model families a panel can draw on, each family's
# runner and model strings, per-family availability, and the degradation
# policy. Discovery order: an explicit --roster path, then the project-level
# <project root>/.nullius/agents.json found by walking up from the materials
# directory, then the user-level ~/.nullius/agents.json, then the built-in
# pure-native roster. A missing file is never an error (the next source is
# used); a file that exists but does not parse or validate stops the run
# loudly, because silently skipping a misconfigured roster would change panel
# composition behind the operator's back. Each skill reads the roster with
# its own self-contained parser by design; there is no shared roster library.

ROSTER_VERSION = 1
ROSTER_FILE_RELATIVE = Path(".nullius") / "agents.json"
RUNNER_LABELS = ("native", "codex", "opencode", "kimi", "gemini", "claude-cli")
POLICY_BELOW_MINIMUM = "native_subagents"
INDEPENDENCE_MODES = ("cross_family", "single_family")

# Family labels are lowercase roster keys; the same pattern is enforced on
# reviewer_family by the engine's pairwise_match_v1 schema.
FAMILY_LABEL_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
# Model strings are opaque CLI model names/aliases; the pattern only rejects
# placeholders and shell-hostile junk, not any particular vendor syntax.
MODEL_STRING_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:-]*$")
MODEL_TIER_KEY_RE = re.compile(r"^[a-z][a-z0-9_-]*$")

# The --runner override lets a caller replace a family's runner with a command
# template. It is intended for tests and custom runners. Left unguarded, a
# caller could point several family seats at the SAME underlying command and
# manufacture a "cross-family" panel from a single model, defeating the whole
# point of MIN_FAMILIES. So a real match refuses when two or more seats resolve
# to the same underlying command. Setting this environment variable to "1"
# opens an explicit escape hatch for tests and single-model dry runs; when it
# is used, the panel run report is stamped independent_runners = false so a
# stub-backed panel is unmistakable to auditors and to the belief layer.
ALLOW_SHARED_RUNNERS_ENV = "IDEA_PAIRWISE_ALLOW_STUB_RUNNERS"

SKILL_DIR = _SCRIPTS_DIR.parent
PROMPTS_DIR = SKILL_DIR / "prompts"
SKILLS_ROOT = SKILL_DIR.parent
DEFAULT_MULTI_TASK = SKILLS_ROOT / "review-swarm" / "scripts" / "bin" / "run_multi_task.py"
DEFAULT_KIMI_RUNNER = SKILLS_ROOT / "kimi-cli-runner" / "scripts" / "run_kimi.sh"
DEFAULT_OPENCODE_RUNNER = SKILLS_ROOT / "opencode-cli-runner" / "scripts" / "run_opencode.sh"
DEFAULT_GEMINI_RUNNER = SKILLS_ROOT / "gemini-cli-runner" / "scripts" / "run_gemini.sh"

# Launcher backend selected by the launcher-backed runner labels; used both to
# build the launcher model spec and to name the --backend-output capture file.
# The opencode, gemini, and kimi seats call their runner scripts DIRECTLY so
# the panel can pass the strict-model flag: those runner scripts would
# otherwise silently retry with the CLI's own default model when the pinned
# model is unavailable, and for a multi-provider CLI that default may not even
# be the same model family. A pinned model that fails must make the seat
# absent, never silently re-model it.
LAUNCHER_BACKENDS = {
    "codex": "codex",
    "claude-cli": "claude",
}
DIRECT_RUNNER_ENV = {
    "kimi": ("IDEA_PAIRWISE_KIMI_RUNNER", DEFAULT_KIMI_RUNNER),
    "opencode": ("IDEA_PAIRWISE_OPENCODE_RUNNER", DEFAULT_OPENCODE_RUNNER),
    "gemini": ("IDEA_PAIRWISE_GEMINI_RUNNER", DEFAULT_GEMINI_RUNNER),
}


def builtin_roster():
    """Pure-native roster used when no agents.json exists anywhere: the host
    holds the only seat, so a panel can only run as native subagent seats
    (the degraded, single-family form). Cross-family judging requires an
    operator-written roster.

    The seat is labeled "host", not any concrete family name: this script
    cannot verify which model family the host actually is, and recording a
    guessed family would be a false record on a non-claude host. An operator
    who wants the real family named writes a roster file that declares it.
    """
    return {
        "version": ROSTER_VERSION,
        "families": {
            "host": {"runner": "native", "models": {"default": "host-subagent"}},
        },
        "policy": {
            "cross_family_minimum": MIN_FAMILIES,
            "when_below_minimum": POLICY_BELOW_MINIMUM,
        },
    }


def parse_roster(obj, where):
    """Validate a roster object (agents.json schema version 1) and reduce it
    to what the panel consumes:

        {"families": {label: {"runner", "model", "available", "notes"}},
         "cross_family_minimum": int}

    "model" is the family's default model string. Raises PanelError naming
    `where` on any shape problem; a roster that exists must be right.
    """
    if not isinstance(obj, dict):
        raise PanelError("%s: roster must be a JSON object" % where)
    problems = []
    # "_notes" is a documentation-only field an operator may add to their own
    # agents.json (and that the shipped docs/examples/agents.example.json
    # uses); it is accepted and ignored, never consumed.
    unknown = sorted(set(obj) - {"version", "families", "policy", "_notes"})
    if unknown:
        problems.append("unknown top-level keys: %s" % ", ".join(unknown))
    version = obj.get("version")
    # The exact-type check matters: in Python, True == 1 and 1.0 == 1, so a
    # bare equality test would silently accept a malformed version field.
    if isinstance(version, bool) or not isinstance(version, int) or version != ROSTER_VERSION:
        problems.append(
            "version must be the integer %d, got %r" % (ROSTER_VERSION, version)
        )
    families = obj.get("families")
    parsed = {}
    if not isinstance(families, dict) or not families:
        problems.append("families must be a non-empty object")
    else:
        native_labels = []
        # Two configuration contradictions are rejected here, per
        # docs/AGENTS_FILE.md: two families sharing one dedicated
        # (non-native, non-opencode) runner -- one dedicated execution route
        # is one model family, so two labels on it can only mean the same
        # physical family counted twice; the fix is one family with several
        # model tiers, not two families -- and two families sharing the
        # exact same (runner, model) pair regardless of runner kind.
        # opencode is the one exempt runner: it is a multi-provider gateway,
        # so several families legitimately share it with distinct models.
        dedicated_runner_labels = {}
        runner_model_labels = {}
        for label, entry in families.items():
            frame = "families.%s" % label
            if not isinstance(label, str) or not FAMILY_LABEL_RE.fullmatch(label):
                problems.append(
                    "family label %r must match %s" % (label, FAMILY_LABEL_RE.pattern)
                )
                continue
            if not isinstance(entry, dict):
                problems.append("%s must be an object" % frame)
                continue
            unknown_entry = sorted(set(entry) - {"runner", "models", "available", "notes"})
            if unknown_entry:
                problems.append(
                    "%s has unknown keys: %s" % (frame, ", ".join(unknown_entry))
                )
            runner = entry.get("runner")
            if runner not in RUNNER_LABELS:
                problems.append(
                    "%s.runner must be one of %s, got %r"
                    % (frame, ", ".join(RUNNER_LABELS), runner)
                )
            elif runner == "native":
                native_labels.append(label)
            available = entry.get("available", True)
            if not isinstance(available, bool):
                problems.append("%s.available must be a boolean" % frame)
                available = True
            # A family that is declared unavailable can never be invoked, so
            # it may omit its models object (the finalized schema's gemini
            # entry does exactly that); an available family must name at
            # least its default model.
            models = entry.get("models")
            model = None
            if models is None and not available:
                pass
            elif not isinstance(models, dict) or not models:
                problems.append(
                    "%s.models must be a non-empty object (required unless the "
                    "family is declared unavailable)" % frame
                )
            else:
                for key, value in models.items():
                    if not isinstance(key, str) or not MODEL_TIER_KEY_RE.fullmatch(key):
                        problems.append("%s.models has a bad key %r" % (frame, key))
                    value_ok = isinstance(value, str) and MODEL_STRING_RE.fullmatch(value)
                    if not value_ok:
                        problems.append(
                            "%s.models[%r] must be a plain model string "
                            "(pattern %s), got %r"
                            % (frame, key, MODEL_STRING_RE.pattern, value)
                        )
                    # Every tier is tracked for the (runner, model) uniqueness
                    # check below, not only "default": an operator selecting a
                    # non-default tier via --model-spec at invocation time
                    # (see resolve_execution_signature) can hit the same
                    # collision a shared default would, and review-swarm's own
                    # separate parser for this same agents.json contract
                    # already checks every tier, not just default. A value
                    # that failed the string/pattern check just above is
                    # never tracked here: it is already recorded as a
                    # problem, and tracking a non-string value as a dict-key
                    # component would itself raise (dicts and lists are
                    # unhashable). ONE family listing the same model string on
                    # two of its own tiers is legal (a family is one backend;
                    # duplicate tiers cannot double-count it), so each family
                    # is recorded at most once per (runner, model) pair.
                    if value_ok and runner in RUNNER_LABELS and runner != "native":
                        seen_for_pair = runner_model_labels.setdefault((runner, value), [])
                        if label not in seen_for_pair:
                            seen_for_pair.append(label)
                if "default" not in models:
                    problems.append('%s.models must carry a "default" entry' % frame)
                else:
                    model = models["default"]
            if runner in RUNNER_LABELS and runner not in ("native", "opencode"):
                dedicated_runner_labels.setdefault(runner, []).append(label)
            notes = entry.get("notes", "")
            if not isinstance(notes, str):
                problems.append("%s.notes must be a string" % frame)
                notes = ""
            parsed[label] = {
                "runner": runner,
                "model": model,
                "available": available,
                "notes": notes,
            }
        if len(native_labels) > 1:
            problems.append(
                'families %s all declare runner "native"; the host provides '
                "exactly one native seat" % ", ".join(sorted(native_labels))
            )
        for runner, labels in sorted(dedicated_runner_labels.items()):
            if len(labels) > 1:
                problems.append(
                    "families %s all declare the dedicated runner %r; one "
                    "dedicated execution route is one model family -- merge "
                    "them into one family with several model tiers instead "
                    "of two families" % (sorted(labels), runner)
                )
        for (runner, model), labels in sorted(runner_model_labels.items()):
            if len(labels) > 1:
                problems.append(
                    "families %s declare the identical (runner, model) pair "
                    "(%s, %s); two family labels resolving to the exact same "
                    "call are one physical family counted twice"
                    % (sorted(labels), runner, model)
                )
    policy = obj.get("policy", {})
    minimum = MIN_FAMILIES
    if not isinstance(policy, dict):
        problems.append("policy must be an object")
    else:
        unknown_policy = sorted(
            set(policy) - {"cross_family_minimum", "when_below_minimum"}
        )
        if unknown_policy:
            problems.append("policy has unknown keys: %s" % ", ".join(unknown_policy))
        raw_minimum = policy.get("cross_family_minimum", MIN_FAMILIES)
        if isinstance(raw_minimum, bool) or not isinstance(raw_minimum, int):
            problems.append("policy.cross_family_minimum must be an integer")
        elif raw_minimum < MIN_FAMILIES:
            problems.append(
                "policy.cross_family_minimum is %d; the protocol floor is %d "
                "and a roster cannot lower it" % (raw_minimum, MIN_FAMILIES)
            )
        else:
            minimum = raw_minimum
        below = policy.get("when_below_minimum", POLICY_BELOW_MINIMUM)
        if below != POLICY_BELOW_MINIMUM:
            problems.append(
                "policy.when_below_minimum must be %r, got %r"
                % (POLICY_BELOW_MINIMUM, below)
            )
    if problems:
        raise PanelError("%s: %s" % (where, "; ".join(problems)))
    return {"families": parsed, "cross_family_minimum": minimum}


def load_roster_file(path):
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise PanelError("cannot read roster %s: %s" % (path, exc))
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PanelError("roster %s is not valid JSON: %s" % (path, exc))
    return parse_roster(obj, str(path))


def find_project_roster(start_dir):
    """Walk up from start_dir to the filesystem root and return the first
    <ancestor>/.nullius/agents.json that exists, else None."""
    current = Path(start_dir).resolve()
    for ancestor in [current] + list(current.parents):
        candidate = ancestor / ROSTER_FILE_RELATIVE
        if candidate.is_file():
            return candidate
    return None


def resolve_roster(explicit_path, start_dir, home=None):
    """Resolve the agent roster and return (roster, source, path).

    source is one of "explicit", "project", "user", "builtin"; path is the
    file used, or None for the built-in roster. An explicit path must exist;
    for the two discovered locations a missing file just falls through.
    """
    if explicit_path is not None:
        return load_roster_file(explicit_path), "explicit", Path(explicit_path)
    project = find_project_roster(start_dir)
    if project is not None:
        return load_roster_file(project), "project", project
    user = Path(home) if home is not None else Path.home()
    user_roster = user / ROSTER_FILE_RELATIVE
    if user_roster.is_file():
        return load_roster_file(user_roster), "user", user_roster
    return parse_roster(builtin_roster(), "built-in roster"), "builtin", None


def native_family_of(roster):
    """Return the label of the roster's native-runner family, or None."""
    for label, entry in roster["families"].items():
        if entry["runner"] == "native":
            return label
    return None


def launcher_model_spec(runner, model):
    """Model spec handed to the review-swarm launcher for one CLI seat.
    A model of "default" delegates to the CLI's own configured default."""
    if runner in LAUNCHER_BACKENDS:
        return "%s/%s" % (LAUNCHER_BACKENDS[runner], model)
    raise PanelError("runner %r takes no launcher model spec" % runner)


def direct_runner_path(runner):
    """Path of a directly invoked runner script, with its env override."""
    env_name, default_path = DIRECT_RUNNER_ENV[runner]
    return Path(os.environ.get(env_name, default_path))

VOTE_VALUES = ("a", "b", "tie")
ANCHOR_TYPES = ("literature", "computation")

# Appended after the rendered judge-prompt body in the on-disk
# judge_prompt.md a host subagent reads. A native reply is formed in a
# separate invocation from the one that collects it, so the reply must
# carry proof of WHICH rendered prompt it answered: the subagent echoes
# this hash inside its vote JSON, and collection verifies the echo against
# the current body hash (collect_injected_vote). CLI seats receive their
# prompt and return their reply within one invocation, so they carry no
# echo. clean_vote_payload drops the extra key after verification, keeping
# the stored vote record and the pairwise_match_v1 artifact unchanged.
INJECTED_BINDING_TEMPLATE = (
    "\n---\n\n"
    "Native-seat binding — the one exception to the exactly-three-keys rule\n"
    "in the Required output section, and it applies ONLY when you are\n"
    "answering from this file as a host subagent whose reply will be\n"
    "injected with --native-vote. In that case (and no other), include one\n"
    "extra key in your vote JSON, copied verbatim from this line:\n"
    '"judge_prompt_sha256": "%s"\n'
    "Every other judge ignores this block and replies with exactly the\n"
    "three keys stated in the Required output section.\n"
)

REQUIRED_MATERIALS = {
    "commitment": "commitment.json",
    "card_summary_a": "card_summary_a.md",
    "card_summary_b": "card_summary_b.md",
    "statement_a": "statement_a.md",
    "statement_b": "statement_b.md",
}

STATEMENT_HASH_LINE_RE = re.compile(r"^criteria_commitment:\s*(sha256:[0-9a-f]{64})\s*$")
STATEMENT_NODE_LINE_RE = re.compile(r"^idea_node_id:\s*(\S+)\s*$")
FENCE_RE = re.compile(r"```(?:json)?[ \t]*\n(.*?)\n?```", re.DOTALL)
DEFAULT_WORD_CAP = 600

# An anchored argument line ends with a tag naming one of the allowed anchor
# kinds and a reference: "[anchor: literature -> ref]" or
# "[anchor: computation -> ref]". This is the ONLY line shape that counts as a
# merit argument; every other non-heading prose line is an unanchored argument
# and is dropped. Parsed independently of anything the judge reports.
#
# The reference must look like a URI or an artifact path, not an arbitrary
# scrap of text: it either carries a scheme ("something://" or "something:")
# or is a slash-bearing path. This rejects a tag whose "reference" is a stray
# word or punctuation, which could not correspond to a real card evidence
# entry anyway. Cross-matching against the card's evidence set (below) is the
# binding check; this pattern only screens the tag's surface shape.
ANCHOR_REF_RE = re.compile(r"^(?:[A-Za-z][A-Za-z0-9+.-]*:\S+|\S*/\S+)$")
ANCHOR_TAG_RE = re.compile(
    r"\[anchor:\s*(literature|computation)\s*->\s*(\S[^\]]*?)\s*\]\s*$"
)

# Only ATX headings ("# ...", "## ...") are recognized as structure. A heading
# is kept in the rebuilt statement only when its normalized text names a
# committed criterion (see reconstruct_statement) or the mandated weaknesses
# section; every other heading is dropped rather than passed through. There is
# no blacklist of forbidden heading text: the statement the judge reads is
# assembled from verified elements only, so a heading that matches nothing
# simply never appears, whatever encoding variant it was written in.
WEAKNESS_HEADING = "honest weaknesses"
HEADING_LINE_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


class PanelError(RuntimeError):
    """Raised for contract violations that must stop the panel."""


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

def load_materials(materials_dir, word_cap=DEFAULT_WORD_CAP):
    """Load and verify the five materials files; return a dict of texts plus
    the parsed commitment. Raises PanelError on any contract violation.

    The two advocacy statements are hash-bound to the commitment and then
    REBUILT from verified elements before this function returns: the text
    stored under "statement_a"/"statement_b" is the rebuilt statement, which is
    what render_judge_prompt substitutes into the judge prompt. The author's
    original free prose is never passed to a judge verbatim; only headings that
    name a committed criterion or the weaknesses section, argument lines whose
    anchor reference cross-matches the side's card evidence, and weakness
    admissions survive into the rebuilt text. The count of unanchored argument
    lines dropped per side is stored under "_discarded_a"/"_discarded_b" for
    later reconciliation against the judges' self-reported counts.
    """
    materials_dir = Path(materials_dir)
    texts = {}
    for label, name in REQUIRED_MATERIALS.items():
        path = materials_dir / name
        if not path.is_file():
            raise PanelError("materials file missing: %s" % path)
        texts[label] = path.read_text(encoding="utf-8")

    try:
        commitment = json.loads(texts["commitment"])
    except json.JSONDecodeError as exc:
        raise PanelError("commitment.json is not valid JSON: %s" % exc)
    problems = commit_criteria.validate_commitment(commitment)
    if problems:
        raise PanelError(
            "commitment.json failed validation: " + "; ".join(problems)
        )

    criteria = commitment["criteria"]
    for label in ("statement_a", "statement_b"):
        declared = statement_hash_line(texts[label])
        if declared is None:
            raise PanelError(
                "%s does not open with a 'criteria_commitment: sha256:...' line; "
                "statements must be drafted after (and against) the commitment"
                % REQUIRED_MATERIALS[label]
            )
        if declared != commitment["commitment_hash"]:
            raise PanelError(
                "%s declares %s but the commitment file has %s; refusing to "
                "run a panel over mismatched materials"
                % (REQUIRED_MATERIALS[label], declared, commitment["commitment_hash"])
            )
        # The set of anchor references the statement is allowed to use is the
        # side's own card evidence, taken from the deterministically rendered
        # card summary. An argument line whose reference is not in this set is
        # unanchored as far as the panel is concerned, and is dropped.
        summary_label = "card_summary_" + label[-1]
        allowed_evidence = card_summary_evidence(texts[summary_label])
        # Rebuild the statement from verified elements BEFORE it is ever
        # substituted into the judge prompt. A statement that yields no anchored
        # argument, or overflows the word cap, stops the match here with no
        # judge run, exactly like a hash mismatch.
        rebuilt, discarded = verify_statement_contract(
            label, texts[label], criteria, allowed_evidence, word_cap
        )
        texts[label] = rebuilt
        texts["_discarded_" + label[-1]] = discarded

    return texts, commitment


def statement_hash_line(text):
    """Return the sha256 declared on the statement's first non-empty line,
    or None if the line is absent or malformed."""
    for line in text.splitlines():
        if not line.strip():
            continue
        match = STATEMENT_HASH_LINE_RE.match(line.strip())
        return match.group(1) if match else None
    return None


def card_summary_evidence(summary_text):
    """Return the set of evidence references named in a rendered card summary.

    render_card_summary emits each claim as
    "N. text [support: type; evidence: uri1, uri2]"; the evidence URIs come
    verbatim from the card's evidence_uris. Pulling them back out here gives
    the exact set of references a statement for this side is permitted to
    anchor to, without threading the raw card JSON through load_materials.
    """
    evidence = set()
    for match in re.finditer(r"\[support:[^\];]*;\s*evidence:\s*([^\]]*)\]", summary_text):
        for ref in match.group(1).split(","):
            ref = ref.strip()
            if ref:
                evidence.add(ref)
    return evidence


def _normalized_heading(text):
    """NFKC-normalized, lowercased, whitespace-collapsed text for heading and
    criterion comparison. Both sides pass through here, so a heading matches a
    criterion under one shared normalization rather than by raw code points."""
    return " ".join(unicodedata.normalize("NFKC", text).strip().lower().split())


def analyze_statement(text, criteria, allowed_evidence):
    """Parse a statement into a controlled structure the judge prompt is
    rebuilt from, trusting nothing the author or a judge reports.

    NFKC-normalize the whole statement first, then walk it line by line. The
    only elements admitted into the structure are:

      - a heading whose normalized text names a committed criterion or the
        "Honest weaknesses" section (ATX headings only);
      - under a criterion heading, an argument line ending in a valid anchor
        tag whose reference cross-matches the side's card evidence set;
      - under the weaknesses heading, each non-empty line, kept as a weakness
        item.

    Everything else -- headings that name nothing committed, argument lines
    with a missing/malformed/unmatched anchor, stray prose outside any section
    -- is discarded. There is no blacklist: content the judge should not see is
    simply never rebuilt.

    Returns a dict with:
      criteria_sections   ordered list of (criterion, [anchored-arg dicts]),
                          one per committed criterion, in committed order
      weaknesses          list of weakness item strings, in order
      unanchored_arguments   argument lines dropped for want of a valid,
                          card-matched anchor (counted, not passed through)

    Each anchored-arg dict is {"text", "anchor_type", "anchor_ref"} where
    "text" is the argument prose with its anchor tag stripped, so the rebuilt
    line is reassembled from parts rather than echoed. The word cap is checked
    by the caller against the actual rebuilt text, not estimated here.
    """
    text = unicodedata.normalize("NFKC", text)
    criteria_lookup = {_normalized_heading(c): c for c in criteria}
    sections = {c: [] for c in criteria}
    weaknesses = []
    unanchored = []
    current = None  # a committed criterion, WEAKNESS_HEADING, or None
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        heading = HEADING_LINE_RE.match(stripped)
        if heading:
            title = _normalized_heading(heading.group(2))
            if title in criteria_lookup:
                current = criteria_lookup[title]
            elif title == WEAKNESS_HEADING:
                current = WEAKNESS_HEADING
            else:
                # A heading that names nothing committed opens no section; any
                # lines beneath it fall outside every section and are dropped.
                current = None
            continue
        # Protocol scaffolding lines are neither arguments nor weaknesses.
        if STATEMENT_HASH_LINE_RE.match(stripped) or STATEMENT_NODE_LINE_RE.match(stripped):
            continue
        if current == WEAKNESS_HEADING:
            weaknesses.append(stripped)
            continue
        # The single sanctioned "nothing to say here" line is not a claim.
        if stripped == "No anchored argument under this criterion.":
            continue
        if current is None:
            # Prose outside every committed section: dropped, and counted as an
            # unanchored argument line so the drop is visible in the report.
            unanchored.append(stripped)
            continue
        parsed = parse_anchored_line(stripped, allowed_evidence)
        if parsed is None:
            unanchored.append(stripped)
        else:
            sections[current].append(parsed)

    criteria_sections = [(c, sections[c]) for c in criteria]
    return {
        "criteria_sections": criteria_sections,
        "weaknesses": weaknesses,
        "unanchored_arguments": unanchored,
    }


def parse_anchored_line(stripped, allowed_evidence):
    """Return {"text", "anchor_type", "anchor_ref"} for a valid anchored
    argument line, or None when the line has no anchor tag, a malformed
    reference, or a reference the side's card does not carry.

    The reference must look like a URI/artifact path AND appear verbatim in
    allowed_evidence; a well-formed tag pointing at a reference the card never
    declared is treated as unanchored (the statement_prompt.md requirement that
    the reference be a card evidence entry, now enforced, not just requested).
    """
    match = ANCHOR_TAG_RE.search(stripped)
    if not match:
        return None
    anchor_type = match.group(1)
    anchor_ref = match.group(2).strip()
    if not ANCHOR_REF_RE.match(anchor_ref):
        return None
    if anchor_ref not in allowed_evidence:
        return None
    body = stripped[: match.start()].rstrip()
    if not body:
        return None
    return {"text": body, "anchor_type": anchor_type, "anchor_ref": anchor_ref}


def reconstruct_statement(label, node_id, commitment_hash, analysis):
    """Rebuild the statement a judge sees from the controlled structure in
    analysis. Every line is emitted from verified parts, in committed-criterion
    order, so the judge's view contains nothing the parser did not validate.
    """
    lines = [
        "criteria_commitment: %s" % commitment_hash,
        "idea_node_id: %s" % node_id,
        "",
        "# Advocacy statement: Idea %s" % label[-1].upper(),
        "",
    ]
    for criterion, args in analysis["criteria_sections"]:
        lines.append("## %s" % criterion)
        lines.append("")
        if args:
            for arg in args:
                lines.append(
                    "%s [anchor: %s -> %s]"
                    % (arg["text"], arg["anchor_type"], arg["anchor_ref"])
                )
        else:
            lines.append("No anchored argument under this criterion.")
        lines.append("")
    lines.append("## Honest weaknesses")
    lines.append("")
    if analysis["weaknesses"]:
        for item in analysis["weaknesses"]:
            lines.append("- %s" % item)
    else:
        lines.append("- None stated.")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def verify_statement_contract(label, text, criteria, allowed_evidence, word_cap):
    """Rebuild the statement from verified elements and enforce the two
    remaining hard limits on the rebuilt result. Refuses (raises PanelError)
    when the rebuilt statement overflows the word cap or holds no anchored
    argument at all, so such a statement never reaches a judge.

    Returns (rebuilt_text, discarded_count): the text the judge should see and
    the number of unanchored argument lines the parser dropped, for
    reconciliation against a judge's self-reported count.

    Rejection is the default at the element level: anything not validated is
    dropped during the rebuild rather than passed through. The word cap and the
    at-least-one-anchor floor are the only conditions that stop the whole
    match, because a rebuilt statement that is empty of anchored merit, or
    over-long, cannot serve as advocacy under the committed criteria.
    """
    name = REQUIRED_MATERIALS[label]
    node_id = statement_node_line(text)
    if node_id is None:
        raise PanelError(
            "%s does not carry an 'idea_node_id:' line; the statement cannot be "
            "bound to an idea node" % name
        )
    analysis = analyze_statement(text, criteria, allowed_evidence)
    total_anchored = sum(len(args) for _c, args in analysis["criteria_sections"])
    if total_anchored == 0:
        raise PanelError(
            "%s has no anchored argument line that matches the card's evidence "
            "('... [anchor: literature -> ref]' or "
            "'... [anchor: computation -> ref]', ref taken from the card); a "
            "statement with zero card-anchored merit claims cannot enter the "
            "panel" % name
        )
    hash_line = statement_hash_line(text)
    rebuilt = reconstruct_statement(label, node_id, hash_line, analysis)
    # The cap is checked against the rebuilt text the judge actually reads, not
    # the author's original, so padding that gets dropped in the rebuild does
    # not count and content that survives does.
    rebuilt_words = len(rebuilt.split())
    if rebuilt_words > word_cap:
        raise PanelError(
            "%s rebuilds to %d words, over the %d-word cap; an over-length "
            "statement is refused before any judge runs"
            % (name, rebuilt_words, word_cap)
        )
    return rebuilt, len(analysis["unanchored_arguments"])


def statement_node_line(text):
    """Return the idea_node_id declared in the statement, or None if absent."""
    for line in text.splitlines():
        match = STATEMENT_NODE_LINE_RE.match(line.strip())
        if match:
            return match.group(1)
    return None


# ---------------------------------------------------------------------------
# Prompt rendering
# ---------------------------------------------------------------------------

def fill_template(template, replacements):
    # Single pass over the template: a substituted value is never rescanned, so
    # a placeholder token embedded inside a value -- e.g. a reconstructed
    # advocacy line that carries the literal {{STATEMENT_B}} -- is left intact
    # rather than re-expanded into the other side's content. The leftover check
    # then rejects the match, exactly as for any other unfilled placeholder.
    def _sub(match):
        return replacements.get(match.group(1), match.group(0))

    filled = re.sub(r"\{\{([A-Z_]+)\}\}", _sub, template)
    leftover = re.search(r"\{\{[A-Z_]+\}\}", filled)
    if leftover:
        raise PanelError("unfilled template placeholder: %s" % leftover.group(0))
    return filled


def render_judge_prompt(texts, commitment):
    template = (PROMPTS_DIR / "judge_prompt.md").read_text(encoding="utf-8")
    return fill_template(
        template,
        {
            "COMMITMENT_HASH": commitment["commitment_hash"],
            "COMMITMENT_JSON": json.dumps(commitment, ensure_ascii=False, indent=2),
            "CARD_SUMMARY_A": texts["card_summary_a"].strip(),
            "CARD_SUMMARY_B": texts["card_summary_b"].strip(),
            "STATEMENT_A": texts["statement_a"].strip(),
            "STATEMENT_B": texts["statement_b"].strip(),
        },
    )


def render_statement_prompt(label, card_json_text, commitment, word_cap):
    template = (PROMPTS_DIR / "statement_prompt.md").read_text(encoding="utf-8")
    card = json.loads(card_json_text)
    node_id = card.get("node_id")
    if not isinstance(node_id, str) or not node_id:
        raise PanelError("idea card for %s has no node_id" % label)
    # A card with no claims cannot be argued for: every argument must anchor to
    # a card claim's evidence. The card-summary path already rejects this; the
    # statement path must too, or a claimless card would silently produce a
    # request for an unanchorable statement.
    claims = card.get("claims")
    if not isinstance(claims, list) or not claims:
        raise PanelError("idea card for %s has no claims" % label)
    return fill_template(
        template,
        {
            "IDEA_LABEL": label.upper(),
            "COMMITMENT_HASH": commitment["commitment_hash"],
            "COMMITMENT_JSON": json.dumps(commitment, ensure_ascii=False, indent=2),
            "IDEA_CARD_JSON": json.dumps(card, ensure_ascii=False, indent=2),
            "NODE_ID": node_id,
            "WORD_CAP": str(word_cap),
        },
    )


def render_card_summary(label, card_json_text):
    """Deterministic card summary: same template for both sides, no model
    involvement, so the panel's card views are symmetric by construction."""
    card = json.loads(card_json_text)
    node_id = card.get("node_id", "")
    title = card.get("title", "")
    gist = card.get("gist", "")
    status = card.get("status", "")
    lines = [
        "# Idea card summary: Idea %s" % label.upper(),
        "",
        "node_id: %s" % node_id,
        "title: %s" % title,
        "status: %s" % status,
        "",
        "gist: %s" % gist,
        "",
        "claims:",
    ]
    claims = card.get("claims", [])
    if not isinstance(claims, list) or not claims:
        raise PanelError("idea card for %s has no claims" % label)
    for index, claim in enumerate(claims, start=1):
        text = claim.get("claim", "")
        support = claim.get("support_type", "")
        uris = claim.get("evidence_uris", [])
        lines.append(
            "%d. %s [support: %s; evidence: %s]"
            % (index, text, support, ", ".join(uris))
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Vote parsing and validation
# ---------------------------------------------------------------------------

def extract_json_object(text):
    """Fence-first JSON extraction: fenced blocks, then the whole text, then
    the outermost brace-delimited substring. Returns a dict or None."""
    candidates = [match.group(1) for match in FENCE_RE.finditer(text)]
    candidates.append(text)
    first = text.find("{")
    last = text.rfind("}")
    if first != -1 and last > first:
        candidates.append(text[first : last + 1])
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate:
            continue
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def validate_vote_payload(obj):
    """Structurally validate a judge's vote JSON. Returns problem strings."""
    errors = []
    if not isinstance(obj, dict):
        return ["vote payload is not a JSON object"]
    vote = obj.get("vote")
    if vote not in VOTE_VALUES:
        errors.append("vote must be one of %s, got %r" % (", ".join(VOTE_VALUES), vote))
    arguments = obj.get("anchored_arguments")
    if not isinstance(arguments, list):
        errors.append("anchored_arguments must be an array")
    else:
        for index, entry in enumerate(arguments):
            if not isinstance(entry, dict):
                errors.append("anchored_arguments[%d] is not an object" % index)
                continue
            for key in ("argument", "anchor_type", "anchor_ref"):
                value = entry.get(key)
                if not isinstance(value, str) or not value.strip():
                    errors.append(
                        "anchored_arguments[%d].%s must be a non-empty string"
                        % (index, key)
                    )
            anchor_type = entry.get("anchor_type")
            if isinstance(anchor_type, str) and anchor_type not in ANCHOR_TYPES:
                errors.append(
                    "anchored_arguments[%d].anchor_type must be one of %s, got %r"
                    % (index, ", ".join(ANCHOR_TYPES), anchor_type)
                )
    discarded = obj.get("unanchored_arguments_discarded")
    if isinstance(discarded, bool) or not isinstance(discarded, int) or discarded < 0:
        errors.append("unanchored_arguments_discarded must be an integer >= 0")
    return errors


def clean_vote_payload(obj):
    """Keep exactly the three contract keys; drop anything extra a judge
    volunteered. Assumes validate_vote_payload returned no errors."""
    return {
        "vote": obj["vote"],
        "anchored_arguments": [
            {
                "argument": entry["argument"].strip(),
                "anchor_type": entry["anchor_type"],
                "anchor_ref": entry["anchor_ref"].strip(),
            }
            for entry in obj["anchored_arguments"]
        ],
        "unanchored_arguments_discarded": obj["unanchored_arguments_discarded"],
    }


# ---------------------------------------------------------------------------
# Family execution
# ---------------------------------------------------------------------------

def launcher_env():
    env = dict(os.environ)
    env["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"
    return env


def family_command(runner, model, judge_system, judge_prompt, attempt_dir,
                   timeout_secs, multi_task):
    """Build (argv, output_file) for one family attempt.

    `model` is the family's model string; "default" delegates to the CLI's
    own configured default. Directly invoked runner scripts (kimi, opencode,
    gemini) get their strict-model flag whenever a specific model is pinned,
    so the pinned model failing makes the seat absent instead of being
    silently replaced by the CLI's default model.
    """
    out_file = attempt_dir / "vote_raw.txt"
    if runner == "kimi":
        argv = [
            "bash",
            str(direct_runner_path("kimi")),
            "--prompt-file",
            str(judge_prompt),
            "--system-prompt-file",
            str(judge_system),
            "--out",
            str(out_file),
            "--timeout-secs",
            str(timeout_secs),
            "--max-attempts",
            "1",
            "--raw-out",
            str(attempt_dir / "kimi_stream_raw.txt"),
        ]
        if model != "default":
            argv += ["--model", model, "--no-fallback"]
        return argv, out_file
    if runner == "opencode":
        argv = [
            "bash",
            str(direct_runner_path("opencode")),
            "--prompt-file",
            str(judge_prompt),
            "--system-prompt-file",
            str(judge_system),
            "--out",
            str(out_file),
            "--max-attempts",
            "1",
        ]
        if model != "default":
            argv += ["--model", model, "--no-fallback"]
        return argv, out_file
    if runner == "gemini":
        argv = [
            "bash",
            str(direct_runner_path("gemini")),
            "--prompt-file",
            str(judge_prompt),
            "--system-prompt-file",
            str(judge_system),
            "--out",
            str(out_file),
        ]
        if model != "default":
            argv += ["--model", model, "--no-fallback"]
        return argv, out_file
    spec = launcher_model_spec(runner, model)
    argv = [
        sys.executable,
        str(multi_task),
        "--out-dir",
        str(attempt_dir),
        "--system",
        str(judge_system),
        "--prompt",
        str(judge_prompt),
        "--models",
        spec,
        "--backend-output",
        "%s=vote_raw.txt" % LAUNCHER_BACKENDS[runner],
        "--timeout-secs",
        str(timeout_secs),
    ]
    return argv, out_file


def model_label_from_meta(attempt_dir, fallback):
    """Read the launcher's meta.json for the requested model, if present."""
    meta_path = attempt_dir / "meta.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback
    agents = meta.get("agents") or meta.get("results") or []
    if isinstance(agents, list):
        for entry in agents:
            if isinstance(entry, dict) and entry.get("model"):
                return str(entry["model"])
    return fallback


def run_family(family, runner, model, override_cmd, judge_system, judge_prompt,
               family_dir, timeout_secs, multi_task):
    """Run one family with up to MAX_ATTEMPTS attempts.

    `runner` and `model` come from the roster (model is the family's default
    model string); an override command replaces the runner entirely.
    Returns (payload_or_None, model_label, detail dict).
    """
    detail = {"attempts": [], "source": "override" if override_cmd else "runner"}
    if override_cmd:
        model_label = "%s/runner-override" % family
    elif runner in LAUNCHER_BACKENDS:
        model_label = launcher_model_spec(runner, model)
    else:
        model_label = "%s/%s" % (runner, model)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        attempt_dir = family_dir / ("attempt%d" % attempt)
        attempt_dir.mkdir(parents=True, exist_ok=True)
        attempt_info = {"attempt": attempt}
        try:
            if override_cmd:
                argv = [
                    token.format(prompt=str(judge_prompt), system=str(judge_system))
                    for token in shlex.split(override_cmd)
                ]
                attempt_info["argv"] = argv
                proc = subprocess.run(
                    argv,
                    capture_output=True,
                    text=True,
                    timeout=timeout_secs + 60,
                    env=launcher_env(),
                )
                raw_text = proc.stdout
                (attempt_dir / "vote_raw.txt").write_text(raw_text, encoding="utf-8")
            else:
                argv, out_file = family_command(
                    runner, model, judge_system, judge_prompt, attempt_dir,
                    timeout_secs, multi_task,
                )
                attempt_info["argv"] = argv
                proc = subprocess.run(
                    argv,
                    capture_output=True,
                    text=True,
                    timeout=timeout_secs + 120,
                    env=launcher_env(),
                )
                raw_text = out_file.read_text(encoding="utf-8") if out_file.is_file() else ""
                if runner in LAUNCHER_BACKENDS:
                    model_label = model_label_from_meta(attempt_dir, model_label)
            attempt_info["exit_code"] = proc.returncode
            stderr_tail = (proc.stderr or "")[-2000:]
            if stderr_tail:
                (attempt_dir / "stderr_tail.txt").write_text(stderr_tail, encoding="utf-8")
        except subprocess.TimeoutExpired:
            attempt_info["failure"] = "timeout after %ds" % timeout_secs
            detail["attempts"].append(attempt_info)
            continue
        except (OSError, KeyError, IndexError, ValueError) as exc:
            attempt_info["failure"] = "invocation error: %s" % exc
            detail["attempts"].append(attempt_info)
            continue

        if proc.returncode != 0:
            attempt_info["failure"] = "runner exit code %d" % proc.returncode
            detail["attempts"].append(attempt_info)
            continue
        if not raw_text.strip():
            attempt_info["failure"] = "empty output"
            detail["attempts"].append(attempt_info)
            continue
        payload = extract_json_object(raw_text)
        if payload is None:
            attempt_info["failure"] = "no JSON object found in output"
            detail["attempts"].append(attempt_info)
            continue
        problems = validate_vote_payload(payload)
        if problems:
            attempt_info["failure"] = "invalid vote payload: " + "; ".join(problems)
            detail["attempts"].append(attempt_info)
            continue
        attempt_info["ok"] = True
        detail["attempts"].append(attempt_info)
        return clean_vote_payload(payload), model_label, detail
    return None, model_label, detail


def collect_injected_vote(vote_file, expected_prompt_sha256):
    """Parse a host-provided judge reply (a native seat). No retry is possible
    for an injected file; failures make the seat absent.

    The reply must echo the judge-prompt body hash it answered
    (judge_prompt_sha256, per the binding block appended to the on-disk
    judge_prompt.md); a missing or mismatched echo means the reply was
    formed against some other rendering -- an earlier one, a different
    out-dir's, or none at all -- and the seat fails rather than binding a
    reply to a prompt it never saw. clean_vote_payload drops the key after
    this check, so the stored vote record is unchanged.
    """
    try:
        raw_text = Path(vote_file).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, "cannot read injected vote file as UTF-8 text: %s" % exc
    payload = extract_json_object(raw_text)
    if payload is None:
        return None, "no JSON object found in injected vote file"
    problems = validate_vote_payload(payload)
    if problems:
        return None, "invalid vote payload: " + "; ".join(problems)
    echoed = payload.get("judge_prompt_sha256")
    if echoed != expected_prompt_sha256:
        if echoed is None:
            return None, (
                "injected vote carries no judge_prompt_sha256 echo; a native "
                "reply must copy the hash from the binding block at the end "
                "of judge_prompt.md so collection can verify which rendered "
                "prompt it answered"
            )
        return None, (
            "injected vote echoes judge_prompt_sha256 %s but the current "
            "rendering is %s; the reply was formed against a different "
            "prompt. Re-run --render-prompt-only, have the reply re-formed "
            "against the fresh prompt, then retry" % (echoed, expected_prompt_sha256)
        )
    return clean_vote_payload(payload), None


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

def runner_command_signature(command):
    """Reduce a --runner command template to a signature that identifies the
    underlying command it invokes, ignoring the {prompt}/{system} argument
    placeholders. Two seats with the same signature call the same command."""
    tokens = []
    for token in shlex.split(command):
        # Drop the per-attempt prompt/system paths; keep everything else
        # (interpreter, script path, mode arguments) so that two genuinely
        # different runners are not collapsed together.
        if "{prompt}" in token or "{system}" in token:
            continue
        tokens.append(token)
    return tuple(tokens)


def resolve_execution_signature(family, roster, overrides, specs_override):
    """Return the true underlying execution identity for a family seat: the
    --runner override's command signature when the family is overridden
    (test/custom runner path), otherwise the roster-resolved (runner label,
    effective model string) pair — what a normal, roster-driven run actually
    invokes for this family. Two ROSTER-resolved families collapse to the
    same signature exactly when they would call the identical (runner,
    model) pair, which parse_roster itself already refuses at parse time
    (see the dedicated-runner and runner-model-pair checks there); this
    check is what remains live once a family is --runner-overridden and so
    escapes parse_roster's roster-only view.

    For a kimi/opencode/gemini family, the signature also carries the
    ACTUAL resolved runner-script path (following its IDEA_PAIRWISE_*_RUNNER
    env override, exactly as direct_runner_path does before invoking it),
    not just the runner label: an operator who redirects two different
    dedicated runner labels' env vars at the same literal script is caught
    the same way a roster (runner, model) collision is, even though
    parse_roster's static check cannot see an env var. For codex/claude-cli
    (launcher-routed), the launcher backend tag is carried instead of a
    resolved script path: review-swarm's own deeper config resolution is
    not replicated here.

    Known boundary: the override and roster branches are tagged with
    different leading elements ("runner_override" vs "roster") and are
    never compared against each other, so a --runner override that happens
    to invoke the exact same underlying command as an un-overridden roster
    family is not detected. --runner is documented as a test/custom-runner
    escape hatch, not a normal production path; closing this would require
    parsing arbitrary override command templates to recognize when one
    denotes a known runner+model, which is not attempted here. Likewise not
    covered: whether the "native" family is, on this particular host,
    secretly the same underlying model as some other declared family (the
    tool has no way to identify what model the host itself is running as —
    see builtin_roster's docstring on the same limitation).
    """
    if family in overrides:
        return ("runner_override",) + runner_command_signature(overrides[family])
    entry = roster["families"][family]
    runner = entry["runner"]
    model = specs_override.get(family, entry["model"])
    if runner in DIRECT_RUNNER_ENV:
        # A constant discriminator, not the (possibly different) runner
        # label: two DIFFERENT dedicated runner labels (e.g. kimi and
        # gemini) whose env vars happen to resolve to the identical script
        # path must collide on that path, not stay apart because their
        # labels differ. os.path.realpath canonicalizes the comparison so a
        # symlink, a relative form, or a path with ".." segments naming the
        # same physical script still collides (realpath leaves a
        # nonexistent path as-is after normalization, so this stays a pure
        # comparison aid and never raises on an unbuilt path).
        return (
            "roster",
            "direct_runner",
            os.path.realpath(str(direct_runner_path(runner))),
            model,
        )
    if runner in LAUNCHER_BACKENDS:
        return ("roster", "launcher", LAUNCHER_BACKENDS[runner], model)
    return ("roster", runner, model)


def check_runner_independence(signatures_by_family, allow_shared):
    """Return (independent, groups). Raise PanelError when two or more family
    seats resolve to the same underlying execution signature (see
    resolve_execution_signature) and the escape hatch is off.

    groups maps each shared signature to the families that use it.
    """
    signatures = {}
    for family, signature in signatures_by_family.items():
        signatures.setdefault(signature, []).append(family)
    shared = {
        sig: sorted(fams) for sig, fams in signatures.items() if len(fams) > 1
    }
    independent = not shared
    if shared and not allow_shared:
        collisions = "; ".join(
            "%s share one command" % ", ".join(fams) for fams in shared.values()
        )
        raise PanelError(
            "these family seats point at the same underlying command (%s); a "
            "real match needs genuinely different family runners. Set %s=1 to "
            "override for a test or single-model dry run, which stamps the "
            "panel report independent_runners = false"
            % (collisions, ALLOW_SHARED_RUNNERS_ENV)
        )
    return independent, shared


def parse_kv_list(pairs, what, allowed_keys):
    out = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise PanelError("%s must look like family=value, got %r" % (what, pair))
        key, value = pair.split("=", 1)
        key = key.strip()
        if key not in allowed_keys:
            raise PanelError("%s refers to unknown family %r" % (what, key))
        out[key] = value
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Run the cross-family judge panel for one pairwise match."
    )
    parser.add_argument("--materials-dir", required=True, type=Path)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Panel output directory (required except for the two "
        "materials-rendering modes).",
    )
    parser.add_argument(
        "--roster",
        type=Path,
        default=None,
        help="Explicit agent roster file (agents.json, schema version 1). "
        "When omitted, the roster is discovered by walking up from the "
        "materials directory to a project-level .nullius/agents.json, then "
        "the user-level ~/.nullius/agents.json, then the built-in "
        "pure-native roster.",
    )
    parser.add_argument(
        "--families",
        default=None,
        help="Comma-separated subset of the roster's families "
        "(default: every family the roster declares).",
    )
    parser.add_argument(
        "--native-vote",
        action="append",
        default=[],
        type=Path,
        metavar="FILE",
        help="File holding one host subagent's raw judge reply for the "
        "roster's native-runner family. Give it once for the native seat of "
        "a cross-family panel; repeat it once per seat when the panel has "
        "degraded to native subagent seats.",
    )
    parser.add_argument(
        "--model-spec",
        action="append",
        default=[],
        metavar="FAMILY=MODEL",
        help="Override one roster family's model string for this run, "
        "e.g. somefamily=some-provider/some-model",
    )
    parser.add_argument(
        "--model-label",
        action="append",
        default=[],
        metavar="FAMILY=LABEL",
        help="Model label recorded in the vote file (overrides launcher metadata).",
    )
    parser.add_argument(
        "--runner",
        action="append",
        default=[],
        metavar="FAMILY=COMMAND",
        help="Replace a family's runner with a command template; {prompt} and "
        "{system} expand to the rendered prompt paths and stdout is taken as "
        "the judge's raw reply. Intended for tests and custom runners.",
    )
    parser.add_argument("--timeout-secs", type=int, default=900)
    parser.add_argument(
        "--render-prompt-only",
        action="store_true",
        help="Render judge_prompt.md and judge_system.md into --out-dir, then stop.",
    )
    parser.add_argument(
        "--render-statement-prompts",
        action="store_true",
        help="Render statement_request_a.md and statement_request_b.md into the "
        "materials directory from --card-a/--card-b, then stop.",
    )
    parser.add_argument(
        "--render-card-summaries",
        action="store_true",
        help="Render card_summary_a.md and card_summary_b.md into the materials "
        "directory from --card-a/--card-b, then stop.",
    )
    parser.add_argument("--card-a", type=Path, help="Idea card JSON for idea A.")
    parser.add_argument("--card-b", type=Path, help="Idea card JSON for idea B.")
    parser.add_argument("--word-cap", type=int, default=DEFAULT_WORD_CAP)
    args = parser.parse_args(argv)

    try:
        return _run(args)
    except PanelError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1


def _parse_requested_families(families_arg, roster):
    """Return the requested family list: every roster family by default, or
    the --families subset validated against the roster."""
    roster_families = list(roster["families"])
    if families_arg is None:
        return roster_families
    families = []
    for name in families_arg.split(","):
        name = name.strip()
        if not name:
            continue
        if name not in roster["families"]:
            raise PanelError(
                "unknown family %r (the roster declares: %s)"
                % (name, ", ".join(roster_families))
            )
        if name in families:
            raise PanelError("family %r listed twice" % name)
        families.append(name)
    if not families:
        raise PanelError("no families requested")
    return families


def _unavailable_reason(entry):
    reason = "declared unavailable in the roster"
    if entry["notes"]:
        reason += ": " + entry["notes"]
    return reason


def _run(args):
    materials_dir = Path(args.materials_dir)

    # Rendering modes that only need the commitment (and cards).
    if args.render_statement_prompts or args.render_card_summaries:
        if not args.card_a or not args.card_b:
            raise PanelError("--card-a and --card-b are required for rendering modes")
        commitment_path = materials_dir / REQUIRED_MATERIALS["commitment"]
        if not commitment_path.is_file():
            raise PanelError(
                "commitment.json not found in %s; run commit_criteria.py first "
                "(the commitment always precedes statements)" % materials_dir
            )
        commitment = json.loads(commitment_path.read_text(encoding="utf-8"))
        problems = commit_criteria.validate_commitment(commitment)
        if problems:
            raise PanelError("commitment.json failed validation: " + "; ".join(problems))
        card_texts = {
            "a": args.card_a.read_text(encoding="utf-8"),
            "b": args.card_b.read_text(encoding="utf-8"),
        }
        if args.render_card_summaries:
            for side in ("a", "b"):
                out = materials_dir / ("card_summary_%s.md" % side)
                out.write_text(render_card_summary(side, card_texts[side]), encoding="utf-8")
                print("rendered %s" % out)
        if args.render_statement_prompts:
            for side in ("a", "b"):
                text = render_statement_prompt(
                    side, card_texts[side], commitment, args.word_cap
                )
                out = materials_dir / ("statement_request_%s.md" % side)
                out.write_text(text, encoding="utf-8")
                print("rendered %s" % out)
        return 0

    texts, commitment = load_materials(materials_dir, word_cap=args.word_cap)
    parsed_discarded = {
        "statement_a": texts.get("_discarded_a", 0),
        "statement_b": texts.get("_discarded_b", 0),
    }

    if args.out_dir is None:
        raise PanelError("--out-dir is required to render the judge prompt or run the panel")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    judge_prompt_path = out_dir / "judge_prompt.md"
    judge_system_path = out_dir / "judge_system.md"
    judge_prompt_text = render_judge_prompt(texts, commitment)
    # The hash covers the rendered BODY (what assembly can rebuild from the
    # materials alone); it is recorded in the report so assembly can rebuild
    # this exact text from the CURRENT materials and refuse to assemble
    # votes if the materials moved since this panel ran (see the cross-check
    # in assemble_match.py's read_panel_report).
    judge_prompt_sha256 = "sha256:" + hashlib.sha256(
        judge_prompt_text.encode("utf-8")
    ).hexdigest()
    # The on-disk file a host subagent reads carries one extra block after
    # the body: an instruction to echo the body hash back inside its vote
    # JSON. An injected native reply is formed in a separate invocation from
    # the one that collects it, so the reply itself must carry proof of
    # WHICH rendered prompt it answered; collection verifies the echoed
    # hash against the current body (see collect_injected_vote). The block
    # is a deterministic function of the body, so comparing full file texts
    # below remains a pure materials-change detector.
    judge_prompt_file_text = judge_prompt_text + INJECTED_BINDING_TEMPLATE % judge_prompt_sha256
    # The documented native-vote workflow is two invocations: one
    # --render-prompt-only pass a host subagent reads and answers from, then
    # a SEPARATE --native-vote pass that injects the reply. If materials
    # changed between those two invocations, the injected reply reflects a
    # prompt this invocation is about to overwrite, not the one it is about
    # to bind the vote to. Catch that here, before anything is overwritten:
    # read whatever judge_prompt.md an earlier invocation already left, and
    # if this invocation is injecting a native vote and that text differs
    # from what this invocation just rendered, refuse rather than silently
    # binding a stale reply to a fresh hash. (The hash echo verified at
    # collection closes the remaining variants -- a deleted or missing
    # earlier rendering, a different out-dir, an intermediate re-render --
    # this early check just gives the clearest message for the common case.)
    previous_prompt_text = (
        judge_prompt_path.read_text(encoding="utf-8") if judge_prompt_path.is_file() else None
    )
    if (
        args.native_vote
        and previous_prompt_text is not None
        and previous_prompt_text != judge_prompt_file_text
    ):
        raise PanelError(
            "%s reflects an earlier rendering that no longer matches the "
            "current materials, but --native-vote was given: the injected "
            "reply may have been formed against that earlier prompt. "
            "Re-run with --render-prompt-only against the current "
            "materials, have the reply re-formed against the fresh prompt, "
            "then retry --native-vote" % judge_prompt_path
        )
    judge_prompt_path.write_text(judge_prompt_file_text, encoding="utf-8")
    judge_system_path.write_text(
        (PROMPTS_DIR / "judge_system.md").read_text(encoding="utf-8"), encoding="utf-8"
    )
    print("rendered %s" % judge_prompt_path)
    if args.render_prompt_only:
        return 0

    # Panel execution starts here, and the judge prompt above was just
    # rebuilt from the CURRENT materials. Invalidate any earlier run's report
    # NOW, before roster resolution and every later refusal: a run that stops
    # at any point past this line — a roster problem, a usage refusal, a
    # duplicated seat reply, a crash — must never leave an old panel_valid
    # report through which the previous run's votes could be assembled
    # against materials that may since have changed. Assembly refuses a
    # panel directory without a report.
    (out_dir / "panel_run_report.json").unlink(missing_ok=True)

    roster, roster_source, roster_path = resolve_roster(args.roster, materials_dir)
    families = _parse_requested_families(args.families, roster)
    specs_override = parse_kv_list(args.model_spec, "--model-spec", set(families))
    labels = parse_kv_list(args.model_label, "--model-label", set(families))
    overrides = parse_kv_list(args.runner, "--runner", set(families))

    native_family = native_family_of(roster)
    native_votes = list(args.native_vote)
    if native_votes and native_family is None:
        raise PanelError(
            "--native-vote given but the roster declares no native-runner family"
        )
    for family, value in specs_override.items():
        if roster["families"][family]["runner"] == "native" and family not in overrides:
            raise PanelError(
                "--model-spec for %r: a native seat takes no model override"
                % family
            )
        if not MODEL_STRING_RE.fullmatch(value):
            raise PanelError(
                "--model-spec for %r must be a plain model string (pattern %s), "
                "got %r" % (family, MODEL_STRING_RE.pattern, value)
            )

    # The degradation decision is made over the WHOLE roster, not the
    # --families subset: a roster that can field the floor is never dropped
    # into single-family mode by requesting fewer families (that request just
    # runs a cross-family panel that fails the vote floor). Degradation is
    # for a roster that genuinely cannot field the floor.
    roster_available = [
        label for label, entry in roster["families"].items() if entry["available"]
    ]
    available_requested = [f for f in families if roster["families"][f]["available"]]
    floor = roster["cross_family_minimum"]
    degraded = len(roster_available) < floor

    multi_task = Path(os.environ.get("IDEA_PAIRWISE_MULTI_TASK", DEFAULT_MULTI_TASK))

    # Created lazily by the first stored vote, so a run refused before any
    # seat executes (a shared-runner guard trip, a roster problem) leaves no
    # empty votes directory behind.
    votes_dir = out_dir / "votes"

    started_at = commit_criteria.utc_now_iso()
    votes = {}            # vote key (family, or family_seat_N) -> path relative to out_dir
    voted_families = {}   # vote key -> family label
    absent = []
    seats_failed = []
    details = {}

    def store_vote(key, family, payload, model_label, detail, seat=None):
        record = {
            "reviewer_family": family,
            "model": labels.get(family, model_label),
            "vote": payload["vote"],
            "anchored_arguments": payload["anchored_arguments"],
            "unanchored_arguments_discarded": payload["unanchored_arguments_discarded"],
            "commitment_hash": commitment["commitment_hash"],
            "collected_at": commit_criteria.utc_now_iso(),
            "collection": detail,
        }
        if seat is not None:
            record["seat"] = seat
        votes_dir.mkdir(parents=True, exist_ok=True)
        vote_path = votes_dir / ("%s.json" % key)
        commit_criteria.write_json_atomic(vote_path, record)
        votes[key] = str(vote_path.relative_to(out_dir))
        voted_families[key] = family
        details[key] = detail

    def finish(independence, independent_runners, panel_valid, extra):
        """Write panel_run_report.json and print the shared summary lines."""
        # The parser's own count of unanchored argument lines it dropped, per
        # side and in total. This is the authoritative discard count; each
        # judge also self-reports one, and any voter whose number disagrees is
        # flagged so the two can be reconciled by an auditor.
        parsed_total = parsed_discarded["statement_a"] + parsed_discarded["statement_b"]
        discard_reconciliation = []
        for key in sorted(votes):
            record = json.loads((out_dir / votes[key]).read_text(encoding="utf-8"))
            reported = record.get("unanchored_arguments_discarded")
            discard_reconciliation.append(
                {
                    "voter": key,
                    "judge_reported": reported,
                    "parser_counted": parsed_total,
                    "agree": reported == parsed_total,
                }
            )
        report = {
            "roster": {
                "source": roster_source,
                "path": str(roster_path) if roster_path is not None else None,
            },
            "families_requested": families,
            "votes_collected": {key: votes[key] for key in sorted(votes)},
            "families_present": sorted(set(voted_families.values())),
            "absent": sorted(absent, key=lambda item: item["family"]),
            "independence": independence,
            "independent_runners": independent_runners,
            "commitment_hash": commitment["commitment_hash"],
            # The exact judge-prompt text this panel voted on, and the
            # word_cap it was rendered with, so assembly can rebuild the same
            # text from the CURRENT materials_dir and refuse to assemble
            # votes if materials moved since this panel ran (see
            # read_panel_report in assemble_match.py).
            "judge_prompt_sha256": judge_prompt_sha256,
            "word_cap": args.word_cap,
            "min_families": floor,
            "panel_valid": panel_valid,
            "unanchored_arguments_discarded_by_parser": {
                "statement_a": parsed_discarded["statement_a"],
                "statement_b": parsed_discarded["statement_b"],
                "total": parsed_total,
            },
            "discard_reconciliation": discard_reconciliation,
            "started_at": started_at,
            "finished_at": commit_criteria.utc_now_iso(),
        }
        report.update(extra)
        commit_criteria.write_json_atomic(out_dir / "panel_run_report.json", report)
        for key in sorted(votes):
            print("vote collected: %s -> %s" % (key, votes[key]))
        for item in discard_reconciliation:
            if not item["agree"]:
                print(
                    "warning: %s reported %s unanchored discards; the parser "
                    "counted %d (self-report and mechanism disagree)"
                    % (item["voter"], item["judge_reported"], item["parser_counted"])
                )
        for item in report["absent"]:
            print("family absent: %s (%s)" % (item["family"], item["reason"]))
        return report

    if degraded:
        return _run_native_panel(
            roster, families, roster_available, floor, native_family,
            native_votes, overrides, specs_override, absent, seats_failed,
            store_vote, finish, votes, judge_prompt_path, judge_system_path,
            judge_prompt_sha256,
        )

    # ------------------------------------------------------------------
    # Cross-family panel (the roster fields at least the floor's worth of
    # available families).
    # ------------------------------------------------------------------
    if len(native_votes) > 1:
        raise PanelError(
            "a cross-family panel seats one native vote; %d files given"
            % len(native_votes)
        )
    if native_votes and native_family not in families:
        raise PanelError(
            "--native-vote given but the native-runner family %r is not requested"
            % native_family
        )
    if native_votes and not roster["families"][native_family]["available"]:
        raise PanelError(
            "--native-vote given but the native-runner family %r is declared "
            "unavailable in the roster" % native_family
        )
    if native_votes and overrides.get(native_family):
        raise PanelError(
            "both --native-vote and a --runner override target the native "
            "family %r; give one or the other" % native_family
        )
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    def handle_result(family, payload, model_label, failure_reason, detail):
        if payload is None:
            absent.append({"family": family, "reason": failure_reason})
            details[family] = detail
            return
        store_vote(family, family, payload, model_label, detail)

    # Families the roster declares unavailable are absent up front and are
    # never invoked; their reason carries the roster's own notes.
    for family in families:
        if family not in available_requested:
            absent.append(
                {"family": family, "reason": _unavailable_reason(roster["families"][family])}
            )

    # The native seat is injected inline (no subprocess) unless a --runner
    # override replaces it for a test. Its recorded model is the roster's
    # declared model string for the native family (the model the host is
    # expected to run the subagent as); --model-label pins a different one.
    runner_families = list(available_requested)
    if native_family in available_requested and not overrides.get(native_family):
        runner_families.remove(native_family)
        if native_votes:
            payload, failure = collect_injected_vote(native_votes[0], judge_prompt_sha256)
            detail = {
                "source": "injected",
                "vote_file": str(native_votes[0]),
                "attempts": [{"attempt": 1, "ok": payload is not None}],
            }
            native_label = "%s/%s" % (
                native_family, roster["families"][native_family]["model"],
            )
            handle_result(native_family, payload, native_label, failure, detail)
        else:
            absent.append(
                {
                    "family": native_family,
                    "reason": "native seat: no vote file injected (--native-vote)",
                }
            )

    # Independence is checked over the true execution identity of every
    # family this run actually dispatches through a subprocess seat
    # (runner_families) — a roster-resolved (runner, model) pair when no
    # --runner override applies, the override's command signature when one
    # does. Checking only the override map would miss the far more common
    # case: several roster family labels quietly pointing at the same
    # physical backend, which a normal roster-driven run never touches
    # overrides for at all. The native seat is not in this population: it is
    # injected inline, not dispatched, and single_family mode already
    # declares independent_runners = false on its own.
    allow_shared = os.environ.get(ALLOW_SHARED_RUNNERS_ENV) == "1"
    execution_signatures = {
        family: resolve_execution_signature(family, roster, overrides, specs_override)
        for family in runner_families
    }
    independent_runners, _shared = check_runner_independence(execution_signatures, allow_shared)
    # --runner is a test/custom-runner escape hatch, and an override command
    # is an arbitrary shell template this script deliberately does not parse
    # deeply enough to compare against roster-resolved seats (the two
    # signature namespaces are incomparable by design). So the moment ANY
    # participating seat runs through an override, the panel's independence
    # can no longer be vouched for mechanically -- stamp it false rather
    # than let a mixed run carry a claim the check cannot actually back.
    # The collision check above still runs first, so overrides that
    # literally share one command are still refused outright.
    if any(family in overrides for family in runner_families):
        independent_runners = False

    def worker(family):
        family_dir = raw_dir / family
        family_dir.mkdir(parents=True, exist_ok=True)
        entry = roster["families"][family]
        payload, model_label, detail = run_family(
            family,
            entry["runner"],
            specs_override.get(family, entry["model"]),
            overrides.get(family),
            judge_system_path,
            judge_prompt_path,
            family_dir,
            args.timeout_secs,
            multi_task,
        )
        failure = None
        if payload is None:
            failures = [a.get("failure", "unknown") for a in detail["attempts"]]
            failure = "; ".join(failures) if failures else "no attempt recorded"
        return family, payload, model_label, failure, detail

    if runner_families:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(runner_families)) as pool:
            for family, payload, model_label, failure, detail in pool.map(
                worker, runner_families
            ):
                handle_result(family, payload, model_label, failure, detail)

    panel_valid = len(votes) >= floor
    finish("cross_family", independent_runners, panel_valid, {})
    if not panel_valid:
        print(
            "error: only %d of the requested families voted (minimum %d); "
            "panel is invalid and the match is terminated"
            % (len(votes), floor),
            file=sys.stderr,
        )
        return 2
    print("panel valid: %d family votes collected" % len(votes))
    return 0


def _run_native_panel(roster, families, roster_available, floor, native_family,
                      native_votes, overrides, specs_override, absent,
                      seats_failed, store_vote, finish, votes,
                      judge_prompt_path, judge_system_path,
                      judge_prompt_sha256):
    """Degraded panel: the roster cannot field the cross-family floor, so per
    policy when_below_minimum = native_subagents the seats are independent
    host subagent instances of the roster's native-runner family, one injected
    reply file per seat. The report and the artifact both carry independence =
    "single_family" and independent_runners = false, so this panel is never
    mistaken for a cross-family one."""
    if overrides or specs_override:
        raise PanelError(
            "the roster fields %d available families of the %d required; the "
            "panel degrades to native subagent seats, which take no --runner "
            "or --model-spec" % (len(roster_available), floor)
        )
    if native_family is None or not roster["families"][native_family]["available"]:
        detail = (
            "declares no native-runner family" if native_family is None
            else "declares its native-runner family %r unavailable" % native_family
        )
        raise PanelError(
            "the roster fields %d available families of the %d required and "
            "%s; the panel cannot run"
            % (len(roster_available), floor, detail)
        )

    # Two seats fed from the same reply cannot be independent: refuse a file
    # given twice up front, and refuse byte-identical reply contents below.
    resolved_files = [Path(p).resolve() for p in native_votes]
    if len(set(resolved_files)) != len(resolved_files):
        raise PanelError(
            "the same --native-vote file was given for more than one seat; "
            "every seat needs its own subagent's reply file"
        )

    # Every requested family except the native seat is absent, with the reason
    # split between roster-declared unavailability and the degradation itself.
    for family in families:
        if family == native_family:
            continue
        entry = roster["families"][family]
        if not entry["available"]:
            reason = _unavailable_reason(entry)
        else:
            reason = (
                "cross-family floor not met (%d of %d available); the panel "
                "degraded to native subagent seats and this seat was not run"
                % (len(roster_available), floor)
            )
        absent.append({"family": family, "reason": reason})

    native_model = roster["families"][native_family]["model"]
    extra = {"native_family": native_family, "seats_provided": len(native_votes)}
    if len(native_votes) < floor:
        finish("single_family", False, False, dict(extra, seats_failed=seats_failed))
        print(
            "cross-family floor not met: the roster fields %d available "
            "families of the %d required (policy when_below_minimum = "
            "native_subagents). Run %d independent host subagent seats "
            "(roster model for the native family: %s), each answering %s "
            "(system prompt %s) blind to the other seats; save each seat's "
            "raw reply to its own file and re-run this command with one "
            "--native-vote FILE per seat (%d file(s) given so far)."
            % (
                len(roster_available), floor, floor, native_model,
                judge_prompt_path, judge_system_path, len(native_votes),
            ),
            file=sys.stderr,
        )
        return 3

    # Two stages, validate then write: every reply is read, hashed against
    # the others, and parsed BEFORE any vote file is written, so a refusal
    # (a duplicated reply) leaves no partially written seat set behind.
    model_label = "%s/%s" % (native_family, native_model)
    seen_replies = {}
    validated = []
    for seat, vote_file in enumerate(native_votes, start=1):
        # Hash the RAW BYTES: reading in text mode first would fold CRLF into
        # LF (universal newlines), so two byte-distinct replies could hash
        # alike and the recorded digest would not be the file's true sha256.
        try:
            raw_bytes = Path(vote_file).read_bytes()
        except OSError as exc:
            seats_failed.append(
                {"seat": seat, "reason": "cannot read injected vote file: %s" % exc}
            )
            continue
        digest = hashlib.sha256(raw_bytes).hexdigest()
        if digest in seen_replies:
            raise PanelError(
                "seat %d's reply file (%s) is byte-identical to seat %d's; "
                "independent subagent seats cannot share one reply"
                % (seat, vote_file, seen_replies[digest])
            )
        seen_replies[digest] = seat
        try:
            raw_text = raw_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            seats_failed.append(
                {"seat": seat, "reason": "reply is not UTF-8 text: %s" % exc}
            )
            continue
        payload = extract_json_object(raw_text)
        failure = None
        if payload is None:
            failure = "no JSON object found in injected vote file"
        else:
            problems = validate_vote_payload(payload)
            if problems:
                failure = "invalid vote payload: " + "; ".join(problems)
            else:
                # Same prompt binding as the cross-family injected seat
                # (collect_injected_vote): each seat's reply is formed in a
                # separate invocation, so it must echo the hash of the
                # rendered prompt it actually answered.
                echoed = payload.get("judge_prompt_sha256")
                if echoed != judge_prompt_sha256:
                    if echoed is None:
                        failure = (
                            "reply carries no judge_prompt_sha256 echo; copy "
                            "the hash from the binding block at the end of "
                            "judge_prompt.md into the vote JSON"
                        )
                    else:
                        failure = (
                            "reply echoes judge_prompt_sha256 %s but the "
                            "current rendering is %s; the reply was formed "
                            "against a different prompt" % (echoed, judge_prompt_sha256)
                        )
        if failure is not None:
            seats_failed.append({"seat": seat, "reason": failure})
            continue
        validated.append((seat, vote_file, digest, clean_vote_payload(payload)))

    for seat, vote_file, digest, payload in validated:
        detail = {
            "source": "injected",
            "vote_file": str(vote_file),
            "reply_sha256": "sha256:" + digest,
            "attempts": [{"attempt": 1, "ok": True}],
        }
        store_vote(
            "%s_seat_%d" % (native_family, seat), native_family,
            payload, model_label, detail, seat=seat,
        )

    panel_valid = len(votes) >= floor
    finish("single_family", False, panel_valid, dict(extra, seats_failed=seats_failed))
    for item in seats_failed:
        print("seat absent: %s seat %d (%s)" % (native_family, item["seat"], item["reason"]))
    if not panel_valid:
        print(
            "error: only %d of %d native subagent seats produced a valid vote "
            "(minimum %d); panel is invalid and the match is terminated"
            % (len(votes), len(native_votes), floor),
            file=sys.stderr,
        )
        return 2
    print(
        "panel valid: %d native subagent seat votes collected (single-family, "
        "degraded)" % len(votes)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
