#!/usr/bin/env python3
"""Production launch authorization preflight (A3 machine gate).

Machine-decides whether a large production run may start. The launch is
authorized only when EVERY precondition is demonstrated at the launch site;
anything missing, unreadable, malformed, or unequal refuses the launch with
a falsification-labeled verdict and a non-zero exit code, so a launcher that
chains on this check produces zero production output on refusal.

The preconditions (all machine-checked, none waivable here):

1. Frozen plan. The authorization record registers the production plan's
   content hash (SHA-256). The live plan file must hash to exactly that
   value. An absent or malformed registered hash makes the whole record
   invalid (invalid_record); a missing or unreadable plan file ->
   missing_plan_hash; a live plan whose content differs from the registered
   hash -> the plan changed after authorization -> stale_review.
2. Review verdicts bound to the plan hash. Each independent review verdict
   file states the plan hash it reviewed. An approval counts ONLY when its
   bound hash equals the live plan hash; a plan edited after review turns
   that approval stale (stale_review). At least `required_approvals`
   counting approvals must exist.
3. Reviewer unavailability is never approval. A reviewer that timed out or
   errored must be recorded with verdict "unavailable" by whoever ran the
   review; that entry never counts toward the quorum, and when the quorum
   is unmet because of it, the refusal says reviewer_unavailable — absence
   of a verdict file refuses as missing_review. Silence is refusal, never
   consent.
4. Exact execution-environment fingerprint. The record registers the
   fingerprint (code/solver versions, key dependencies — string values
   only) of the environment the review covered; the launch site supplies
   the fingerprint it observes. The two must be exactly, symmetrically
   equal: any missing key on either side or any unequal value ->
   fingerprint_mismatch.

These preconditions target three observed AI failure modes: a missing
review silently treated as consent; a plan modified after review still
riding on the old verdict; and an execution environment that differs from
the one the review actually covered.

Inputs (all domain-neutral JSON; shapes documented in this skill's
SKILL.md under "Production Launch Authorization"):

  authorization record   frozen at authorization time, committed:
    {"record_version": 1,
     "plan_path": "<project-root-relative>",
     "plan_sha256": "<64 lowercase hex>",
     "required_approvals": <int >= 1>,
     "reviews": [{"reviewer": "<id>", "verdict_path": "<relative>"}, ...],
     "environment_fingerprint": {"<key>": "<string value>", ...}}
  review verdict file    written by whoever ran each review:
    {"verdict_version": 1, "reviewer": "<id>",
     "verdict": "approved" | "changes_needed" | "unavailable",
     "reviewed_plan_sha256": "<64 lowercase hex>"}   # null allowed only
                                                     # for unavailable
  observed fingerprint   produced by the launcher at launch time:
    {"<key>": "<string value>", ...}

Verdict, one of (default refuse — authorized is the only pass):
  authorized            every check passed.
  invalid_record        the authorization record is missing, unreadable,
                        or malformed — including an absent/malformed
                        registered plan hash, an impossible quorum
                        (required_approvals > len(reviews)), or a duplicate
                        reviewer id (one reviewer never counts twice).
  missing_plan_hash     the plan file named by the record is missing,
                        unreadable, or escapes the project root, so no
                        live plan hash can be computed.
  stale_review          the live plan content differs from the hash the
                        record and/or the review verdicts bound — the plan
                        was changed after authorization or review, so the
                        old verdicts are void.
  missing_review        a listed review verdict file is absent, unreadable,
                        malformed, unbound, or attributed to a different
                        reviewer, and the quorum is unmet.
  review_rejected       a reviewer returned changes_needed and the quorum
                        is unmet.
  reviewer_unavailable  a reviewer was explicitly recorded unavailable and
                        the quorum is unmet — unavailability is never
                        approval.
  fingerprint_mismatch  the observed fingerprint is not exactly equal to
                        the registered one (or is missing/unreadable —
                        equality that cannot be demonstrated is refused).

Check order and verdict selection are deterministic: checks are
plan_frozen, review_binding, fingerprint_match; each is evaluated
independently for the audit record (review_binding needs the live plan
hash and is not_evaluated without it; not_evaluated is never a pass), and
the verdict is the first failing check's label in that order. Within
review_binding, when the quorum is unmet the refusal label priority is
stale_review > review_rejected > reviewer_unavailable > missing_review
(the sharpest falsification wins; an active rejection outranks
unavailability, which outranks absence). A quorum met by genuine
hash-bound approvals passes even if some OTHER listed reviewer is
unavailable or bound to a superseded hash: a void verdict (unavailable,
stale-bound, missing, malformed) never counts as approval, and it is not
a veto on approvals of the live plan that were actually given — the
quorum the record declares is the requirement.

Enforcement locus: this checker is the machine gate for PROJECT-SIDE
production launchers (chain it before the production command, as the
skill documents). The engine's own A3 approval flow records the human
go-ahead for engine-managed runs; it does not invoke this checker. The
two are complementary, and the shared gate registry's A3 policy names
this result contract so launchers know what to produce.

Exit codes: 0 ONLY for authorized; 2 for invalid_record and usage errors;
3 for every other refusal. The full launch_authorization_v1 result JSON is
always printed on stdout; --output additionally writes it atomically. The
--output write is guarded on every exit path: a --output that names — at
any ancestor level — the directory-entry slot of any input path the
record declares or the run consumed (the record, the plan, a verdict
file, the observed fingerprint; hard links, symlinks, case and
Unicode-normalization collisions, and firmlink spellings included, for
existing and not-yet-existing files alike) is never written and the run
exits 2, and a --output write that fails likewise makes the checker exit
2 even for an authorized verdict — an authorization whose requested
audit artifact cannot be persisted is refused (the printed exit_code
field reflects the verdict alone). Any internal defect still emits a
labeled invalid_record artifact instead of a bare traceback.

Honest limitations. The plan file is read ONCE and that byte content is
hashed and compared everywhere, so the check itself has no read-then-reuse
window; but the check cannot prevent the plan or environment from changing
AFTER it exits — run it immediately before launch in the same command
chain (`... && exec <production command>`). Verdict files and the record
are trusted filesystem inputs: this gate proves consistency (hashes bound,
fingerprints equal), not authenticity — protecting the files themselves is
repository/commit discipline.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_ID = "launch_authorization_v1"
SCHEMA_VERSION = 1

VERDICTS = (
    "authorized",
    "invalid_record",
    "missing_plan_hash",
    "stale_review",
    "missing_review",
    "review_rejected",
    "reviewer_unavailable",
    "fingerprint_mismatch",
)
EXIT_CODES = {v: (0 if v == "authorized" else 2 if v == "invalid_record" else 3) for v in VERDICTS}
CHECK_IDS = ("plan_frozen", "review_binding", "fingerprint_match")
REVIEW_FILE_VERDICTS = ("approved", "changes_needed", "unavailable")

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_sha256(value) -> bool:
    return isinstance(value, str) and bool(_SHA256_RE.match(value))


def _is_safe_rel_path(s) -> bool:
    """A non-empty relative path, strictly below its base directory: no
    absolute paths, no '..' or '.' components, no NUL bytes."""
    if not isinstance(s, str) or not s.strip() or "\x00" in s:
        return False
    parts = Path(s).parts
    return bool(parts) and not Path(s).is_absolute() and ".." not in parts and "." not in parts


def _is_version_one(value) -> bool:
    """Exactly the integer 1 — not True (bool == 1 in Python) and not 1.0."""
    return isinstance(value, int) and not isinstance(value, bool) and value == 1


def _try_resolve(path: Path) -> "Path | None":
    """Path.resolve() that returns None instead of raising (symlink loops
    raise OSError or RuntimeError depending on the Python version; embedded
    NUL bytes raise ValueError); every caller fails closed on None."""
    try:
        return path.resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def _resolved_under(base: Path, rel: str) -> "Path | None":
    """base/rel with symlinks resolved, or None when it escapes base or is
    not resolvable (fail-closed)."""
    candidate = _try_resolve(base / rel)
    resolved_base = _try_resolve(base)
    if candidate is None or resolved_base is None:
        return None
    try:
        candidate.relative_to(resolved_base)
    except ValueError:
        return None
    return candidate


def write_text_atomic(path: Path, text: str) -> None:
    """Temp file in the same directory + rename: a reader never sees a
    partial result, a crash never leaves a truncated one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path: Path) -> "tuple[object | None, str | None]":
    """(document, error). UTF-8 strictly; every failure is a reason string,
    never an exception (RecursionError covers pathologically nested JSON)."""
    try:
        raw = path.read_bytes()
    except (OSError, ValueError) as exc:
        return None, f"unreadable: {exc}"
    try:
        return json.loads(raw.decode("utf-8")), None
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        return None, f"not valid UTF-8 JSON: {exc!r}"


