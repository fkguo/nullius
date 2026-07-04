#!/usr/bin/env python3
"""
Shared review-output contract helpers for swarm runners and standalone checker.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional


# --- Markdown contract constants ---
REQUIRED_FIRST_LINES = {"VERDICT: READY", "VERDICT: NOT_READY"}
REQUIRED_HEADERS = [
    "## Blockers",
    "## Non-blocking",
    "## Real-research fit",
    "## Robustness & safety",
    "## Specific patch suggestions",
]

# Optional headers recognized by the contract but not required.
# Reviews that include these get proper parsing.
OPTIONAL_HEADERS = [
    "## Methodology",
]

# --- JSON contract constants ---
JSON_REQUIRED_FIELDS = {"blocking_issues", "verdict", "summary"}
JSON_VALID_VERDICTS = {"PASS", "FAIL"}

_RE_GEMINI_HOOK_PREAMBLE = re.compile(r"^Hook registry initialized with \d+ hook entries\s*$")
_RE_GEMINI_INLINE_PREFIXES = [
    re.compile(r"^\s*Hook registry initialized with \d+ hook entries\s*"),
    re.compile(r"^\s*MCP issues detected\. Run /mcp list for status\.\s*"),
]
_RE_GEMINI_STARTUP_LINES = [
    _RE_GEMINI_HOOK_PREAMBLE,
    re.compile(r"^MCP issues detected\. Run /mcp list for status\.\s*$"),
    re.compile(r"^Registering notification handlers for server '.*'\. Capabilities: .*$"),
    re.compile(r"^(completions|resources|tools): .*$"),
    re.compile(r"^\}$"),
    re.compile(
        r"^Server '.*' has tools but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.\s*$"
    ),
    re.compile(
        r"^Server '.*' has resources but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.\s*$"
    ),
    re.compile(
        r"^Server '.*' has prompts but did not declare 'listChanged' capability\. Listening anyway for robustness\.\.\.\s*$"
    ),
    re.compile(r"^Server '.*' supports tool updates\. Listening for changes\.\.\.\s*$"),
    re.compile(r"^Server '.*' supports resource updates\. Listening for changes\.\.\.\s*$"),
    re.compile(r"^Scheduling MCP context refresh\.\.\.\s*$"),
    re.compile(r"^Executing MCP context refresh\.\.\.\s*$"),
    re.compile(r"^MCP context refresh complete\.\s*$"),
]
_RE_VERDICT_LINE = re.compile(r"^VERDICT: (READY|NOT_READY)\s*$")


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _detect_format(text: str) -> str:
    """Detect if output is markdown contract or JSON contract."""
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("```"):
        return "json"
    return "markdown"


def strip_markdown_fences(text: str) -> str:
    """Strip leading ```json/``` and trailing ``` if present."""
    stripped = text.strip()
    if stripped.startswith("```"):
        first_nl = stripped.index("\n") if "\n" in stripped else len(stripped)
        stripped = stripped[first_nl + 1:]
    if stripped.rstrip().endswith("```"):
        stripped = stripped.rstrip()[:-3]
    return stripped.strip()


def check_json_review_contract_text(text: str) -> list[str]:
    """Validate JSON review output contract."""
    errs: list[str] = []
    try:
        obj = json.loads(strip_markdown_fences(text))
    except (json.JSONDecodeError, ValueError) as e:
        return [f"invalid JSON: {e}"]
    if not isinstance(obj, dict):
        return ["JSON root must be an object"]
    for field in sorted(JSON_REQUIRED_FIELDS):
        if field not in obj:
            errs.append(f"missing field: {field}")
    verdict = obj.get("verdict")
    if isinstance(verdict, str) and verdict not in JSON_VALID_VERDICTS:
        errs.append(f"bad verdict: {verdict!r} (expected PASS or FAIL)")
    if "blocking_issues" in obj and not isinstance(obj["blocking_issues"], list):
        errs.append("blocking_issues must be an array")
    return errs


def sanitize_contract_text(text: str) -> str:
    raw = normalize_newlines(text)
    lines = raw.splitlines()

    # Strip leading blank lines
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    cleaned = "\n".join(lines[i:]).rstrip() + "\n"

    # Auto-detect format
    fmt = _detect_format(cleaned)
    if fmt == "json":
        inner = strip_markdown_fences(cleaned)
        return inner.rstrip() + "\n"

    # Markdown: find VERDICT line and truncate preamble
    cleaned_lines = cleaned.splitlines()
    for j, ln in enumerate(cleaned_lines):
        if _RE_VERDICT_LINE.match(ln.strip()):
            if j > 0:
                cleaned = "\n".join(cleaned_lines[j:]).rstrip() + "\n"
            break

    return cleaned


