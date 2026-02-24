#!/usr/bin/env python3
"""
Project charter / goal contract gate.

Purpose:
- Prevent goal drift (e.g., "validation-only") by forcing an explicit, human-reviewable project charter.
- Make the project profile choice explicit and consistent with research_team_config.

Checks (when enabled):
1) PROJECT_CHARTER.md exists (searched upward from the notebook directory).
2) Status is not DRAFT (must be APPROVED/ACTIVE/FINAL).
3) Required fields are filled:
   - Primary goal
   - Validation goal(s)
   - Anti-goals / non-goals (>=1 bullet)
   - Declared profile (matches effective config profile)
4) Project-specific commitments: >=2 bullets, including >=1 clickable Markdown link to knowledge_base/.

Exit codes:
  0 ok, or gate disabled
  1 fail-fast (missing/incomplete charter)
  2 input/config error
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

try:
    from team_config import load_team_config  # type: ignore
except Exception as exc:  # pragma: no cover - import-time failure
    print(f"ERROR: failed to import team_config: {exc}", file=sys.stderr)
    raise SystemExit(2)


ALLOWED_STATUSES = {"APPROVED", "ACTIVE", "FINAL"}
PLACEHOLDER_TOKENS = (
    "<YYYY-MM-DD>",
    "(fill",
    "<PROFILE>",
    "<PROJECT_NAME>",
)


def _strip_fenced_code(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    in_fence = False
    fence_marker = ""
    for ln in lines:
        stripped = ln.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = "```" if stripped.startswith("```") else "~~~"
            if not in_fence:
                in_fence = True
                fence_marker = marker
                continue
            if marker == fence_marker:
                in_fence = False
                fence_marker = ""
                continue
        if not in_fence:
            out.append(ln)
    return "\n".join(out)


def _strip_html_comments(text: str) -> str:
    """
    Remove hidden content like: <!-- [hidden](knowledge_base/foo.md) -->

    Not a full HTML tokenizer; intentionally simple and defensive:
    - Strips from each '<!--' to the next '-->'.
    - If an opening '<!--' is never closed, drop the rest of the document.
    """
    out: list[str] = []
    i = 0
    while True:
        start = text.find("<!--", i)
        if start < 0:
            out.append(text[i:])
            break
        out.append(text[i:start])
        end = text.find("-->", start + 4)
        if end < 0:
            break
        i = end + 3
    return "".join(out)


def _iter_inline_code_spans(text: str) -> list[str]:
    """
    Return contents of Markdown inline-code spans, supporting multi-backtick delimiters.

    This is not a full Markdown parser, but is good enough to detect backticked links like:
      `[label](knowledge_base/foo.md)`
    which are not clickable and must be rejected by this gate.
    """
    spans: list[str] = []
    i = 0
    while i < len(text):
        if text[i] != "`":
            i += 1
            continue
        j = i
        while j < len(text) and text[j] == "`":
            j += 1
        delim = text[i:j]
        end = text.find(delim, j)
        if end < 0:
            # Unmatched delimiter: treat as literal and keep scanning.
            i = j
            continue
        spans.append(text[j:end])
        i = end + len(delim)
    return spans


def _strip_inline_code(text: str) -> str:
    """
    Remove Markdown inline-code spans (including delimiters) from text.

    Used to ensure "clickable link" checks ignore backticked content.
    """
    out: list[str] = []
    i = 0
    while i < len(text):
        if text[i] != "`":
            out.append(text[i])
            i += 1
            continue
        j = i
        while j < len(text) and text[j] == "`":
            j += 1
        delim = text[i:j]
        end = text.find(delim, j)
        if end < 0:
            # Unmatched delimiter: treat as literal backticks, not as an opening code span.
            out.append(delim)
            i = j
            continue
        i = end + len(delim)
    return "".join(out)


def _normalize_link_target(target: str) -> str:
    local = (target or "").strip()
    local = local.split("#", 1)[0].split("?", 1)[0].strip()
    local = unquote(local)
    local = local.replace("\\", "/")
    while local.startswith("./"):
        local = local[2:]
    return local


def _is_safe_kb_local_path(root: Path, local: str) -> bool:
    root_resolved = root.resolve()
    kb_dir = (root / "knowledge_base").resolve()
    try:
        kb_dir.relative_to(root_resolved)
    except ValueError:
        return False
    candidate = (root / local).resolve()
    try:
        candidate.relative_to(kb_dir)
        return True
    except ValueError:
        return False


def _find_unsafe_kb_paths(root: Path, targets: list[str]) -> list[str]:
    unsafe: list[str] = []
    for t in targets:
        local = _normalize_link_target(t)
        if not local.lower().startswith("knowledge_base/"):
            continue
        if ".." in Path(local).parts:
            unsafe.append(local)
            continue
        if not _is_safe_kb_local_path(root, local):
            unsafe.append(local)
    return unsafe


def _find_charter(notes_path: Path) -> Path | None:
    cur = (notes_path.parent if notes_path.is_file() else notes_path).resolve()
    for _ in range(50):
        cand = cur / "PROJECT_CHARTER.md"
        if cand.is_file():
            return cand
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def _extract_field(text: str, field: str) -> str:
    m = re.search(rf"^\s*{re.escape(field)}\s*:\s*(.+?)\s*$", text, flags=re.MULTILINE)
    if not m:
        return ""
    # Drop inline comments.
    val = m.group(1).strip()
    # Only treat " # ..." (space-hash-space) as a comment to avoid truncating content like "issue #42".
    val = re.split(r"\s+#\s", val, maxsplit=1)[0].rstrip()
    return val


def _is_placeholder(s: str) -> bool:
    low = (s or "").strip().lower()
    if not low:
        return True
    if re.search(r"<[A-Z0-9_-]+>", s):
        return True
    if re.search(r"\(fill\b", low):
        return True
    if any(tok in s for tok in PLACEHOLDER_TOKENS):
        return True
    if low in ("tbd", "todo", "none", "n/a", "na"):
        return True
    return False


def _parse_bullets_after_label(text: str, label_prefix: str) -> list[str]:
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.strip().lower().startswith(label_prefix.strip().lower()):
            start = i + 1
            break
    if start is None:
        return []
    out: list[str] = []
    for ln in lines[start:]:
        if re.match(r"^\s*##+\s+\S", ln):
            break
        if ln.strip() == "":
            # Allow "loose lists" (blank lines between bullets).
            continue
        # CommonMark: list items may be indented by up to 3 spaces; tabs expand to 4 spaces.
        # Ignore indented code blocks (`    - ...` or `\t- ...`) which are not clickable links.
        expanded = ln.expandtabs(4)
        if len(expanded) - len(expanded.lstrip(" ")) >= 4:
            continue
        m = re.match(r"^[ ]{0,3}[-*+]\s+(.+?)\s*$", expanded)
        if not m:
            continue
        out.append(m.group(1).strip())
    return out


def _normalize_md_ref_label(label: str) -> str:
    return re.sub(r"\s+", " ", (label or "").strip().lower())


def _strip_md_link_title(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if s.startswith("<"):
        end = s.find(">")
        if end > 0:
            return s[1:end].strip()
    # Markdown title comes after whitespace: (target "title")
    return s.split()[0].strip().strip("<>")


def _iter_md_inline_link_targets(text: str) -> list[str]:
    """
    Extract Markdown inline link targets from patterns like: [label](target "title").

    This is intentionally a small state machine (not a full Markdown parser) to be robust
    to parentheses inside targets (e.g. `file_(v1).md`).
    """
    targets: list[str] = []
    i = 0
    while True:
        open_bracket = text.find("[", i)
        if open_bracket < 0:
            break
        # Skip images: ![alt](...)
        if open_bracket > 0 and text[open_bracket - 1] == "!":
            i = open_bracket + 1
            continue
        close_bracket = text.find("]", open_bracket + 1)
        if close_bracket < 0:
            break
        if close_bracket + 1 >= len(text) or text[close_bracket + 1] != "(":
            i = close_bracket + 1
            continue

        j = close_bracket + 2
        depth = 1
        buf: list[str] = []
        while j < len(text):
            ch = text[j]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    break
            buf.append(ch)
            j += 1
        if depth != 0:
            i = close_bracket + 1
            continue

        target = _strip_md_link_title("".join(buf))
        if target:
            targets.append(target)
        i = j + 1
    return targets


def _parse_md_reference_definitions(text: str) -> dict[str, str]:
    refs: dict[str, str] = {}
    for ln in text.splitlines():
        expanded = ln.expandtabs(4)
        # Ignore indented code blocks (4+ leading spaces after expanding tabs).
        if len(expanded) - len(expanded.lstrip(" ")) >= 4:
            continue
        m = re.match(r"^[ ]{0,3}\[([^\]]+)\]:\s*(.+?)\s*$", expanded)
        if not m:
            continue
        key = _normalize_md_ref_label(m.group(1))
        target = _strip_md_link_title(m.group(2))
        if key and target:
            refs[key] = target
    return refs


def _iter_md_reference_link_targets(text: str, refs: dict[str, str]) -> list[str]:
    targets: list[str] = []
    for m in re.finditer(r"\[([^\]]+)\]\[([^\]]*)\]", text):
        if m.start() > 0 and text[m.start() - 1] == "!":
            continue
        label = m.group(1)
        ref = m.group(2) or label
        key = _normalize_md_ref_label(ref)
        target = refs.get(key)
        if target:
            targets.append(target)

    # Shortcut reference links: [label] with a matching [label]: target definition.
    i = 0
    while True:
        open_bracket = text.find("[", i)
        if open_bracket < 0:
            break
        if open_bracket > 0 and text[open_bracket - 1] == "!":
            i = open_bracket + 1
            continue
        close_bracket = text.find("]", open_bracket + 1)
        if close_bracket < 0:
            break
        next_ch = text[close_bracket + 1] if close_bracket + 1 < len(text) else ""
        if next_ch in ("(", "[", ":"):
            i = close_bracket + 1
            continue
        label = text[open_bracket + 1 : close_bracket]
        key = _normalize_md_ref_label(label)
        target = refs.get(key)
        if target:
            targets.append(target)
        i = close_bracket + 1

    return targets


def _iter_md_link_targets(text: str, refs: dict[str, str] | None = None) -> list[str]:
    targets = _iter_md_inline_link_targets(text)
    if refs:
        targets.extend(_iter_md_reference_link_targets(text, refs))
    return targets


def _contains_backticked_kb_link(text: str, refs: dict[str, str]) -> bool:
    for span in _iter_inline_code_spans(text):
        for target in _iter_md_link_targets(span, refs):
            if target.startswith("http://") or target.startswith("https://"):
                continue
            local = _normalize_link_target(target)
            if local.lower().startswith("knowledge_base/"):
                return True
    return False


def _contains_clickable_kb_link(text: str, refs: dict[str, str], root: Path) -> bool:
    visible = _strip_inline_code(text)
    for target in _iter_md_link_targets(visible, refs):
        if target.startswith("http://") or target.startswith("https://"):
            continue
        local = _normalize_link_target(target)
        if not local.lower().startswith("knowledge_base/"):
            continue
        if ".." in Path(local).parts:
            continue
        if _is_safe_kb_local_path(root, local):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    args = ap.parse_args()

    notes = args.notes
    if not notes.exists():
        print(f"ERROR: notes not found: {notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(notes)
    if not cfg.feature_enabled("project_charter_gate", default=True):
        print("[skip] project charter gate disabled by research_team_config")
        return 0

    charter = _find_charter(notes)
    if charter is None:
        print("[fail] project charter gate failed")
        print("[error] Missing PROJECT_CHARTER.md (expected at project root).")
        print("[fix] Create PROJECT_CHARTER.md from the skill scaffold and set Status: APPROVED.")
        return 1

    try:
        raw = charter.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"ERROR: failed to read PROJECT_CHARTER.md: {charter} ({exc})", file=sys.stderr)
        return 2

    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    clean = _strip_fenced_code(text)
    clean = _strip_html_comments(clean)

    refs = _parse_md_reference_definitions(clean)

    errors: list[str] = []

    status = _extract_field(clean, "Status")
    if not status:
        errors.append("Missing required field: 'Status: ...' (set to APPROVED/ACTIVE/FINAL after review).")
    else:
        token = re.split(r"\s+", status.strip(), maxsplit=1)[0].upper()
        if token not in ALLOWED_STATUSES:
            errors.append(f"Status must be one of {sorted(ALLOWED_STATUSES)} (found: {status!r}).")

    primary = _extract_field(clean, "Primary goal")
    if _is_placeholder(primary):
        errors.append("Primary goal is missing or still a placeholder. Fill 'Primary goal: ...'.")

    validation = _extract_field(clean, "Validation goal(s)")
    if _is_placeholder(validation):
        errors.append("Validation goal(s) is missing or still a placeholder. Fill 'Validation goal(s): ...'.")

    declared_profile = _extract_field(clean, "Declared profile")
    effective_profile = str(cfg.data.get("profile", "")).strip()
    if _is_placeholder(declared_profile):
        errors.append("Declared profile is missing or still a placeholder. Fill 'Declared profile: ...'.")
    elif declared_profile.strip().lower() != effective_profile.strip().lower():
        errors.append(
            f"Declared profile mismatch: PROJECT_CHARTER.md has {declared_profile!r} but research_team_config effective profile is {effective_profile!r}. "
            "Fix: update 'Declared profile:' in PROJECT_CHARTER.md or set 'profile' in research_team_config.json."
        )

    anti = _parse_bullets_after_label(clean, "Anti-goals")
    if not anti:
        errors.append("Anti-goals/non-goals list is empty. Add at least 1 bullet under 'Anti-goals / non-goals'.")
    elif any(_is_placeholder(x) for x in anti):
        errors.append("Anti-goals/non-goals still contains placeholders. Replace '(fill...)' with concrete items.")

    commitments = _parse_bullets_after_label(clean, "Project-specific commitments")
    commitments_clean = [c for c in commitments if not _is_placeholder(c)]
    if len(commitments_clean) < 2:
        errors.append("Project-specific commitments: need at least 2 non-placeholder bullets.")

    root = charter.parent.resolve()
    if not any(_contains_clickable_kb_link(c, refs, root) for c in commitments_clean):
        errors.append("Project-specific commitments: include at least 1 clickable Markdown link to knowledge_base/ (not in backticks).")

    for item in commitments_clean:
        if _contains_backticked_kb_link(item, refs):
            errors.append("Project-specific commitments contains a knowledge_base Markdown link wrapped in backticks (not clickable). Remove backticks.")
            break
        visible = _strip_inline_code(item)
        targets = _iter_md_link_targets(visible, refs)
        unsafe = _find_unsafe_kb_paths(root, targets)
        if unsafe:
            for p in unsafe:
                errors.append(f"Project-specific commitments contains a knowledge_base link that escapes the knowledge_base/ subtree: {p}")
            continue
        for target in targets:
            if target.startswith("http://") or target.startswith("https://"):
                continue
            local = _normalize_link_target(target)
            if not local.lower().startswith("knowledge_base/"):
                continue
            if not _is_safe_kb_local_path(root, local):
                errors.append(f"Project-specific commitments contains a knowledge_base link that escapes the knowledge_base/ subtree: {local}")
                continue
            if not (root / local).is_file():
                errors.append(f"Project-specific commitments links missing KB file: {local}")

    if errors:
        print("[fail] project charter gate failed")
        print(f"- Charter: `{charter}`")
        for e in errors:
            print(f"[error] {e}")
        return 1

    print("[ok] project charter gate passed")
    print(f"- Charter: `{charter}`")
    print(f"- Profile: {effective_profile}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