# --- record validation ---

def validate_record(doc) -> list[str]:
    """Structural validation of the authorization record. Fail-closed: every
    ambiguity is an error, never a silently applied default."""
    if not isinstance(doc, dict):
        return ["authorization record root must be a JSON object"]
    errors: list[str] = []
    if not _is_version_one(doc.get("record_version")):
        errors.append("record_version must be present and exactly the integer 1")
    if not _is_safe_rel_path(doc.get("plan_path")):
        errors.append("plan_path must be a non-empty project-root-relative path "
                      "(no absolute paths, no '..' or '.' components, no NUL bytes)")
    if not _is_sha256(doc.get("plan_sha256")):
        errors.append("plan_sha256 must be 64 lowercase hex characters (SHA-256 of the "
                      "frozen plan content)")
    required = doc.get("required_approvals")
    if isinstance(required, bool) or not isinstance(required, int) or required < 1:
        errors.append("required_approvals must be an integer >= 1")
    reviews = doc.get("reviews")
    if not isinstance(reviews, list) or not reviews:
        errors.append("reviews must be a non-empty list of {reviewer, verdict_path}")
    else:
        seen: set[str] = set()
        for i, entry in enumerate(reviews):
            where = f"reviews[{i}]"
            if not isinstance(entry, dict):
                errors.append(f"{where} must be an object")
                continue
            reviewer = entry.get("reviewer")
            if not isinstance(reviewer, str) or not reviewer.strip():
                errors.append(f"{where}.reviewer must be a non-empty string")
            elif reviewer in seen:
                errors.append(f"{where}.reviewer duplicates '{reviewer}' — one reviewer "
                              "never counts twice")
            else:
                seen.add(reviewer)
            if not _is_safe_rel_path(entry.get("verdict_path")):
                errors.append(f"{where}.verdict_path must be a non-empty "
                              "project-root-relative path")
        if (isinstance(required, int) and not isinstance(required, bool)
                and required >= 1 and required > len(reviews)):
            errors.append(f"required_approvals ({required}) exceeds the number of listed "
                          f"reviews ({len(reviews)}) — the quorum is impossible by "
                          "construction")
    fingerprint = doc.get("environment_fingerprint")
    if not isinstance(fingerprint, dict) or not fingerprint:
        errors.append("environment_fingerprint must be a non-empty object — an empty "
                      "fingerprint would make the environment check vacuous")
    elif not all(isinstance(k, str) and k.strip() and isinstance(v, str)
                 for k, v in fingerprint.items()):
        errors.append("environment_fingerprint keys must be non-empty strings and values "
                      "must be strings (string-typed so equal values cannot diverge by "
                      "numeric representation)")
    return errors


