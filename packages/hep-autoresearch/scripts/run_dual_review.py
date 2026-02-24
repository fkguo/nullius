#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import re
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit._git import try_get_git_metadata  # noqa: E402
from hep_autoresearch.toolkit._json import write_json  # noqa: E402
from hep_autoresearch.toolkit._paths import manifest_cwd  # noqa: E402
from hep_autoresearch.toolkit._time import utc_now_iso  # noqa: E402
from hep_autoresearch.toolkit.context_pack import ContextPackInputs, build_context_pack  # noqa: E402


SAFE_UNTRACKED_PREFIXES = (
    "src/",
    "scripts/",
    "prompts/",
    "docs/",
    "evals/",
    "specs/",
    "workflows/",
    "templates/",
    "bin/",
)

EXCLUDED_UNTRACKED_PREFIXES = (
    "artifacts/",
    "references/",
    "paper/",
    "team/",
    ".autopilot/",
    ".hep/",
    ".git/",
)

EXCLUDED_UNTRACKED_EXTENSIONS = (
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".der",
    ".crt",
    ".cer",
    ".p7b",
)

EXCLUDED_UNTRACKED_NAME_SUBSTRINGS = (
    "id_rsa",
    "id_ed25519",
    "private_key",
    "ssh_key",
    "apikey",
    "api_key",
    "access_token",
    "refresh_token",
    "secret",
    "password",
    "passwd",
    "credential",
)

_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?im)^(?:export\s+)?(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|HF_TOKEN|HUGGINGFACEHUB_API_TOKEN)\s*=\s*\S+"
)

PACKET_EXCLUDED_DIFF_PREFIXES = (
    "artifacts/",
    "references/",
    "paper/",
    "team/",
)

PACKET_HIGH_SIGNAL_EXTENSIONS = (
    ".md",
    ".py",
    ".json",
    ".toml",
    ".yaml",
    ".yml",
    ".txt",
    ".sh",
)

PACKET_MAX_FILE_PATCH_CHARS = 40_000
PACKET_MAX_TOTAL_PATCH_CHARS = 220_000
PACKET_MAX_FOCUS_FILES = 40

REVIEW_CONTRACT_REQUIRED_HEADERS = (
    "## Blockers",
    "## Non-blocking",
    "## Real-research fit",
    "## Robustness & safety",
    "## Specific patch suggestions",
)