def sanitize_contract_output(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False
    cleaned = sanitize_contract_text(raw)
    if cleaned != raw:
        path.write_text(cleaned, encoding="utf-8")
        return True
    return False


def sanitize_gemini_output(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    try:
        raw = normalize_newlines(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return False

    cleaned = raw.lstrip()
    while cleaned:
        changed = False
        for pattern in _RE_GEMINI_INLINE_PREFIXES:
            match = pattern.match(cleaned)
            if match:
                cleaned = cleaned[match.end() :].lstrip()
                changed = True
                break
        if changed:
            continue

        lines = cleaned.splitlines()
        if not lines:
            break
        line = lines[0].strip()
        if not line:
            cleaned = "\n".join(lines[1:]).lstrip()
            continue
        if any(pattern.match(line) for pattern in _RE_GEMINI_STARTUP_LINES):
            cleaned = "\n".join(lines[1:]).lstrip()
            continue
        break

    if cleaned and not cleaned.startswith("{") and not cleaned.startswith("```"):
        lines = cleaned.splitlines()
        for i, line in enumerate(lines):
            if _RE_VERDICT_LINE.match(line.strip()):
                cleaned = "\n".join(lines[i:]).lstrip()
                break
        else:
            json_start = cleaned.find("{")
            if json_start > 0:
                candidate = cleaned[json_start:]
                try:
                    json.loads(strip_markdown_fences(candidate))
                except (json.JSONDecodeError, ValueError):
                    pass
                else:
                    cleaned = candidate

    cleaned = cleaned.rstrip() + "\n"
    cleaned = sanitize_contract_text(cleaned)
    if cleaned != raw:
        path.write_text(cleaned, encoding="utf-8")
        return True
    return False


def check_review_contract_text(text: str) -> list[str]:
    normalized = normalize_newlines(text)
    fmt = _detect_format(normalized)
    if fmt == "json":
        return check_json_review_contract_text(normalized)

    # Markdown contract
    lines = normalized.splitlines()
    if not lines:
        return ["empty file"]

    first = lines[0].strip()
    errs: list[str] = []
    if first not in REQUIRED_FIRST_LINES:
        errs.append(f"bad first line: {first!r}")
    for h in REQUIRED_HEADERS:
        if h not in normalized:
            errs.append(f"missing header: {h}")
    return errs


def check_review_contract_file(path: Path) -> list[str]:
    if not path.exists() or not path.is_file():
        return [f"missing file: {path}"]
    text = path.read_text(encoding="utf-8", errors="replace")
    return check_review_contract_text(text)


def review_contract_ok(path: Path) -> tuple[bool, list[str]]:
    errs = check_review_contract_file(path)
    return (len(errs) == 0), errs


def first_verdict(path: Path) -> Optional[str]:
    if not path.exists() or not path.is_file():
        return None
    try:
        text = normalize_newlines(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None

    # Try JSON format first
    fmt = _detect_format(text)
    if fmt == "json":
        try:
            obj = json.loads(strip_markdown_fences(text))
            if isinstance(obj, dict) and isinstance(obj.get("verdict"), str):
                v = obj["verdict"]
                return f"VERDICT: {'READY' if v == 'PASS' else 'NOT_READY'}"
        except (json.JSONDecodeError, ValueError):
            pass

    # Markdown fallback
    for ln in text.splitlines():
        s = ln.strip()
        if s in REQUIRED_FIRST_LINES:
            return s
    return None


# --- Two-phase review protocol: declared-review-criteria contract ---
#
# Phase 1 of the opt-in two-phase protocol asks each reviewer (given the change
# scope only, no diff) to commit to declared review criteria: a single block of
# JSON wrapped in fixed sentinel lines. Phase 2 findings are then machine-checked
# against that commitment: every BLOCKING finding must carry a declared category,
# and any category added after seeing the diff must ship an explicit criteria
# revision declaration (fixed tag + one-line reason). The checker validates
# presence and format only; judging revision quality is the synthesis agent's job.

CRITERIA_BLOCK_OPEN = "<review_criteria>"
CRITERIA_BLOCK_CLOSE = "</review_criteria>"
CRITERIA_REVISION_PREFIX = "CRITERIA_REVISION:"
JSON_CRITERIA_REVISIONS_FIELD = "criteria_revisions"

_RE_CRITERIA_REVISION_PREFIX = re.compile(r"^\s*(?:[-*]\s+)?CRITERIA_REVISION:")
_RE_CRITERIA_REVISION_LINE = re.compile(
    r"^\s*(?:[-*]\s+)?CRITERIA_REVISION:\s*(?P<category>[^:]+?)\s*:\s*(?P<reason>\S.*)$"
)
_RE_BLOCKING_CATEGORY_TAG = re.compile(r"^\s*\[(?P<category>[^\[\]]+)\]")
# Top-level Markdown list bullets (column 0) are findings; indented bullets are
# continuation detail UNLESS they carry a category tag themselves (a tagged
# bullet at any indent is a finding — otherwise nesting would be an evasion
# channel for out-of-scope BLOCKING findings).
_RE_MD_TOP_BULLET = re.compile(r"^(?:[-*]|\d+[.)])\s+(?P<body>.*\S)\s*$")
_RE_MD_INDENTED_BULLET = re.compile(r"^\s+(?:[-*]|\d+[.)])\s+(?P<body>.*\S)\s*$")
_MD_BLOCKERS_HEADER = "## Blockers"
# Accept decorated variants like "## Blockers (critical)" — the single-phase
# contract check is substring-based, so conformance must not be stricter here.
_RE_MD_BLOCKERS_HEADER = re.compile(r"^## Blockers\b")
# Placeholder text that states the absence of blockers, not a finding.
# Exact-match set (case-insensitive, trailing period stripped): a real finding
# can never collide with these, so they are not an evasion channel.
_MD_PLACEHOLDER_BLOCKERS = {
    "none",
    "n/a",
    "na",
    "no blockers",
    "no blockers found",
    "no blocking issues",
    "no blocking findings",
    "none found",
    "none identified",
}


def _is_placeholder_blocker_text(body: str) -> bool:
    return body.rstrip(".").strip().casefold() in _MD_PLACEHOLDER_BLOCKERS


def normalize_criteria_category(raw: str) -> str:
    """Normalize a category name for comparison: casefold, unify -/_ to spaces,
    collapse whitespace."""
    s = str(raw).strip().casefold().replace("_", " ").replace("-", " ")
    return re.sub(r"\s+", " ", s)


def _validate_criteria_schema(obj: Any) -> list[str]:
    errs: list[str] = []
    if not isinstance(obj, dict):
        return [f"{CRITERIA_BLOCK_OPEN} JSON root must be an object"]
    categories = obj.get("categories")
    if not isinstance(categories, list) or not categories:
        errs.append("'categories' must be a non-empty array")
    else:
        for i, entry in enumerate(categories):
            if not isinstance(entry, dict):
                errs.append(f"categories[{i}] must be an object")
                continue
            name = entry.get("name")
            blocking = entry.get("blocking_criteria")
            if not isinstance(name, str) or not name.strip():
                errs.append(f"categories[{i}].name must be a non-empty string")
            if not isinstance(blocking, str) or not blocking.strip():
                errs.append(f"categories[{i}].blocking_criteria must be a non-empty string")
    scale = obj.get("severity_scale")
    if not isinstance(scale, str) or not scale.strip():
        errs.append("'severity_scale' must be a non-empty string")
    return errs


def extract_review_criteria_block(text: str) -> tuple[Optional[str], Optional[dict[str, Any]], list[str]]:
    """Extract and validate the phase-1 declared-review-criteria block.

    Returns (verbatim block including sentinel lines, parsed criteria object,
    errors). The parsed object is None whenever errors are non-empty. The block
    text (when the sentinels were found) is still returned for malformed content
    so callers can quote it.
    """
    lines = normalize_newlines(text).split("\n")
    open_indexes = [i for i, ln in enumerate(lines) if ln.strip() == CRITERIA_BLOCK_OPEN]
    if not open_indexes:
        return None, None, [f"missing {CRITERIA_BLOCK_OPEN} sentinel line"]
    if len(open_indexes) > 1:
        return None, None, [f"multiple {CRITERIA_BLOCK_OPEN} blocks (exactly one required)"]
    open_i = open_indexes[0]
    close_i = next(
        (i for i, ln in enumerate(lines) if i > open_i and ln.strip() == CRITERIA_BLOCK_CLOSE),
        None,
    )
    if close_i is None:
        return None, None, [f"missing {CRITERIA_BLOCK_CLOSE} sentinel line after {CRITERIA_BLOCK_OPEN}"]

    block = "\n".join(lines[open_i : close_i + 1])
    inner = "\n".join(lines[open_i + 1 : close_i]).strip()
    if not inner:
        return block, None, [f"empty {CRITERIA_BLOCK_OPEN} block"]
    try:
        obj = json.loads(strip_markdown_fences(inner))
    except (json.JSONDecodeError, ValueError) as exc:
        return block, None, [f"{CRITERIA_BLOCK_OPEN} block is not valid JSON: {exc}"]
    errs = _validate_criteria_schema(obj)
    if errs:
        return block, None, errs
    return block, obj, []


def declared_criteria_categories(criteria: dict[str, Any]) -> list[str]:
    """Category names (raw, stripped) declared by a validated criteria object."""
    categories = criteria.get("categories")
    if not isinstance(categories, list):
        return []
    names: list[str] = []
    for entry in categories:
        if isinstance(entry, dict) and isinstance(entry.get("name"), str) and entry["name"].strip():
            names.append(entry["name"].strip())
    return names


def _blocking_findings_markdown(text: str) -> tuple[list[dict[str, Optional[str]]], list[str]]:
    lines = text.split("\n")
    header_i = next((i for i, ln in enumerate(lines) if _RE_MD_BLOCKERS_HEADER.match(ln.strip())), None)
    if header_i is None:
        return [], [f"missing '{_MD_BLOCKERS_HEADER}' section; cannot verify BLOCKING conformance"]
    findings: list[dict[str, Optional[str]]] = []
    errs: list[str] = []
    for ln in lines[header_i + 1 :]:
        if ln.startswith("## "):
            break
        m = _RE_MD_TOP_BULLET.match(ln)
        if not m:
            stripped = ln.strip()
            if not stripped or _RE_CRITERIA_REVISION_PREFIX.match(ln):
                continue
            if ln[:1].isspace():
                # Indented content is continuation detail of the finding above
                # it — EXCEPT an indented bullet that carries a category tag,
                # which is a finding in its own right (otherwise nesting would
                # let an out-of-scope BLOCKING finding evade the check).
                nested = _RE_MD_INDENTED_BULLET.match(ln)
                if nested:
                    nested_body = nested.group("body").strip()
                    if _RE_BLOCKING_CATEGORY_TAG.match(nested_body):
                        findings.append(
                            {
                                "category": _RE_BLOCKING_CATEGORY_TAG.match(nested_body)
                                .group("category")
                                .strip(),
                                "text": nested_body,
                            }
                        )
                continue
            # Column-0 prose: a plain-text no-blocker placeholder is fine, but
            # anything else must not silently evade the category conformance
            # check by not being a bullet.
            if _is_placeholder_blocker_text(stripped):
                continue
            errs.append(
                f"unstructured content under '{_MD_BLOCKERS_HEADER}' (findings must be "
                f"top-level bullets): {stripped[:80]!r}"
            )
            continue
        body = m.group("body").strip()
        if _is_placeholder_blocker_text(body):
            continue
        if body.startswith(CRITERIA_REVISION_PREFIX):
            # A bulleted revision declaration is not a finding; it is parsed by
            # _criteria_revisions_markdown.
            continue
        tag = _RE_BLOCKING_CATEGORY_TAG.match(body)
        findings.append(
            {
                "category": tag.group("category").strip() if tag else None,
                "text": body,
            }
        )
    return findings, errs


def _blocking_findings_json(obj: dict[str, Any]) -> tuple[list[dict[str, Optional[str]]], list[str]]:
    entries = obj.get("blocking_issues")
    if not isinstance(entries, list):
        return [], ["missing 'blocking_issues' array; cannot verify BLOCKING conformance"]
    findings: list[dict[str, Optional[str]]] = []
    errs: list[str] = []
    for i, entry in enumerate(entries):
        if isinstance(entry, str):
            tag = _RE_BLOCKING_CATEGORY_TAG.match(entry)
            findings.append(
                {
                    "category": tag.group("category").strip() if tag else None,
                    "text": entry.strip(),
                }
            )
        elif isinstance(entry, dict):
            category = entry.get("category")
            if isinstance(category, str) and category.strip():
                findings.append({"category": category.strip(), "text": json.dumps(entry, sort_keys=True)})
            else:
                findings.append({"category": None, "text": json.dumps(entry, sort_keys=True)})
        else:
            errs.append(f"blocking_issues[{i}] must be a string or object")
    return findings, errs


def _criteria_revisions_markdown(text: str) -> tuple[dict[str, str], list[str]]:
    revisions: dict[str, str] = {}
    errs: list[str] = []
    for ln in text.split("\n"):
        if not _RE_CRITERIA_REVISION_PREFIX.match(ln):
            continue
        m = _RE_CRITERIA_REVISION_LINE.match(ln)
        if not m:
            errs.append(
                f"malformed criteria revision line (expected 'CRITERIA_REVISION: <category>: <reason>'): {ln.strip()!r}"
            )
            continue
        revisions[normalize_criteria_category(m.group("category"))] = m.group("reason").strip()
    return revisions, errs


def _criteria_revisions_json(obj: dict[str, Any]) -> tuple[dict[str, str], list[str]]:
    raw = obj.get(JSON_CRITERIA_REVISIONS_FIELD)
    if raw is None:
        return {}, []
    if not isinstance(raw, list):
        return {}, [f"'{JSON_CRITERIA_REVISIONS_FIELD}' must be an array"]
    revisions: dict[str, str] = {}
    errs: list[str] = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            errs.append(f"{JSON_CRITERIA_REVISIONS_FIELD}[{i}] must be an object")
            continue
        category = entry.get("category")
        reason = entry.get("reason")
        if not isinstance(category, str) or not category.strip():
            errs.append(f"{JSON_CRITERIA_REVISIONS_FIELD}[{i}].category must be a non-empty string")
            continue
        if not isinstance(reason, str) or not reason.strip():
            errs.append(f"{JSON_CRITERIA_REVISIONS_FIELD}[{i}].reason must be a non-empty string")
            continue
        revisions[normalize_criteria_category(category)] = reason.strip()
    return revisions, errs


def check_two_phase_conformance(phase1_text: str, phase2_text: str) -> list[str]:
    """Machine-check that a phase-2 review honors its phase-1 criteria commitment.

    Every BLOCKING finding in the phase-2 output must carry a category that is
    either declared in the phase-1 criteria block or covered by an explicit
    criteria revision declaration in the phase-2 output. Only presence and
    format are checked; revision-reason quality is out of scope here.
    """
    _, criteria, criteria_errors = extract_review_criteria_block(phase1_text)
    if criteria_errors:
        return [f"phase1: {e}" for e in criteria_errors]
    assert criteria is not None  # validated above
    declared = {normalize_criteria_category(name) for name in declared_criteria_categories(criteria)}

    errs: list[str] = []
    normalized = normalize_newlines(phase2_text)
    fmt = _detect_format(normalized)
    if fmt == "json":
        try:
            obj = json.loads(strip_markdown_fences(normalized))
        except (json.JSONDecodeError, ValueError) as exc:
            return [f"phase2: output is not valid JSON, cannot verify conformance: {exc}"]
        if not isinstance(obj, dict):
            return ["phase2: JSON root must be an object, cannot verify conformance"]
        findings, finding_errors = _blocking_findings_json(obj)
        revisions, revision_errors = _criteria_revisions_json(obj)
    else:
        findings, finding_errors = _blocking_findings_markdown(normalized)
        revisions, revision_errors = _criteria_revisions_markdown(normalized)

    errs.extend(f"phase2: {e}" for e in finding_errors)
    errs.extend(f"phase2: {e}" for e in revision_errors)

    for finding in findings:
        category = finding.get("category")
        preview = str(finding.get("text") or "")[:80]
        if not category:
            errs.append(f"phase2: BLOCKING finding has no [<category>] tag: {preview!r}")
            continue
        key = normalize_criteria_category(category)
        if key in declared or key in revisions:
            continue
        errs.append(
            f"phase2: BLOCKING category {category!r} is outside the phase-1 declared review "
            f"criteria and has no criteria revision declaration"
        )
    return errs