# --- checks ---

def check_plan_frozen(project_root: Path, plan_path: str,
                      registered_sha256: str) -> "tuple[str | None, str, str]":
    """Returns (live_sha256, refusal_label_or_empty, detail). The plan file
    is read once; the returned hash is the single source for every later
    comparison."""
    resolved = _resolved_under(project_root, plan_path)
    if resolved is None:
        return None, "missing_plan_hash", (f"plan path '{plan_path}' escapes the project "
                                           "root or is not resolvable")
    try:
        live = _sha256_hex(resolved.read_bytes())
    except OSError as exc:
        return None, "missing_plan_hash", f"plan file unreadable: {exc}"
    if live != registered_sha256:
        return live, "stale_review", ("live plan content differs from the registered hash — "
                                      "the plan changed after authorization, so the frozen "
                                      "plan and every verdict bound to it are void "
                                      f"(registered {registered_sha256[:12]}…, "
                                      f"live {live[:12]}…)")
    return live, "", "live plan hash equals the registered hash"


def evaluate_review(project_root: Path, entry: dict, live_plan_sha256: str) -> dict:
    """One review's observed state at preflight time. counts_as_approval is
    true ONLY for verdict approved with the bound hash exactly equal to the
    live plan hash."""
    reviewer = entry["reviewer"]
    verdict_path = entry["verdict_path"]
    result = {"reviewer": reviewer, "verdict_path": verdict_path, "verdict": "missing",
              "reviewed_plan_sha256": None, "counts_as_approval": False, "detail": ""}
    resolved = _resolved_under(project_root, verdict_path)
    if resolved is None:
        result["detail"] = "verdict path escapes the project root or is not resolvable"
        return result
    if not resolved.is_file():
        result["detail"] = ("verdict file absent — no verdict was recorded; absence is "
                            "refusal, never consent")
        return result
    doc, err = _read_json(resolved)
    if err is not None:
        result["verdict"] = "missing" if err.startswith("unreadable") else "invalid"
        result["detail"] = f"verdict file {err}"
        return result
    if not isinstance(doc, dict) or not _is_version_one(doc.get("verdict_version")):
        result["verdict"] = "invalid"
        result["detail"] = ("verdict file must be an object with verdict_version exactly "
                            "the integer 1")
        return result
    if doc.get("reviewer") != reviewer:
        result["verdict"] = "invalid"
        result["detail"] = (f"verdict file names reviewer {doc.get('reviewer')!r}, but the "
                            f"record lists this entry for {reviewer!r}")
        return result
    file_verdict = doc.get("verdict")
    if file_verdict not in REVIEW_FILE_VERDICTS:
        result["verdict"] = "invalid"
        result["detail"] = (f"verdict must be one of {list(REVIEW_FILE_VERDICTS)}, "
                            f"got {file_verdict!r}")
        return result
    bound = doc.get("reviewed_plan_sha256")
    if file_verdict == "unavailable":
        result["verdict"] = "unavailable"
        result["reviewed_plan_sha256"] = bound if _is_sha256(bound) else None
        result["detail"] = ("reviewer explicitly recorded unavailable — never counted as "
                            "approval")
        return result
    if not _is_sha256(bound):
        result["verdict"] = "invalid"
        result["detail"] = (f"a {file_verdict} verdict must bind reviewed_plan_sha256 "
                            "(64 lowercase hex) — an unbound verdict never counts")
        return result
    result["verdict"] = file_verdict
    result["reviewed_plan_sha256"] = bound
    if bound != live_plan_sha256:
        result["detail"] = (f"verdict is bound to plan hash {bound[:12]}…, but the live "
                            f"plan hashes to {live_plan_sha256[:12]}… — the plan changed "
                            "after this review, so the verdict is stale")
        return result
    if file_verdict == "approved":
        result["counts_as_approval"] = True
        result["detail"] = "approval bound to the live plan hash"
    else:
        result["detail"] = "reviewer requested changes for exactly this plan version"
    return result


