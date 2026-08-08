#!/usr/bin/env python3
"""
Fold-boundary gate: a converged cycle's traceability registration must be
DECLARED in the adjudication and must MATCH the project's traceability
record before results are folded.

Milestone convergence is the moment "which result is current" changes, so
the convergence deliverable includes updating the traceability record —
registering the headline result, superseding replaced runs, stamping
rewritten memo sections. Left as prose ("remember to register"), measured
adoption shows it simply does not happen. This gate is the machine consumer
at the already-mandatory fold boundary, next to
check_adjudication_completeness.py: the adjudication carries an explicit
`## Result registration` declaration, and every declared fact is verified
against the read model (`nullius current --json`) — declared-but-absent is
a refusal, and an absent declaration section is a refusal.

Declaration grammar (the adjudication builder emits the fillable template):

    ## Result registration

    - Headline result: <result-id> @ <run_id>
    - Headline result: none — <why this milestone bears no headline result>
    - Supersedes: <old_run_id> -> <new_run_id>        (repeatable)
    - Supersedes: none
    - Rewritten sections: "<heading>"; "<heading>"
    - Rewritten sections: none

Checks (fail-closed, scoped to the DECLARED objects — historical defects on
undeclared objects belong to `nullius current`, not to this fold):
  - a declared headline result must be a current, non-defective row of the
    results registry bound to the declared run (`nullius result set-current`
    at adjudication time is what puts it there);
  - "none" for the headline requires a stated reason (a milestone that bears
    no headline result is legitimate, but say so deliberately);
  - every declared supersession must already be recorded on the validity
    ledger with the declared replacement;
  - every declared rewritten section must exist in the notebook and carry a
    fresh written-against stamp (class current / current-modulo-untracked);
  - a PRESENT notebook current-state block must be in sync with its
    canonical render (a present block claims currency; an out-of-sync one
    is a false claim — `nullius notebook sync` refreshes it). A MISSING
    block claims nothing and is advisory territory, never a fold refusal;
  - a declared rewritten section must carry zero unacknowledged links to
    superseded/void runs (the read model accepts any acknowledgment
    channel: a visible superseded/void word in the CITING paragraph or
    list item, a link to the replacement run anywhere in the section, or a
    declared log-role section).

Scope limits (deliberate): this gate does not audit undeclared runs, does
not enforce global ledger cleanliness, and does not re-check the cycle
run's own stamp — the run-creation entrances stamp automatically and the
read model reports gaps.

SKIP (exit 0) when: the cycle is not converged (upstream forbids folding
anyway), or the project has no nullius launcher (the registration contract
is mandatory only where the project has one).

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (declaration missing / malformed / does not match the record)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from convergence_schema import validate_convergence_result  # type: ignore

SECTION_HEADING = "Result registration"
# Tolerates the builder's numbered form ("## 6) Result registration").
_SECTION_RE = re.compile(r"^\s{0,3}##\s+(?:\d+\)\s+)?Result registration\s*$", re.MULTILINE | re.IGNORECASE)
_NEXT_SECTION_RE = re.compile(r"^\s{0,3}##\s+", re.MULTILINE)

_HEADLINE_NONE_RE = re.compile(r"^none\s*[—–-]\s*(?P<reason>\S.*)$", re.IGNORECASE)
_HEADLINE_RE = re.compile(r"^(?P<result_id>\S+)\s+@\s+(?P<run_id>\S+)$")
# The optional trailing note requires WHITESPACE around its dash: run ids
# are full of hyphens, and a zero-width separator match would truncate
# `...-r010-final` into `...` plus a phantom note.
_SUPERSEDES_RE = re.compile(r"^(?P<old>\S+)\s*->\s*(?P<new>\S+)(?:\s+[—–-]\s+\S.*)?$")
# A heading is wrapped in double quotes OR backticks — the alternative
# exists because a heading may itself contain a double quote (headings are
# literal text); a heading containing BOTH wrappers stays out of the
# grammar and must be renamed to be declarable.
_QUOTED_HEADING_RE = re.compile(r'"([^"]+)"|`([^`]+)`')


def _fail(messages: list[str]) -> int:
    for message in messages:
        print(f"- FAIL: {message}", file=sys.stderr)
    print(json.dumps({"status": "fail", "failures": messages}))
    return 1


def _input_error(message: str) -> int:
    print(f"- Gate error: {message}", file=sys.stderr)
    print(json.dumps({"status": "error", "reason": message}))
    return 2


def _skip(reason: str) -> int:
    print(f"- Gate: SKIP ({reason})", file=sys.stderr)
    print(json.dumps({"status": "skip", "reason": reason}))
    return 0


def extract_registration_section(adjudication_text: str) -> str | None:
    match = _SECTION_RE.search(adjudication_text)
    if not match:
        return None
    start = match.end()
    nxt = _NEXT_SECTION_RE.search(adjudication_text, start)
    return adjudication_text[start : nxt.start() if nxt else len(adjudication_text)]


class Declaration:
    def __init__(self) -> None:
        self.headline: tuple[str, str] | None = None  # (result_id, run_id)
        self.headline_none_reason: str | None = None
        self.headline_lines = 0
        self.supersedes: list[tuple[str, str]] = []  # (old, new)
        self.supersedes_none = False
        self.supersedes_lines = 0
        self.rewritten: list[str] = []
        self.rewritten_none = False
        self.rewritten_lines = 0
        self.errors: list[str] = []


def parse_declaration(section: str) -> Declaration:
    decl = Declaration()
    for raw_line in section.splitlines():
        line = raw_line.strip()
        if not line.startswith("-"):
            continue
        body = line.lstrip("-").strip()
        lowered = body.lower()
        if lowered.startswith("headline result:"):
            decl.headline_lines += 1
            value = body.split(":", 1)[1].strip()
            none_match = _HEADLINE_NONE_RE.match(value)
            if none_match:
                decl.headline_none_reason = none_match.group("reason").strip()
                continue
            if value.lower() == "none":
                decl.errors.append(
                    'headline "none" requires a stated reason: `none — <why this milestone bears no headline result>`'
                )
                continue
            pair = _HEADLINE_RE.match(value)
            if not pair:
                decl.errors.append(
                    f"malformed headline declaration {value!r} (expected `<result-id> @ <run_id>` or `none — <reason>`)"
                )
                continue
            decl.headline = (pair.group("result_id"), pair.group("run_id"))
        elif lowered.startswith("supersedes:"):
            decl.supersedes_lines += 1
            value = body.split(":", 1)[1].strip()
            if value.lower() == "none":
                decl.supersedes_none = True
                continue
            pair = _SUPERSEDES_RE.match(value)
            if not pair:
                decl.errors.append(
                    f"malformed supersession declaration {value!r} (expected `<old_run_id> -> <new_run_id>` or `none`)"
                )
                continue
            decl.supersedes.append((pair.group("old"), pair.group("new")))
        elif lowered.startswith("rewritten sections:"):
            decl.rewritten_lines += 1
            value = body.split(":", 1)[1].strip()
            if value.lower() == "none":
                decl.rewritten_none = True
                continue
            headings = [double or backtick for double, backtick in _QUOTED_HEADING_RE.findall(value)]
            if not headings:
                decl.errors.append(
                    f"malformed rewritten-sections declaration {value!r} "
                    '(expected "quoted" or `backtick-quoted` headings, or `none`)'
                )
                continue
            decl.rewritten.extend(headings)
    if decl.headline_lines == 0:
        decl.errors.append("missing `- Headline result:` declaration line")
    if decl.headline_lines > 1:
        decl.errors.append("multiple `- Headline result:` lines; declare exactly one headline (or none with a reason)")
    if decl.supersedes_lines == 0:
        decl.errors.append("missing `- Supersedes:` declaration line(s)")
    if decl.supersedes_none and decl.supersedes:
        decl.errors.append("`Supersedes: none` conflicts with declared supersession lines")
    if decl.rewritten_lines == 0:
        decl.errors.append("missing `- Rewritten sections:` declaration line")
    if decl.rewritten_none and decl.rewritten:
        decl.errors.append("`Rewritten sections: none` conflicts with declared section lines")
    return decl


def verify_against_view(decl: Declaration, view: dict) -> list[str]:
    failures: list[str] = []
    results = view.get("results") or {}
    current_rows = results.get("current") or []
    issues = results.get("issues") or []
    runs = view.get("runs") or {}
    superseded_rows = runs.get("superseded") or []
    conflicting = set(runs.get("conflicting_stamps") or [])
    no_identity = set(runs.get("no_authoritative_identity") or [])
    notebook = view.get("notebook") or {}
    sections_by_heading: dict[str, list[dict]] = {}
    for entry in notebook.get("sections") or []:
        sections_by_heading.setdefault(entry.get("heading"), []).append(entry)

    if decl.headline is not None:
        result_id, run_id = decl.headline
        row = next((r for r in current_rows if r.get("result_id") == result_id), None)
        if row is None:
            failures.append(
                f"declared headline result {result_id!r} has no current row in the results registry "
                f"(run `nullius result set-current {result_id} --run {run_id} --artifact <path>` at adjudication)"
            )
        else:
            if row.get("run_id") != run_id:
                failures.append(
                    f"declared headline result {result_id!r} is registered against run "
                    f"{row.get('run_id')!r}, not the declared {run_id!r}"
                )
            if row.get("defective"):
                failures.append(f"declared headline result {result_id!r} is a defective registry row")
        # Word-boundary match, not substring: result ids share prefixes
        # ("m0" must not trip on an issue about "m01-fit").
        id_mention = re.compile(rf"(?<![\w-]){re.escape(result_id)}(?![\w-])")
        mentioned = [issue.get("message", "") for issue in issues if id_mention.search(issue.get("message", ""))]
        for message in mentioned:
            failures.append(f"results-registry issue touches declared result {result_id!r}: {message}")
        if run_id in conflicting:
            failures.append(f"declared headline run {run_id!r} carries conflicting origin stamps")
        if run_id in no_identity:
            failures.append(f"declared headline run {run_id!r} has no authoritative identity (ledger defect)")

    recorded = {(row.get("run_id"), row.get("by")) for row in superseded_rows}
    for old, new in decl.supersedes:
        if (old, new) not in recorded:
            failures.append(
                f"declared supersession {old} -> {new} is not on the validity ledger "
                f"(run `nullius trace supersede {old} --by {new} --reason \"...\"`)"
            )

    for heading in decl.rewritten:
        entries = sections_by_heading.get(heading, [])
        if not entries:
            failures.append(f"declared rewritten section {heading!r} does not exist in the notebook")
            continue
        # Duplicate headings: the declaration cannot name one of them, so
        # EVERY section under that heading must carry a fresh stamp — a
        # stale namesake hiding behind a fresh one is exactly the holdover
        # prose the stamp exists to catch.
        for entry in entries:
            if entry.get("class") not in ("current", "current-modulo-untracked"):
                duplicate_note = (
                    f" (heading appears {len(entries)} times; every namesake section must be current)"
                    if len(entries) > 1
                    else ""
                )
                failures.append(
                    f"declared rewritten section {heading!r} is {entry.get('class')!r} "
                    f"({entry.get('cause')}){duplicate_note}; a rewrite carries a fresh "
                    "`<!-- written-against: <commit> -->` stamp"
                )

    # Current-state block: only a PRESENT block claims currency. Views from
    # launchers predating the block report no field and add no clause.
    # `duplicated_markers` is true ONLY when duplication coexists with at
    # least one complete START..END pair — an ambiguous CURRENCY CLAIM
    # (which of the structures is authoritative?), hence a refusal. Stray
    # unpaired marker lines claim nothing: the reader reports them as an
    # advisory reason with block_found=false, and this gate stays silent
    # (R3: a missing block never refuses). Fenced or indented-code examples
    # quoting the markers never reach either state.
    block = notebook.get("current_state_block") or {}
    if block.get("duplicated_markers"):
        failures.append(
            "the notebook current-state block has duplicated markers — repair by hand, "
            "then `nullius notebook sync`"
        )
    elif block.get("block_found") and block.get("in_sync") is False:
        failures.append(
            f"the notebook current-state block is OUT OF SYNC ({block.get('reason')}); "
            "a present block claims currency — run `nullius notebook sync` before folding"
        )

    # Dead citations: zero-threshold, but ONLY inside sections this fold
    # declares rewritten — historical prose elsewhere stays advisory.
    declared_headings = set(decl.rewritten)
    if declared_headings:
        run_links = notebook.get("run_links") or {}
        for entry in run_links.get("unacknowledged_dead") or []:
            if entry.get("section") in declared_headings:
                failures.append(
                    f"declared rewritten section {entry.get('section')!r} still cites "
                    f"{entry.get('run_id')} ({entry.get('validity')}) as live-looking prose; "
                    "acknowledge it in place (say superseded/void or link the replacement run), "
                    "or remove the link"
                )
    return failures


def load_view(project_root: Path) -> dict | None | str:
    """Returns the parsed view, None when no launcher exists (SKIP), or an
    error string."""
    launcher = project_root / ".nullius" / "bin" / "nullius"
    if not launcher.is_file():
        return None
    try:
        proc = subprocess.run(
            [str(launcher), "--project-root", str(project_root), "current", "--json"],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"failed to run `nullius current --json`: {error}"
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        return f"`nullius current --json` exited {proc.returncode}: {detail[-1] if detail else 'no output'}"
    try:
        view = json.loads(proc.stdout)
    except ValueError as error:
        return f"`nullius current --json` produced unparseable output: {error}"
    if not isinstance(view, dict):
        return "`nullius current --json` produced a non-object"
    return view


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--convergence-json",
        type=Path,
        required=True,
        help="machine result emitted by check_team_convergence.py",
    )
    ap.add_argument(
        "--adjudication",
        type=Path,
        required=True,
        help="adjudication markdown carrying the `## Result registration` declaration",
    )
    ap.add_argument(
        "--project-root",
        type=Path,
        required=True,
        help="external project root whose traceability record the declaration is verified against",
    )
    args = ap.parse_args()

    if not args.convergence_json.is_file():
        return _input_error(f"convergence result not found: {args.convergence_json}")
    try:
        convergence = json.loads(args.convergence_json.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return _input_error(f"unreadable convergence result: {error}")
    if not isinstance(convergence, dict):
        return _input_error("convergence result must be a JSON object")
    schema_errors = validate_convergence_result(convergence)
    if schema_errors:
        return _input_error("convergence result fails the shared contract: " + "; ".join(schema_errors))
    gate_id = (convergence.get("meta") or {}).get("gate_id")
    if gate_id != "team_convergence":
        return _input_error(
            f"convergence result carries gate_id {gate_id!r}; this gate consumes team_convergence results only"
        )
    status = convergence.get("status")
    if status != "converged":
        return _skip(f"cycle status {status!r}; this gate guards the fold of a converged cycle")

    if not args.project_root.is_dir():
        return _input_error(f"project root not found: {args.project_root}")
    view = load_view(args.project_root)
    if view is None:
        return _skip(
            "no nullius launcher at .nullius/bin/nullius; the registration contract is mandatory "
            "only where the project has one"
        )
    if isinstance(view, str):
        return _input_error(view)

    if not args.adjudication.is_file():
        return _fail([f"adjudication not found: {args.adjudication} (a converged cycle declares its registration there)"])
    adjudication_text = args.adjudication.read_text(encoding="utf-8")
    section = extract_registration_section(adjudication_text)
    if section is None:
        return _fail([
            f"adjudication has no `## {SECTION_HEADING}` section; a converged cycle must declare its "
            "headline result (or none — with a reason), supersessions, and rewritten sections",
        ])
    decl = parse_declaration(section)
    if decl.errors:
        return _fail(decl.errors)
    failures = verify_against_view(decl, view)
    if failures:
        return _fail(failures)
    print(json.dumps({
        "status": "pass",
        "headline": (
            {"result_id": decl.headline[0], "run_id": decl.headline[1]}
            if decl.headline
            else {"none_reason": decl.headline_none_reason}
        ),
        "supersessions_declared": len(decl.supersedes),
        "rewritten_sections_declared": len(decl.rewritten),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
