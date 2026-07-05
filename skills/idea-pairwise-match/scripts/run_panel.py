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
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import commit_criteria  # noqa: E402

FAMILIES = ("claude", "codex", "opencode", "kimi")
MIN_FAMILIES = 3
MAX_ATTEMPTS = 2

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
FENCE_RE = re.compile(r"```(?:json)?[ \t]*\n(.*?)\n?```", re.DOTALL)
DEFAULT_WORD_CAP = 600


class PanelError(RuntimeError):
    """Raised for contract violations that must stop the panel."""


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

def load_materials(materials_dir):
    """Load and verify the five materials files; return a dict of texts plus
    the parsed commitment. Raises PanelError on any contract violation."""
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

    texts, commitment = load_materials(materials_dir)

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
    report = {
        "families_requested": families,
        "votes_collected": {f: votes[f] for f in sorted(votes)},
        "absent": sorted(absent, key=lambda item: item["family"]),
        "commitment_hash": commitment["commitment_hash"],
        "min_families": MIN_FAMILIES,
        "panel_valid": panel_valid,
        "started_at": started_at,
        "finished_at": commit_criteria.utc_now_iso(),
    }
    commit_criteria.write_json_atomic(out_dir / "panel_run_report.json", report)

    for family in sorted(votes):
        print("vote collected: %s -> %s" % (family, votes[family]))
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