def decide_review_binding(reviews: list, required_approvals: int,
                          live_plan_sha256: str) -> "tuple[str, str]":
    """(refusal_label_or_empty, detail) for the review_binding check, given
    per-review observations. Pure and unit-testable. Any verdict bound to a
    superseded hash is stale, whether it approved or rejected that older
    plan version — a stale changes_needed is not an active rejection of the
    live plan; review_rejected is reserved for a changes_needed bound to
    exactly the live plan hash."""
    approvals = sum(1 for r in reviews if r["counts_as_approval"])
    if approvals >= required_approvals:
        return "", (f"{approvals} approval(s) bound to the live plan hash meet the "
                    f"required quorum of {required_approvals}")
    stale = [r for r in reviews
             if r["verdict"] in ("approved", "changes_needed")
             and r["reviewed_plan_sha256"] is not None
             and r["reviewed_plan_sha256"] != live_plan_sha256]
    rejected = [r for r in reviews if r["verdict"] == "changes_needed"
                and r["reviewed_plan_sha256"] == live_plan_sha256]
    unavailable = [r for r in reviews if r["verdict"] == "unavailable"]
    if stale:
        label, culprits = "stale_review", stale
        why = "verdict(s) bound to a superseded plan hash"
    elif rejected:
        label, culprits = "review_rejected", rejected
        why = "reviewer(s) returned changes_needed"
    elif unavailable:
        label, culprits = "reviewer_unavailable", unavailable
        why = "reviewer(s) recorded unavailable — unavailability is never approval"
    else:
        label = "missing_review"
        culprits = [r for r in reviews if r["verdict"] in ("missing", "invalid")]
        why = "verdict file(s) absent, unreadable, malformed, or unbound"
    names = ", ".join(r["reviewer"] for r in culprits) or "none listed"
    return label, (f"quorum unmet: {approvals} counting approval(s) of "
                   f"{required_approvals} required; {why} ({names})")