def _run_capture(cmd: list[str], *, cwd: Path) -> tuple[int, str]:
    p = subprocess.run(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return int(p.returncode), p.stdout


def _git(repo_root: Path, args: list[str]) -> str:
    rc, out = _run_capture(["git"] + args, cwd=repo_root)
    if rc != 0:
        return out.strip()
    return out.rstrip()


def _find_agent_swarm_script() -> Path:
    codex_home = os.environ.get("CODEX_HOME", "").strip()
    base = Path(codex_home).expanduser().resolve() if codex_home else (Path.home() / ".codex").resolve()
    p = base / "skills" / "review-swarm" / "scripts" / "bin" / "run_dual_task.py"
    if not p.is_file():
        raise FileNotFoundError(f"review-swarm runner not found: {p}")
    return p


def _find_claude_runner_script() -> Path:
    codex_home = os.environ.get("CODEX_HOME", "").strip()
    base = Path(codex_home).expanduser().resolve() if codex_home else (Path.home() / ".codex").resolve()
    p = base / "skills" / "claude-cli-runner" / "scripts" / "run_claude.sh"
    if not p.is_file():
        raise FileNotFoundError(f"claude-cli-runner not found: {p}")
    return p


def _find_gemini_cli() -> str:
    p = shutil.which("gemini")
    if not p:
        raise FileNotFoundError("gemini CLI not found in PATH")
    return p


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _first_verdict(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        first = path.read_text(encoding="utf-8", errors="replace").splitlines()[0].strip()
    except Exception:
        return None
    return first if first.startswith("VERDICT:") else None


def _guess_fence_lang(path: str) -> str:
    p = path.lower()
    if p.endswith(".py"):
        return "python"
    if p.endswith(".md"):
        return "markdown"
    if p.endswith(".json"):
        return "json"
    if p.endswith(".sh"):
        return "bash"
    if p.endswith(".txt"):
        return "text"
    return ""


def _normalize_relpath(rel: str) -> str:
    s = rel.strip()
    if s.startswith("./"):
        s = s[2:]
    s = s.replace("\\", "/")
    while s.startswith("/"):
        s = s[1:]
    return s


def _untracked_inclusion_policy(rel: str) -> tuple[bool, str | None]:
    """Return (include_content, reason_if_excluded)."""
    rel_norm = _normalize_relpath(rel)
    parts = [p for p in rel_norm.split("/") if p]
    if any(p.startswith(".") for p in parts):
        return False, "excluded: dotfile/dotdir"
    for pref in EXCLUDED_UNTRACKED_PREFIXES:
        if rel_norm.startswith(pref):
            return False, f"excluded: under {pref}"
    if not rel_norm.startswith(SAFE_UNTRACKED_PREFIXES):
        return False, "excluded: outside allowlist"
    lower = rel_norm.lower()
    for s in EXCLUDED_UNTRACKED_NAME_SUBSTRINGS:
        if s in lower:
            return False, f"excluded: suspicious_name({s})"
    ext = Path(rel_norm).suffix.lower()
    if ext in EXCLUDED_UNTRACKED_EXTENSIONS:
        return False, f"excluded: sensitive_extension({ext})"
    return True, None


def _safe_read_text_for_packet(path: Path, *, max_bytes: int) -> tuple[str | None, str | None]:
    """Return (text, note). If file looks binary/unreadable, return (None, note)."""
    try:
        raw = path.read_bytes()
    except Exception as e:
        return None, f"(read failed: {e})"
    note_parts: list[str] = []
    if len(raw) > max_bytes:
        raw = raw[:max_bytes]
        note_parts.append(f"truncated_to={max_bytes}B")
    # Heuristic: treat as binary if NUL appears early.
    head = raw[: min(len(raw), 65536)]
    if b"\x00" in head:
        note_parts.append("binary_detected")
        return None, ("; ".join(note_parts) if note_parts else "binary_detected")
    # High-signal secret detection: fail closed and omit content.
    # Anchor to start-of-line to avoid flagging secret-scanner source code that embeds the pattern in strings/regexes.
    if re.search(br"(?m)^\s*-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----", head):
        note_parts.append("secret_like_private_key_detected")
        return None, ("; ".join(note_parts) if note_parts else "secret_like_private_key_detected")
    text = raw.decode("utf-8", errors="replace")
    if _SECRET_ASSIGNMENT_RE.search(text):
        note_parts.append("secret_like_assignment_detected")
        return None, ("; ".join(note_parts) if note_parts else "secret_like_assignment_detected")
    return text, ("; ".join(note_parts) if note_parts else None)


def _truncate_text(s: str, *, max_chars: int) -> tuple[str, str | None]:
    if len(s) <= max_chars:
        return s, None
    # Keep both head+tail so reviewers can see "setup" *and* "final state"
    # (e.g. end-of-file manifest/report logic in long workflow modules).
    head_chars = max(1, int(max_chars * 0.6))
    tail_chars = max(0, max_chars - head_chars)
    head = s[:head_chars].rstrip()
    tail = s[-tail_chars:].lstrip() if tail_chars else ""
    note = f"truncated_to={max_chars}chars (orig={len(s)}chars)"
    if tail:
        return head + "\n\n...(truncated middle)...\n\n" + tail + "\n", note
    return head + "\n\n...(truncated)...\n", note


def _parse_name_status(diff_name_status: str) -> list[str]:
    paths: list[str] = []
    for ln in diff_name_status.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("fatal:"):
            continue
        parts = ln.split("\t")
        if not parts:
            continue
        status = parts[0].strip()
        if status.startswith("R") or status.startswith("C"):
            if len(parts) >= 3:
                paths.append(parts[2].strip())
            continue
        if len(parts) >= 2:
            paths.append(parts[1].strip())
    return paths


def _is_high_signal_path(rel: str) -> bool:
    rel_norm = _normalize_relpath(rel)
    if any(rel_norm.startswith(p) for p in PACKET_EXCLUDED_DIFF_PREFIXES):
        return False
    return Path(rel_norm).suffix.lower() in PACKET_HIGH_SIGNAL_EXTENSIONS


def _build_review_packet(
    *,
    repo_root: Path,
    out_path: Path,
    tag: str,
    context_md: str | None,
    note: str | None,
) -> None:
    def _extract_snippet(*, path: Path, needle: str, before: int, after: int) -> str | None:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None
        lines = text.splitlines()
        idx = None
        for i, ln in enumerate(lines):
            if needle in ln:
                idx = i
                break
        if idx is None:
            return None
        a = max(0, idx - int(before))
        b = min(len(lines), idx + int(after))
        return "\n".join(lines[a:b]).rstrip() + "\n"

    status = _git(repo_root, ["status", "--porcelain"])
    untracked: list[str] = []
    pathspecs = [p.rstrip("/") for p in SAFE_UNTRACKED_PREFIXES]
    ls_out = _git(repo_root, ["ls-files", "--others", "--exclude-standard", "--"] + pathspecs)
    for ln in ls_out.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("fatal:"):
            continue
        untracked.append(ln)
    diff_cached_stat = _git(repo_root, ["diff", "--cached", "--stat"])
    diff_work_stat = _git(repo_root, ["diff", "--stat"])
    diff_cached_name = _git(repo_root, ["diff", "--cached", "--name-status"])
    diff_work_name = _git(repo_root, ["diff", "--name-status"])

    # We intentionally avoid embedding a full `git diff` for huge evidence snapshots
    # (arXiv sources / artifacts). CLI runners may fail with "Argument list too long",
    # and reviewers get low signal from multi-MB patches. Instead:
    # - Always include stats + name-status.
    # - Include size-limited patches only for "high-signal" files (docs/src/scripts/KB notes).
    all_changed = sorted(set(_parse_name_status(diff_cached_name) + _parse_name_status(diff_work_name)))
    focus_files = [p for p in all_changed if _is_high_signal_path(p)]
    focus_files = focus_files[:PACKET_MAX_FOCUS_FILES]
    excluded_files = [p for p in all_changed if p not in set(focus_files)]

    md: list[str] = [
        f"# Dual review packet — {tag}",
        "",
        "This packet is for strict dual-review. Treat it as packet-only.",
        "",
        "## Goal (global)",
        "",
        "Keep every change aligned with end-to-end agent goals: correctness, research quality, reproducibility, approvals, and eval gates.",
        "",
        "## Context pack",
        "",
        f"- context.md: {context_md or '(missing)'}",
        "",
        "## Developer note",
        "",
        note.strip() if note and note.strip() else "(none)",
        "",
        "## Git status",
        "",
        "```text",
        status.strip() or "(clean)",
        "```",
        "",
        "## Diff summary (compact)",
        "",
        "### Staged (`git diff --cached`)",
        "",
        "```text",
        diff_cached_stat.strip() or "(none)",
        "```",
        "",
        "```text",
        diff_cached_name.strip() or "(none)",
        "```",
        "",
        "### Unstaged (`git diff`)",
        "",
        "```text",
        diff_work_stat.strip() or "(none)",
        "```",
        "",
        "```text",
        diff_work_name.strip() or "(none)",
        "```",
        "",
    ]

    if excluded_files:
        md.extend(["## Changed files (patch omitted; low-signal or huge)", ""])
        md.append("These are still part of the change, but we omit full patches from the packet for size/signal reasons.")
        md.append("")
        for rel in excluded_files:
            md.append(f"- `{_normalize_relpath(rel)}`")
        md.append("")

    if focus_files:
        md.extend(["## Patch excerpts (high-signal; size-limited)", ""])
        total_patch_chars = 0
        for rel in focus_files:
            rel_norm = _normalize_relpath(rel)
            cached_patch = _git(repo_root, ["diff", "--cached", "--", rel_norm])
            work_patch = _git(repo_root, ["diff", "--", rel_norm])
            if not cached_patch.strip() and not work_patch.strip():
                continue

            parts: list[str] = []
            if cached_patch.strip():
                parts.append("### Staged patch (`git diff --cached`)\n")
                parts.append(cached_patch.rstrip())
            if work_patch.strip():
                parts.append("\n### Unstaged patch (`git diff`)\n")
                parts.append(work_patch.rstrip())
            body = "\n".join(parts).rstrip() + "\n"

            body, note2 = _truncate_text(body, max_chars=PACKET_MAX_FILE_PATCH_CHARS)
            if total_patch_chars + len(body) > PACKET_MAX_TOTAL_PATCH_CHARS:
                md.append(f"- (remaining patches omitted: packet patch budget exceeded at {PACKET_MAX_TOTAL_PATCH_CHARS} chars)")
                md.append("")
                break
            total_patch_chars += len(body)

            md.append(f"### `{rel_norm}`")
            md.append("")
            if note2:
                md.append(f"_note: {note2}_")
                md.append("")
            md.append("```diff")
            md.append(body.rstrip())
            md.append("```")
            md.append("")

    # Extra context for reviewers: some workflow correctness relies on shared post-processing
    # that may not appear in the diff excerpt (e.g., state persistence/ledger writes in cmd_run).
    orch_rel = "src/hep_autoresearch/orchestrator_cli.py"
    if orch_rel in all_changed:
        orch_path = repo_root / orch_rel
        md.extend(["## Extra context excerpts", ""])
        md.append(f"### `{orch_rel}` — gate history helper")
        md.append("")
        sn1 = _extract_snippet(path=orch_path, needle="def _approval_history_has_approved", before=0, after=80)
        if sn1:
            sn1, note2 = _truncate_text(sn1, max_chars=18_000)
            if note2:
                md.append(f"_note: {note2}_")
                md.append("")
            md.append("```python")
            md.append(sn1.rstrip())
            md.append("```")
        else:
            md.append("(snippet not found)")
        md.append("")

        md.append(f"### `{orch_rel}` — cmd_run shared post-processing (state/ledger)")
        md.append("")
        sn2 = _extract_snippet(path=orch_path, needle='st.setdefault("artifacts", {}).update(res.get("artifact_paths") or {})', before=5, after=70)
        if sn2:
            sn2, note3 = _truncate_text(sn2, max_chars=18_000)
            if note3:
                md.append(f"_note: {note3}_")
                md.append("")
            md.append("```python")
            md.append(sn2.rstrip())
            md.append("```")
        else:
            md.append("(snippet not found)")
        md.append("")

    if untracked:
        md.extend(["## Untracked files (verbatim; size-limited)", ""])
        md.append("Untracked files do not appear in `git diff`. Included content is filtered by a safe allowlist.")
        md.append("")
        included: list[str] = []
        excluded: list[tuple[str, str]] = []
        for rel in untracked:
            ok, reason = _untracked_inclusion_policy(rel)
            if ok:
                included.append(rel)
            else:
                excluded.append((rel, reason or "excluded"))

        md.append(f"- policy: allowlist={', '.join(SAFE_UNTRACKED_PREFIXES)}")
        md.append(f"- included: {len(included)}")
        md.append(f"- excluded: {len(excluded)}")
        md.append("")

        if excluded:
            md.append("### Excluded (listed, content omitted)")
            md.append("")
            for rel, reason in excluded:
                md.append(f"- `{rel}` — {reason}")
            md.append("")

        max_bytes = 200_000
        for rel in included:
            p = repo_root / rel
            md.append(f"### `{rel}`")
            if not p.is_file():
                md.append("")
                md.append("(missing file)")
                md.append("")
                continue
            text, note2 = _safe_read_text_for_packet(p, max_bytes=max_bytes)
            md.append("")
            if note2:
                md.append(f"_note: {note2}_")
                md.append("")
            if text is None:
                md.append("(binary or unreadable; content omitted)")
                md.append("")
                continue
            lang = _guess_fence_lang(rel)
            fence = "```" + lang if lang else "```"
            md.append(fence)
            md.append(text.rstrip())
            md.append("```")
            md.append("")

    md.extend(
        [
        "## How to verify (deterministic)",
        "",
        "- `python3 scripts/run_evals.py --tag <TAG>`",
        "- `python3 scripts/run_orchestrator_regression.py --tag <TAG>` (if touching Orchestrator gates/UX)",
        "",
        ]
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(md).rstrip() + "\n", encoding="utf-8")


def _check_review_contract(path: Path) -> list[str]:
    if not path.is_file():
        return ["missing output file"]
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = raw.splitlines()
    first = lines[0].strip() if lines else ""
    issues: list[str] = []
    if first not in ("VERDICT: READY", "VERDICT: NOT_READY"):
        issues.append(f"bad first line: {first!r}")
    for hdr in REVIEW_CONTRACT_REQUIRED_HEADERS:
        if hdr not in raw:
            issues.append(f"missing header: {hdr}")
    return issues


def _normalize_review_output(raw: str) -> tuple[str, str | None]:
    """Normalize reviewer output to the strict contract (trim preamble, normalize verdict line).

    Returns (normalized_text, note_if_changed_or_problem).
    """
    if not raw.strip():
        return raw, "empty_output"

    verdict_re = re.compile(r"(?m)^\s*\**VERDICT:\s*(READY|NOT_READY)\**\s*$")
    m = verdict_re.search(raw)
    if not m:
        return raw, "missing_verdict_line"

    start = m.start()
    norm = raw[start:].lstrip("\n")
    lines = norm.splitlines()
    if not lines:
        return raw, "normalize_failed_empty"

    verdict = m.group(1)
    lines[0] = f"VERDICT: {verdict}"
    norm2 = "\n".join(lines).rstrip() + "\n"

    if norm2 == raw:
        return raw, None
    return norm2, "trimmed_to_verdict"


def _normalize_output_file(path: Path) -> str | None:
    """In-place normalize and keep a .raw.md backup when changes occur."""
    if not path.is_file():
        return "missing_output_file"
    raw = path.read_text(encoding="utf-8", errors="replace")
    norm, note = _normalize_review_output(raw)
    if note is None:
        return None
    raw_path = path.with_suffix(path.suffix + ".raw")
    raw_path.write_text(raw, encoding="utf-8")
    path.write_text(norm, encoding="utf-8")
    return note


def _run_reviewer_claude(
    *,
    repo_root: Path,
    run_claude: Path,
    model: str,
    system_prompt: Path,
    prompt: Path,
    out_path: Path,
) -> tuple[int, str]:
    cmd = [
        "bash",
        os.fspath(run_claude),
        "--model",
        str(model),
        "--system-prompt-file",
        os.fspath(system_prompt),
        "--prompt-file",
        os.fspath(prompt),
        "--out",
        os.fspath(out_path),
    ]
    return _run_capture(cmd, cwd=repo_root)


def _run_reviewer_gemini(
    *,
    repo_root: Path,
    gemini_bin: str,
    model: str,
    prompt: Path,
    out_path: Path,
) -> tuple[int, str]:
    # Review runs should not need tools. Default to "default" (works across CLI versions).
    # Override via GEMINI_APPROVAL_MODE if you explicitly want "auto_edit"/"yolo".
    approval_mode = os.environ.get("GEMINI_APPROVAL_MODE", "").strip() or "default"

    def run_one(cmd: list[str], *, stdin_text: str | None) -> tuple[int, str]:
        def try_extract_json_response(s: str) -> str | None:
            # Gemini CLI may print preamble/log lines before the JSON payload.
            # Prefer the known wrapper shape ({ "response": "..." }) and only accept parses that contain it.
            scan = s[:250_000]
            starts: list[int] = []
            marker = '{"response"'
            idx = scan.find(marker)
            if idx != -1:
                starts.append(idx)
            for m in re.finditer(r"{", scan):
                starts.append(m.start())
                if len(starts) >= 25:
                    break
            dec = json.JSONDecoder()
            seen: set[int] = set()
            for start in starts:
                if start in seen:
                    continue
                seen.add(start)
                try:
                    obj, _ = dec.raw_decode(scan[start:])
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                resp = obj.get("response")
                if isinstance(resp, str):
                    return resp
                if isinstance(resp, dict) and isinstance(resp.get("text"), str):
                    return resp["text"]
            return None

        try:
            p = subprocess.run(
                cmd,
                cwd=repo_root,
                input=stdin_text,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
                text=True if stdin_text is not None else False,
            )
        except FileNotFoundError as e:
            return 127, f"{e}\n"

        if isinstance(p.stdout, bytes):
            out_raw = p.stdout.decode("utf-8", errors="replace")
        else:
            out_raw = str(p.stdout)
        # Gemini CLI may print startup/log lines even in non-interactive mode; strip known preamble.
        lines = out_raw.splitlines(keepends=True)
        if lines and lines[0].startswith("Hook registry initialized with"):
            out_raw = "".join(lines[1:])

        # gemini -o json returns a JSON object with a top-level "response" field.
        # Prefer that field, but fall back to raw text (and VERDICT-line trimming) when parsing fails.
        out_text = out_raw
        parsed_response = try_extract_json_response(out_raw)
        if parsed_response:
            out_text = parsed_response

        # Normalize to the strict review output contract (must start at VERDICT:).
        # If Gemini returns an error page / wrapper output, emit a valid NOT_READY review
        # so the runner doesn't crash without a readable verdict.
        norm, note = _normalize_review_output(out_text)
        if note in (None, "trimmed_to_verdict"):
            out_text = norm
        else:
            excerpt = out_raw.strip()
            if len(excerpt) > 6000:
                excerpt = excerpt[:6000].rstrip() + "\n...(truncated)...\n"
            out_text = (
                "VERDICT: NOT_READY\n\n"
                "## Blockers\n\n"
                "1. Reviewer-B (gemini) did not return a valid review contract output. Raw output excerpt:\n\n"
                "```text\n"
                + excerpt
                + "\n```\n\n"
                "## Non-blocking\n\n"
                "- (none)\n\n"
                "## Real-research fit\n\n"
                "- (n/a)\n\n"
                "## Robustness & safety\n\n"
                "- Retry the dual review; if this persists, inspect gemini CLI connectivity/logs.\n\n"
                "## Specific patch suggestions\n\n"
                "- Retry with `--skip-run` to validate the packet, then rerun reviewers.\n"
            )

        out_path.write_text(out_text.rstrip() + "\n", encoding="utf-8")
        return int(p.returncode), ""

    prompt_text = prompt.read_text(encoding="utf-8", errors="replace")

    # Keep `-p` non-empty to force headless mode on gemini CLI variants that ignore stdin with `-p ""`.
    prompt_suffix = " "

    # Primary mode: feed full prompt via stdin (stable for long prompts) and use a neutral non-empty `-p`.
    cmd = [
        str(gemini_bin),
        "-m",
        str(model),
        "-o",
        "json",
        "-p",
        prompt_suffix,
        "--approval-mode",
        approval_mode,
    ]
    rc, out = run_one(cmd, stdin_text=prompt_text)
    if rc != 0 and str(model).strip():
        # Fallback: omit -m in case the local CLI uses different model aliases.
        cmd2 = [
            str(gemini_bin),
            "-o",
            "json",
            "-p",
            prompt_suffix,
            "--approval-mode",
            approval_mode,
        ]
        rc2, out2 = run_one(cmd2, stdin_text=prompt_text)
        if rc2 != 0:
            return rc2, out2 or out
        warn = f"[warn] gemini model fallback: requested_model={model!r}; used_default_model (no -m)\n"
        return rc2, warn + (out2 or "")
    return rc, out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Run a strict dual-model review with a required output contract (Opus + reviewer-B)."
    )
    ap.add_argument("--tag", required=True, help="Run tag for artifacts/runs/<tag>/dual_review/...")
    ap.add_argument("--note", default="", help="Developer note included in the review packet.")
    ap.add_argument(
        "--system-prompt",
        default="prompts/_system_dual_review_dev.md",
        help="System prompt file (Claude) and prefix for Gemini prompt (when reviewer-B backend is gemini).",
    )
    ap.add_argument("--claude-model", default="opus", help="Claude model (default: opus).")
    ap.add_argument(
        "--reviewer-b-backend",
        default="claude",
        choices=["claude", "gemini"],
        help="Reviewer-B backend (default: claude). Use gemini for cross-vendor review when available.",
    )
    ap.add_argument(
        "--gemini-model",
        default=None,
        help="Reviewer-B model. Defaults: claude backend -> sonnet; gemini backend -> gemini-3-pro-preview.",
    )
    ap.add_argument("--skip-run", action="store_true", help="Only build the packet (do not call reviewers).")
    ap.add_argument("--no-contract-check", action="store_true", help="Do not enforce the strict review output contract.")
    args = ap.parse_args()

    repo_root = Path.cwd()
    tag = str(args.tag).strip()
    if not tag:
        raise SystemExit(2)

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = repo_root / "artifacts" / "runs" / tag / "dual_review"
    agent_dir = out_dir / "agent_swarm"
    logs_dir = out_dir / "logs"
    agent_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)

    system_path = repo_root / str(args.system_prompt)
    if not system_path.is_file():
        print(f"[error] missing system prompt: {system_path}", file=sys.stderr)
        return 2

    reviewer_b_backend = str(args.reviewer_b_backend).strip()
    reviewer_b_model = (
        str(args.gemini_model).strip()
        if args.gemini_model is not None
        else ("sonnet" if reviewer_b_backend == "claude" else "gemini-3-pro-preview")
    )

    # Always build/update the context pack first (global guardrail).
    ctx = build_context_pack(ContextPackInputs(run_id=tag, workflow_id=None, note=str(args.note)), repo_root=repo_root)
    context_md = ctx.get("context_md")

    # Packet is always written.
    packet_path = out_dir / "packet.md"
    _build_review_packet(repo_root=repo_root, out_path=packet_path, tag=tag, context_md=context_md, note=str(args.note))

    gemini_prompt_path = out_dir / "gemini_prompt.txt"
    gemini_prompt_path.write_text(
        _read_text(system_path).rstrip() + "\n\n---\n\n" + _read_text(packet_path),
        encoding="utf-8",
    )

    rc = 0
    logs: list[str] = []
    if not args.skip_run:
        run_claude = _find_claude_runner_script()
        gemini_bin = _find_gemini_cli() if reviewer_b_backend == "gemini" else None

        claude_out = agent_dir / "claude_output.md"
        reviewer_b_out = agent_dir / "gemini_output.md"

        logs.append(f"reviewer_a_backend: claude")
        logs.append(f"reviewer_a_model: {args.claude_model}")
        logs.append(f"reviewer_b_backend: {reviewer_b_backend}")
        logs.append(f"reviewer_b_model: {reviewer_b_model}")

        rc_a, out_a = _run_reviewer_claude(
            repo_root=repo_root,
            run_claude=run_claude,
            model=str(args.claude_model),
            system_prompt=system_path,
            prompt=packet_path,
            out_path=claude_out,
        )
        logs.append(f"claude_exit_code: {rc_a}")
        if out_a.strip():
            logs.append("claude_runner_output:")
            logs.append(out_a.rstrip())

        if reviewer_b_backend == "claude":
            rc_b, out_b = _run_reviewer_claude(
                repo_root=repo_root,
                run_claude=run_claude,
                model=reviewer_b_model,
                system_prompt=system_path,
                prompt=packet_path,
                out_path=reviewer_b_out,
            )
        else:
            assert gemini_bin is not None
            rc_b, out_b = _run_reviewer_gemini(
                repo_root=repo_root,
                gemini_bin=gemini_bin,
                model=reviewer_b_model,
                prompt=gemini_prompt_path,
                out_path=reviewer_b_out,
            )
        logs.append(f"reviewer_b_exit_code: {rc_b}")
        if out_b.strip():
            logs.append("reviewer_b_runner_output:")
            logs.append(out_b.rstrip())

        rc = 0 if (rc_a == 0 and rc_b == 0) else 1

        # Normalize outputs to the strict contract (some CLIs may emit a preamble or extra wrapper tags).
        norm_a = _normalize_output_file(claude_out)
        norm_b = _normalize_output_file(reviewer_b_out)
        if norm_a:
            logs.append(f"claude_output_normalized: {norm_a}")
        if norm_b:
            logs.append(f"reviewer_b_output_normalized: {norm_b}")

        if not args.no_contract_check:
            issues_a = _check_review_contract(claude_out)
            issues_b = _check_review_contract(reviewer_b_out)
            if issues_a:
                logs.append(f"[FAIL] {claude_out}")
                for it in issues_a:
                    logs.append(f"  - {it}")
            else:
                logs.append(f"[ok] {claude_out}")
            if issues_b:
                logs.append(f"[FAIL] {reviewer_b_out}")
                for it in issues_b:
                    logs.append(f"  - {it}")
            else:
                logs.append(f"[ok] {reviewer_b_out}")
            if issues_a or issues_b:
                rc = 1

        (logs_dir / "run_dual_task.txt").write_text("\n".join(logs).rstrip() + "\n", encoding="utf-8")

    # Write artifacts (manifest/summary/analysis) even when skip-run is used.
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    claude_out = agent_dir / "claude_output.md"
    gemini_out = agent_dir / "gemini_output.md"

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_dual_review.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": tag,
            "claude_model": str(args.claude_model),
            "reviewer_b_backend": reviewer_b_backend,
            "reviewer_b_model": reviewer_b_model,
            "system_prompt": os.fspath(system_path.relative_to(repo_root)),
            "skip_run": bool(args.skip_run),
            "contract_check": int(not args.no_contract_check),
        },
        "versions": {"python": os.sys.version.split()[0], "os": platform.platform()},
        "outputs": [
            os.fspath(packet_path.relative_to(repo_root)),
            os.fspath(gemini_prompt_path.relative_to(repo_root)),
            os.fspath((logs_dir / "run_dual_task.txt").relative_to(repo_root)) if (logs_dir / "run_dual_task.txt").exists() else None,
            os.fspath(claude_out.relative_to(repo_root)) if claude_out.exists() else None,
            os.fspath((claude_out.with_suffix(claude_out.suffix + ".raw")).relative_to(repo_root))
            if (claude_out.with_suffix(claude_out.suffix + ".raw")).exists()
            else None,
            os.fspath(gemini_out.relative_to(repo_root)) if gemini_out.exists() else None,
            os.fspath((gemini_out.with_suffix(gemini_out.suffix + ".raw")).relative_to(repo_root))
            if (gemini_out.with_suffix(gemini_out.suffix + ".raw")).exists()
            else None,
            os.fspath((agent_dir / "trace.jsonl").relative_to(repo_root)) if (agent_dir / "trace.jsonl").exists() else None,
            os.fspath(manifest_path.relative_to(repo_root)),
            os.fspath(summary_path.relative_to(repo_root)),
            os.fspath(analysis_path.relative_to(repo_root)),
        ],
    }
    manifest["outputs"] = [x for x in manifest["outputs"] if x]
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    claude_verdict = _first_verdict(claude_out)
    gemini_verdict = _first_verdict(gemini_out)
    both_ready = bool(claude_verdict == "VERDICT: READY" and gemini_verdict == "VERDICT: READY")

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "dual_review"},
        "stats": {
            "runner_exit_code": int(rc),
            "both_ready": int(both_ready) if not args.skip_run else None,
        },
        "outputs": {
            "packet": os.fspath(packet_path.relative_to(repo_root)),
            "claude_output": os.fspath(claude_out.relative_to(repo_root)) if claude_out.exists() else None,
            "gemini_output": os.fspath(gemini_out.relative_to(repo_root)) if gemini_out.exists() else None,
        },
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": tag,
            "claude_model": str(args.claude_model),
            "reviewer_b_backend": reviewer_b_backend,
            "reviewer_b_model": reviewer_b_model,
        },
        "results": {
            "runner_exit_code": int(rc),
            "claude_verdict": claude_verdict,
            "gemini_verdict": gemini_verdict,
            "both_ready": int(both_ready) if not args.skip_run else None,
            "context_pack_md": context_md,
            "packet_path": os.fspath(packet_path.relative_to(repo_root)),
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)

    if args.skip_run:
        print("[ok] wrote dual-review packet (skip-run enabled):")
        print(f"- packet: {packet_path.relative_to(repo_root)}")
        return 0

    if rc != 0:
        print(f"[error] dual review runner failed (exit_code={rc}); see {logs_dir/'run_dual_task.txt'}")
        return 2
    if not both_ready:
        print("[warn] dual review verdict: NOT_READY (see reviewer outputs)")
        return 3

    print("[ok] dual review verdict: READY (both models)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
