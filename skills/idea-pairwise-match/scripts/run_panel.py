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

  claude    host-subagent vote injected via --claude-vote FILE (preferred),
            else the claude CLI through the review-swarm launcher
  codex     review-swarm launcher (scripts/bin/run_multi_task.py)
  opencode  review-swarm launcher
  kimi      kimi-cli-runner (the launcher has no kimi runner today)

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

Vote JSON is extracted fence-first: fenced ```json blocks are tried before
the whole text and before a brace-delimited substring.

Standard library only. Python >= 3.9.
"""

from __future__ import annotations

import argparse
import concurrent.futures
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

FAMILIES = ("claude", "codex", "opencode", "kimi")
MIN_FAMILIES = 3
MAX_ATTEMPTS = 2

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

# Model specs handed to the review-swarm launcher. "default" delegates to the
# CLI's own configured default model (launcher policy); callers pin an
# explicit spec with --model-spec when a run must record a specific model.
DEFAULT_MODEL_SPECS = {
    "claude": "claude/default",
    "codex": "codex/default",
    "opencode": "default",
}

VOTE_VALUES = ("a", "b", "tie")
ANCHOR_TYPES = ("literature", "computation")

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
    filled = template
    for key, value in replacements.items():
        filled = filled.replace("{{" + key + "}}", value)
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


def family_command(family, spec, judge_system, judge_prompt, attempt_dir,
                   timeout_secs, multi_task, kimi_runner):
    """Build (argv, output_file) for one family attempt."""
    if family == "kimi":
        out_file = attempt_dir / "vote_raw.txt"
        argv = [
            "bash",
            str(kimi_runner),
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
        return argv, out_file
    out_file = attempt_dir / "vote_raw.txt"
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
        "%s=vote_raw.txt" % family,
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


def run_family(family, spec, override_cmd, judge_system, judge_prompt,
               family_dir, timeout_secs, multi_task, kimi_runner):
    """Run one family with up to MAX_ATTEMPTS attempts.

    Returns (payload_or_None, model_label, detail dict).
    """
    detail = {"attempts": [], "source": "override" if override_cmd else "runner"}
    model_label = spec if family != "kimi" else "kimi/default"
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
                    family, spec, judge_system, judge_prompt, attempt_dir,
                    timeout_secs, multi_task, kimi_runner,
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


def collect_injected_vote(vote_file):
    """Parse a host-provided judge reply (claude family). No retry is possible
    for an injected file; failures make the family absent."""
    raw_text = Path(vote_file).read_text(encoding="utf-8")
    payload = extract_json_object(raw_text)
    if payload is None:
        return None, "no JSON object found in injected vote file"
    problems = validate_vote_payload(payload)
    if problems:
        return None, "invalid vote payload: " + "; ".join(problems)
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


def check_runner_independence(overrides, allow_shared):
    """Return (independent, groups). Raise PanelError when two or more family
    seats resolve to the same underlying command and the escape hatch is off.

    groups maps each shared command signature to the families that use it.
    """
    signatures = {}
    for family, command in overrides.items():
        signatures.setdefault(runner_command_signature(command), []).append(family)
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
        "--families",
        default=",".join(FAMILIES),
        help="Comma-separated subset of: %s" % ", ".join(FAMILIES),
    )
    parser.add_argument(
        "--claude-vote",
        type=Path,
        help="File holding the host subagent's raw judge reply for the claude "
        "family (preferred claude path; skips the claude CLI).",
    )
    parser.add_argument(
        "--model-spec",
        action="append",
        default=[],
        metavar="FAMILY=SPEC",
        help="Launcher model spec override, e.g. opencode=zhipuai-coding-plan/glm-5.2",
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


def _run(args):
    families = []
    for name in args.families.split(","):
        name = name.strip()
        if not name:
            continue
        if name not in FAMILIES:
            raise PanelError("unknown family %r (known: %s)" % (name, ", ".join(FAMILIES)))
        if name in families:
            raise PanelError("family %r listed twice" % name)
        families.append(name)
    if not families:
        raise PanelError("no families requested")

    specs = dict(DEFAULT_MODEL_SPECS)
    specs.update(parse_kv_list(args.model_spec, "--model-spec", set(FAMILIES)))
    labels = parse_kv_list(args.model_label, "--model-label", set(FAMILIES))
    overrides = parse_kv_list(args.runner, "--runner", set(FAMILIES))
    allow_shared = os.environ.get(ALLOW_SHARED_RUNNERS_ENV) == "1"
    independent_runners, _shared = check_runner_independence(overrides, allow_shared)

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
    judge_prompt_path.write_text(render_judge_prompt(texts, commitment), encoding="utf-8")
    judge_system_path.write_text(
        (PROMPTS_DIR / "judge_system.md").read_text(encoding="utf-8"), encoding="utf-8"
    )
    print("rendered %s" % judge_prompt_path)
    if args.render_prompt_only:
        return 0

    if args.claude_vote and "claude" not in families:
        raise PanelError("--claude-vote given but the claude family is not requested")

    multi_task = Path(os.environ.get("IDEA_PAIRWISE_MULTI_TASK", DEFAULT_MULTI_TASK))
    kimi_runner = Path(os.environ.get("IDEA_PAIRWISE_KIMI_RUNNER", DEFAULT_KIMI_RUNNER))

    votes_dir = out_dir / "votes"
    votes_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = out_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    started_at = commit_criteria.utc_now_iso()
    votes = {}
    absent = []
    details = {}

    def handle_result(family, payload, model_label, failure_reason, detail):
        if payload is None:
            absent.append({"family": family, "reason": failure_reason})
            details[family] = detail
            return
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
        vote_path = votes_dir / ("%s.json" % family)
        commit_criteria.write_json_atomic(vote_path, record)
        votes[family] = str(vote_path.relative_to(out_dir))
        details[family] = detail

    # Claude injection is handled inline (no subprocess).
    runner_families = list(families)
    if "claude" in families and args.claude_vote:
        payload, failure = collect_injected_vote(args.claude_vote)
        detail = {
            "source": "injected",
            "vote_file": str(args.claude_vote),
            "attempts": [{"attempt": 1, "ok": payload is not None}],
        }
        default_label = labels.get("claude", "claude/host-subagent")
        handle_result("claude", payload, default_label, failure, detail)
        runner_families.remove("claude")

    def worker(family):
        family_dir = raw_dir / family
        family_dir.mkdir(parents=True, exist_ok=True)
        payload, model_label, detail = run_family(
            family,
            specs.get(family, "default"),
            overrides.get(family),
            judge_system_path,
            judge_prompt_path,
            family_dir,
            args.timeout_secs,
            multi_task,
            kimi_runner,
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

    panel_valid = len(votes) >= MIN_FAMILIES
    # The parser's own count of unanchored argument lines it dropped, per side
    # and in total. This is the authoritative discard count; each judge also
    # self-reports one, and we flag any judge whose number disagrees so the two
    # can be reconciled by an auditor.
    parsed_total = parsed_discarded["statement_a"] + parsed_discarded["statement_b"]
    discard_reconciliation = []
    for family in sorted(votes):
        record = json.loads((votes_dir / ("%s.json" % family)).read_text(encoding="utf-8"))
        reported = record.get("unanchored_arguments_discarded")
        discard_reconciliation.append(
            {
                "family": family,
                "judge_reported": reported,
                "parser_counted": parsed_total,
                "agree": reported == parsed_total,
            }
        )
    report = {
        "families_requested": families,
        "votes_collected": {f: votes[f] for f in sorted(votes)},
        "absent": sorted(absent, key=lambda item: item["family"]),
        "commitment_hash": commitment["commitment_hash"],
        "min_families": MIN_FAMILIES,
        "panel_valid": panel_valid,
        "independent_runners": independent_runners,
        "unanchored_arguments_discarded_by_parser": {
            "statement_a": parsed_discarded["statement_a"],
            "statement_b": parsed_discarded["statement_b"],
            "total": parsed_total,
        },
        "discard_reconciliation": discard_reconciliation,
        "started_at": started_at,
        "finished_at": commit_criteria.utc_now_iso(),
    }
    commit_criteria.write_json_atomic(out_dir / "panel_run_report.json", report)

    for family in sorted(votes):
        print("vote collected: %s -> %s" % (family, votes[family]))
    for item in discard_reconciliation:
        if not item["agree"]:
            print(
                "warning: %s reported %s unanchored discards; the parser counted "
                "%d (self-report and mechanism disagree)"
                % (item["family"], item["judge_reported"], item["parser_counted"])
            )
    for item in report["absent"]:
        print("family absent: %s (%s)" % (item["family"], item["reason"]))
    if not panel_valid:
        print(
            "error: only %d of the requested families voted (minimum %d); "
            "panel is invalid and the match is terminated"
            % (len(votes), MIN_FAMILIES),
            file=sys.stderr,
        )
        return 2
    print("panel valid: %d family votes collected" % len(votes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