def compare_fingerprints(expected: dict, observed) -> "tuple[bool, list[str], str]":
    """(equal, mismatched_keys, detail). Exact symmetric equality: identical
    key sets, identical string values. A non-string observed value is a
    mismatch on that key (fail-closed), never a coercion."""
    if not isinstance(observed, dict):
        return False, sorted(expected), "observed fingerprint is not a JSON object"
    mismatched = sorted(
        {k for k in expected if k not in observed or observed[k] != expected[k]
         or not isinstance(observed[k], str)}
        | {k for k in observed if k not in expected}
    )
    if mismatched:
        return False, mismatched, ("fingerprint not exactly equal on: " + ", ".join(mismatched))
    return True, [], f"all {len(expected)} fingerprint entries exactly equal"


# --- reporting ---

def build_result(record_path: str, record_sha256: "str | None") -> dict:
    return {
        "schema_id": SCHEMA_ID,
        "schema_version": SCHEMA_VERSION,
        "verdict": "invalid_record",
        "launch_authorized": False,
        "exit_code": EXIT_CODES["invalid_record"],
        "generated_at": _utc_now(),
        "record_path": record_path,
        "record_sha256": record_sha256,
        "required_approvals": 0,
        "approvals_counted": 0,
        "plan": {"path": None, "registered_sha256": None, "live_sha256": None},
        "reviews": [],
        "fingerprint": {"expected": None, "observed": None, "equal": False,
                        "mismatched_keys": []},
        "checks": [{"check_id": c, "status": "not_evaluated", "detail": ""}
                   for c in CHECK_IDS],
        "errors": [],
    }


def _set_check(result: dict, check_id: str, status: str, detail: str) -> None:
    for check in result["checks"]:
        if check["check_id"] == check_id:
            check["status"] = status
            check["detail"] = detail
            return


def _normalized_name(name: str) -> str:
    """Directory-entry name normalized the way an APFS-style volume treats
    it: Unicode-normalization-insensitive (NFC) and case-insensitive
    (casefold)."""
    return unicodedata.normalize("NFC", name).casefold()


def _existing_ancestor(path: Path) -> "tuple[Path, tuple[str, ...]]":
    """(nearest existing ancestor, remaining path components below it).
    For an existing path the tail is empty. exists() follows the same
    fail-closed spirit as the rest of this module: an unstattable ancestor
    counts as non-existing and stays in the tail."""
    tail: list[str] = []
    cur = path
    while cur != cur.parent:
        try:
            if cur.exists():
                break
        except OSError:
            pass
        tail.append(cur.name)
        cur = cur.parent
    return cur, tuple(reversed(tail))


def _same_slot(a: Path, b: Path) -> bool:
    """True when the two (resolved) paths name the same directory-entry slot
    on a case- or normalization-insensitive volume, existing or not:
    identical string, or the same nearest EXISTING ancestor (by inode, which
    also identifies macOS firmlink spellings of the same directory) with the
    remaining components pairwise equal under case folding and Unicode
    normalization. On a fully sensitive volume this over-refuses a
    distinct-but-colliding name — the safe direction."""
    if str(a) == str(b):
        return True
    base_a, tail_a = _existing_ancestor(a)
    base_b, tail_b = _existing_ancestor(b)
    if len(tail_a) != len(tail_b):
        return False
    if tuple(map(_normalized_name, tail_a)) != tuple(map(_normalized_name, tail_b)):
        return False
    if str(base_a) == str(base_b):
        return True
    try:
        return os.path.samefile(str(base_a), str(base_b))
    except (OSError, ValueError):
        return False


def _output_aliases_input(output: Path, protected: "frozenset[Path] | set[Path]") -> bool:
    """True when --output must never be written: it — or ANY of its
    ancestors, since the atomic writer creates missing parent directories —
    names, or cannot be distinguished from, the directory-entry slot of a
    protected input path (an output nested below a missing declared input
    would otherwise occupy that slot with a directory). After symlink
    resolution, slot identity (_same_slot) covers exact equality, hard
    links and existing-file aliases (inode identity), case and
    Unicode-normalization variants of files that do not exist yet, and
    firmlink spellings of the enclosing directory. An unresolvable
    --output is refused outright (fail-closed)."""
    resolved = _try_resolve(output)
    if resolved is None:
        return True
    for candidate in (resolved, *resolved.parents):
        if candidate in protected:
            return True
        if any(_same_slot(candidate, known) for known in protected):
            return True
    return False


def _protect_declared_paths(record, bases: "list[Path]",
                            protected: "set[Path]") -> None:
    """Best-effort: add every path the record DECLARES — however malformed
    the declaration ('..' traversals and absolute paths included) — to the
    protected set, resolved against every candidate base directory.
    Protection is deliberately more permissive than consumption:
    over-protecting only makes the --output guard stricter, while the
    checks themselves still go through the strict safe-path validation."""
    if not isinstance(record, dict):
        return
    declared = [record.get("plan_path")]
    if isinstance(record.get("reviews"), list):
        declared.extend(entry.get("verdict_path")
                        for entry in record["reviews"] if isinstance(entry, dict))
    for rel in declared:
        # any non-empty string is protected — whitespace-only names included:
        # validation rejects them for CONSUMPTION, but they are still valid
        # filesystem names the --output write must not occupy
        if isinstance(rel, str) and rel:
            for base in bases:
                resolved = _try_resolve(base / rel)
                if resolved is not None:
                    protected.add(resolved)


def finish(result: dict, verdict: str, output: "Path | None",
           protected: "frozenset[Path] | set[Path]" = frozenset()) -> int:
    """Emit the result. Stdout always carries the full artifact. The --output
    write is guarded here — on EVERY exit path, early refusals included — so
    the audit artifact can never overwrite the record, the plan, a verdict
    file, or the observed fingerprint (os.replace would silently clobber the
    very bytes that were just checked); an aliased --output is not written
    and the run exits 2. A --output write that fails likewise downgrades the
    run to exit 2 even when the verdict is authorized — an authorization
    whose requested audit artifact cannot be persisted is refused (the
    printed exit_code field reflects the verdict alone)."""
    result["verdict"] = verdict
    result["launch_authorized"] = verdict == "authorized"
    result["exit_code"] = EXIT_CODES[verdict]
    alias_refusal = None
    if output is not None and _output_aliases_input(output, protected):
        alias_refusal = ("--output must not alias the record, the plan, a verdict "
                         "file, or the observed fingerprint — refusing to overwrite "
                         "an input")
        result["errors"].append(alias_refusal)
        output = None
    text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        # a parser-accepted lone surrogate in an input string would make the
        # emit itself crash; escape everything instead of losing the artifact
        text = json.dumps(result, indent=2, ensure_ascii=True) + "\n"
    print(text, end="")
    if alias_refusal is not None:
        print(f"launch refused: {alias_refusal}", file=sys.stderr)
        return EXIT_CODES["invalid_record"]
    if output is not None:
        try:
            write_text_atomic(output, text)
        except (OSError, ValueError) as exc:
            print(f"launch refused: could not write --output audit artifact: {exc}",
                  file=sys.stderr)
            return EXIT_CODES["invalid_record"]
    return result["exit_code"]


# --- main ---

def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        description="Launch-authorization preflight for production compute runs: frozen "
                    "plan hash + hash-bound review verdicts + exact environment "
                    "fingerprint, all machine-checked, default refuse. Exit 0 only when "
                    "authorized; chain the production command on success "
                    "(`... && exec <production command>`).")
    parser.add_argument("--record", type=Path, required=True,
                        help="authorization record (JSON) frozen at authorization time; "
                             "see SKILL.md for the shape.")
    parser.add_argument("--observed-fingerprint", type=Path, required=True,
                        help="JSON object of string values the launcher observes at "
                             "launch time; compared for exact equality with the "
                             "record's environment_fingerprint.")
    parser.add_argument("--project-root", type=Path, default=None,
                        help="root the record's relative paths resolve against "
                             "(default: git toplevel of the record's directory; "
                             "required for non-git projects).")
    parser.add_argument("--output", type=Path, default=None,
                        help="also write the launch_authorization_v1 result JSON here "
                             "(atomic write).")
    args = parser.parse_args(argv)

    result = build_result(str(args.record), None)
    # every path the run reads is protected from the --output write on every
    # exit path; the set grows as more input paths become known
    protected: "set[Path]" = set()
    for input_path in (args.record, args.observed_fingerprint):
        resolved = _try_resolve(input_path)
        if resolved is not None:
            protected.add(resolved)
    try:
        return _run_checks(args, result, protected)
    except Exception as exc:  # the artifact contract must survive any internal defect
        result["errors"].append(f"internal error: {exc!r}")
        return finish(result, "invalid_record", args.output, protected)


def _run_checks(args, result: dict, protected: "set[Path]") -> int:
    # -- record bytes + parse (before anything else, so the paths the record
    #    declares can be protected on every later exit) --
    try:
        raw = args.record.read_bytes()
    except (OSError, ValueError) as exc:
        result["errors"].append(f"cannot read authorization record: {exc}")
        return finish(result, "invalid_record", args.output, protected)
    result["record_sha256"] = _sha256_hex(raw)
    try:
        record = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        result["errors"].append(f"authorization record is not valid UTF-8 JSON: {exc!r}")
        return finish(result, "invalid_record", args.output, protected)
    # protect the declared paths against the record's own directory already
    # here: the project-root-failure exit below must not be able to clobber
    # the plan or a verdict file either
    resolved_record = _try_resolve(args.record)
    if resolved_record is not None:
        _protect_declared_paths(record, [resolved_record.parent], protected)

    # -- project root: explicit, or the git toplevel enclosing the record --
    if args.project_root is not None:
        project_root = _try_resolve(args.project_root)
        if project_root is None or not project_root.is_dir():
            result["errors"].append("--project-root is not a resolvable directory")
            return finish(result, "invalid_record", args.output, protected)
    else:
        if resolved_record is None:
            result["errors"].append("record path is not resolvable")
            return finish(result, "invalid_record", args.output, protected)
        try:
            top = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                                 cwd=str(resolved_record.parent), capture_output=True,
                                 text=True, check=False)
        except OSError:
            top = None
        if top is None or top.returncode != 0:
            result["errors"].append("record is not inside a git repository; pass "
                                    "--project-root explicitly")
            return finish(result, "invalid_record", args.output, protected)
        project_root = Path(top.stdout.strip())

    # -- re-protect the declared paths against the actual project root, then
    #    validate; a validation-refused record cannot have its declared plan
    #    or verdict files clobbered by the --output write of the refusal
    #    artifact, however malformed the declarations are --
    _protect_declared_paths(record, [project_root], protected)
    errors = validate_record(record)
    if errors:
        result["errors"].extend(errors)
        return finish(result, "invalid_record", args.output, protected)

    result["required_approvals"] = record["required_approvals"]
    result["plan"]["path"] = record["plan_path"]
    result["plan"]["registered_sha256"] = record["plan_sha256"]
    result["fingerprint"]["expected"] = record["environment_fingerprint"]

    # -- check 1: frozen plan (single read; this hash feeds every comparison) --
    live_sha256, plan_label, plan_detail = check_plan_frozen(
        project_root, record["plan_path"], record["plan_sha256"])
    result["plan"]["live_sha256"] = live_sha256
    _set_check(result, "plan_frozen", "fail" if plan_label else "pass", plan_detail)

    # -- check 2: review verdicts bound to the live plan hash (needs the live
    #    hash; never evaluated — and never a pass — without it) --
    review_label = ""
    if live_sha256 is None:
        _set_check(result, "review_binding", "not_evaluated",
                   "live plan hash unavailable, so no verdict can be bound-checked")
    else:
        result["reviews"] = [evaluate_review(project_root, entry, live_sha256)
                             for entry in record["reviews"]]
        result["approvals_counted"] = sum(
            1 for r in result["reviews"] if r["counts_as_approval"])
        review_label, review_detail = decide_review_binding(
            result["reviews"], record["required_approvals"], live_sha256)
        _set_check(result, "review_binding", "fail" if review_label else "pass",
                   review_detail)

    # -- check 3: exact environment fingerprint (independent of the others;
    #    evaluated even after an earlier refusal, for the audit record) --
    observed, obs_err = _read_json(args.observed_fingerprint)
    if obs_err is not None:
        equal, mismatched = False, sorted(record["environment_fingerprint"])
        fp_detail = (f"observed fingerprint {obs_err} — equality that cannot be "
                     "demonstrated is refused")
    else:
        equal, mismatched, fp_detail = compare_fingerprints(
            record["environment_fingerprint"], observed)
        # the result artifact must itself satisfy its schema: observed is
        # echoed only when it is a string-valued object, else left null
        # (the mismatch detail still names the offending keys)
        if isinstance(observed, dict) and all(isinstance(v, str) for v in observed.values()):
            result["fingerprint"]["observed"] = observed
    result["fingerprint"]["equal"] = equal
    result["fingerprint"]["mismatched_keys"] = mismatched
    _set_check(result, "fingerprint_match", "pass" if equal else "fail", fp_detail)

    # -- verdict: first failing check in fixed order; authorized only when
    #    all three pass --
    if plan_label:
        return finish(result, plan_label, args.output, protected)
    if review_label:
        return finish(result, review_label, args.output, protected)
    if not equal:
        return finish(result, "fingerprint_mismatch", args.output, protected)
    return finish(result, "authorized", args.output, protected)


if __name__ == "__main__":
    raise SystemExit(main())
