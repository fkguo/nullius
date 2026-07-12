#!/usr/bin/env python3
"""review_one.py — one-command single-reviewer entry for review-swarm.

Assembles the whole review packet (system prompt from templates/<role>.md; user
packet embedding artifact files or a git diff, plus optional context files) and then
delegates to run_multi_task.py in this same directory, so runner discovery,
per-backend read-only tool modes, process-group timeouts, trace.jsonl/meta.json
artifacts and contract checking are inherited from the one launcher — there is
no second orchestration path.

A single reviewer is one model family: its verdict is ADVISORY. Final verdicts
require cross-family review (see SKILL.md, "Host-aware execution").

Examples:
    python3 review_one.py --model codex/default --artifact notes.md
    python3 review_one.py --model gemini/default --diff main..HEAD --role correctness
    python3 review_one.py --model kimi/default --extraction-request questions.md \\
        --source paper.tex --source-text-origin direct-original-text \\
        --correction-status not-applicable --role source-extraction
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import run_multi_task  # same-directory launcher; single orchestration path

_SKILL_ROOT = _SCRIPT_DIR.parents[1]
_TEMPLATES_DIR = _SKILL_ROOT / "templates"
_ROLES = (
    "generic",
    "correctness",
    "execution-adversary",
    "source-extraction",
    "source-fidelity",
)
_RUNNER_BACKENDS = ("opencode", "claude", "codex", "gemini", "kimi")
_SOURCE_EXTRACTION_ROLE = "source-extraction"
_SOURCE_FIDELITY_ROLE = "source-fidelity"
_SOURCE_ROLES = (_SOURCE_EXTRACTION_ROLE, _SOURCE_FIDELITY_ROLE)
_CORRECTION_STATUSES = (
    "not-applicable",
    "checked-none-found",
    "checked-corrections-included",
)
_SOURCE_TEXT_ORIGINS = (
    "direct-original-text",
    "visually-verified-transcription",
)

ADVISORY_BANNER = "single-family review — advisory; final verdicts require cross-family review"

_PACKET_FRAMING = """\
=== REVIEW TASK ===

Review the material embedded below against your system-prompt role. Everything
you are expected to judge is embedded in this packet; ground every finding in
the embedded text (quote the exact line or name the exact location). Produce
exactly the output format your system prompt requires: the verdict first line,
then all required section headers.
"""


def _read_text_payload(raw: str, *, label: str) -> tuple[Path, str, str, int]:
    p = Path(raw).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"{label} file not found: {p}")
    data = p.read_bytes()
    return p, data.decode("utf-8", errors="replace"), hashlib.sha256(data).hexdigest(), len(data)


def _read_review_artifact(raw: str) -> tuple[Path, str, str, int]:
    return _read_text_payload(raw, label="--artifact")


def _embedded_text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _verbatim_packet_text(text: str) -> str:
    """Preserve payload text exactly, adding only a delimiter newline if needed."""
    return text if text.endswith("\n") else text + "\n"


def _packet_delimiter_newline_added(text: str) -> bool:
    return not text.endswith("\n")


def _read_primary_source(raw: str, *, flag: str = "--source") -> tuple[Path, str, str, int]:
    """Read an exact text source suitable for literal comparison."""
    p = Path(raw).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"{flag} file not found: {p}")
    data = p.read_bytes()
    if not data:
        raise ValueError(f"{flag} file is empty: {p}")
    if b"\x00" in data:
        raise ValueError(
            f"{flag} must be an exact UTF-8 text/LaTeX/Markdown extract, not a binary file: {p}. "
            "This text-only entry cannot certify a PDF or scan. Use a PDF/image-capable reviewer against "
            "the original page, then persist its visually verified excerpt, locator, and source-page hash; "
            "do not rely on lossy automatic decoding for formula fidelity."
        )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(
            f"{flag} is not valid UTF-8 text: {p} (decode error at byte {exc.start}). "
            "Persist an exact UTF-8 source extract before running a literal fidelity review."
        ) from exc
    if not text.strip():
        raise ValueError(f"{flag} contains no non-whitespace text: {p}")
    return p, text, hashlib.sha256(data).hexdigest(), len(data)


def _validate_source_review_inputs(args: argparse.Namespace) -> None:
    sources = list(args.source or [])
    correction_sources = list(args.correction_source or [])
    correction_search_evidence = list(args.correction_search_evidence or [])
    source_provenance_evidence = list(args.source_provenance_evidence or [])
    context_path_list = [Path(raw).expanduser().resolve() for raw in (args.context or [])]
    context_paths = set(context_path_list)
    if len(context_paths) != len(context_path_list):
        raise ValueError("duplicate --context paths are not allowed")
    artifact_paths = {Path(raw).expanduser().resolve() for raw in (args.artifact or [])}
    context_target_overlap = context_paths & artifact_paths
    if context_target_overlap:
        joined = ", ".join(str(path) for path in sorted(context_target_overlap))
        raise ValueError(
            "the review target and additional context must be distinct files; overlapping "
            "path(s): " + joined
        )
    if args.role not in _SOURCE_ROLES:
        if (
            sources
            or correction_sources
            or correction_search_evidence
            or source_provenance_evidence
            or args.correction_status
            or args.source_text_origin
        ):
            raise ValueError(
                "--source, --source-text-origin, --source-provenance-evidence, "
                "--correction-source, --correction-search-evidence, and --correction-status "
                "are only valid with --role source-extraction or --role source-fidelity"
            )
        if args.extraction_request:
            raise ValueError(
                "--extraction-request is only valid with --role source-extraction"
            )
        return
    if not sources:
        raise ValueError(
            f"--role {args.role} requires at least one --source containing the exact "
            "primary-source text"
        )
    if not args.source_text_origin:
        raise ValueError(
            f"--role {args.role} requires --source-text-origin; distinguish direct "
            "publisher/repository text from a manual transcription of a PDF or scan"
        )
    if (
        args.source_text_origin == "visually-verified-transcription"
        and not source_provenance_evidence
    ):
        raise ValueError(
            "--source-text-origin visually-verified-transcription requires at least one "
            "--source-provenance-evidence file recording the original document/page and "
            "crop hashes, exact locators, and visual comparison"
        )
    if not args.correction_status:
        raise ValueError(
            f"--role {args.role} requires --correction-status; explicitly declare whether "
            "a correction chain was checked instead of silently assuming the primary source is final"
        )
    if args.role == _SOURCE_EXTRACTION_ROLE:
        if not args.extraction_request:
            raise ValueError(
                "--role source-extraction requires --extraction-request containing only a "
                "neutral locator/question list"
            )
        if args.artifact or args.diff:
            raise ValueError(
                "--role source-extraction forbids --artifact and --diff so the candidate "
                "answer is withheld by packet construction"
            )
        if args.context:
            raise ValueError(
                "--role source-extraction forbids --context because it could leak a candidate "
                "answer, prior verdict, or proposed correction; put only neutral questions in "
                "--extraction-request"
            )
    elif args.extraction_request:
        raise ValueError(
            "--extraction-request is only valid with --role source-extraction"
        )
    if args.correction_status == "checked-corrections-included" and not correction_sources:
        raise ValueError(
            "--correction-status checked-corrections-included requires at least one "
            "--correction-source containing the exact correction text"
        )
    if args.correction_status != "checked-corrections-included" and correction_sources:
        raise ValueError(
            "--correction-source is only valid with "
            "--correction-status checked-corrections-included"
        )
    if args.correction_status in (
        "checked-none-found",
        "checked-corrections-included",
    ) and not correction_search_evidence:
        raise ValueError(
            f"--correction-status {args.correction_status} requires at least one "
            "--correction-search-evidence file recording the searched indexes, identifiers, "
            "and result; a bare status assertion is not auditable"
        )
    if args.correction_status == "not-applicable" and correction_search_evidence:
        raise ValueError(
            "--correction-search-evidence is not valid with --correction-status "
            "not-applicable"
        )

    source_path_list = [Path(raw).expanduser().resolve() for raw in sources]
    source_paths = set(source_path_list)
    if len(source_paths) != len(source_path_list):
        raise ValueError("duplicate --source paths are not allowed")
    correction_path_list = [Path(raw).expanduser().resolve() for raw in correction_sources]
    correction_paths = set(correction_path_list)
    if len(correction_paths) != len(correction_path_list):
        raise ValueError("duplicate --correction-source paths are not allowed")
    correction_evidence_path_list = [
        Path(raw).expanduser().resolve() for raw in correction_search_evidence
    ]
    correction_evidence_paths = set(correction_evidence_path_list)
    if len(correction_evidence_paths) != len(correction_evidence_path_list):
        raise ValueError("duplicate --correction-search-evidence paths are not allowed")
    provenance_path_list = [
        Path(raw).expanduser().resolve() for raw in source_provenance_evidence
    ]
    provenance_paths = set(provenance_path_list)
    if len(provenance_paths) != len(provenance_path_list):
        raise ValueError("duplicate --source-provenance-evidence paths are not allowed")
    source_correction_overlap = source_paths & correction_paths
    if source_correction_overlap:
        joined = ", ".join(str(path) for path in sorted(source_correction_overlap))
        raise ValueError(
            "primary and correction sources must be distinct files; overlapping path(s): " + joined
        )
    source_evidence_overlap = (
        source_paths | correction_paths
    ) & (correction_evidence_paths | provenance_paths)
    if source_evidence_overlap:
        joined = ", ".join(str(path) for path in sorted(source_evidence_overlap))
        raise ValueError(
            "primary sources, correction sources, and provenance/search evidence must be "
            "distinct files; overlapping path(s): " + joined
        )
    evidence_overlap = correction_evidence_paths & provenance_paths
    if evidence_overlap:
        joined = ", ".join(str(path) for path in sorted(evidence_overlap))
        raise ValueError(
            "source-provenance evidence and correction-search evidence must be distinct "
            "files; overlapping path(s): " + joined
        )
    all_source_inputs = (
        source_paths | correction_paths | correction_evidence_paths | provenance_paths
    )
    overlap = all_source_inputs & artifact_paths
    if overlap:
        joined = ", ".join(str(path) for path in sorted(overlap))
        raise ValueError(
            "the review target and source inputs must be distinct files; overlapping path(s): " + joined
        )
    for context_path in context_path_list:
        if context_path in all_source_inputs:
            raise ValueError(
                "source inputs and additional context must be distinct files; overlapping path: "
                + str(context_path)
            )
    if args.extraction_request:
        request_path = Path(args.extraction_request).expanduser().resolve()
        if request_path in all_source_inputs:
            raise ValueError(
                "the neutral extraction request and source/evidence inputs must be distinct "
                "files; overlapping path: " + str(request_path)
            )


def _run_git_diff(diff_range: str) -> str:
    if diff_range.startswith("-"):
        # Injection guard: the value is passed as an argument to `git diff`, so a
        # leading "-" would be read as a git option (e.g. --output=..., --ext-diff),
        # not a revision range. Git refs themselves can never start with "-".
        raise ValueError(
            f"--diff value {diff_range!r} starts with '-' and would be interpreted as a "
            "git option, not a revision range (git refs cannot start with '-'); "
            "pass a BASE..HEAD revision range"
        )
    proc = subprocess.run(["git", "diff", diff_range], check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ValueError(f"`git diff {diff_range}` failed: {proc.stderr.strip()}")
    if not proc.stdout.strip():
        raise ValueError(f"`git diff {diff_range}` produced no output — nothing to review")
    return proc.stdout


def _assemble_packet(
    args: argparse.Namespace,
    *,
    artifacts: list[tuple[Path, str, str, int]],
    primary_sources: list[tuple[Path, str, str, int]],
    correction_sources: list[tuple[Path, str, str, int]],
    correction_search_evidence: list[tuple[Path, str, str, int]],
    source_provenance_evidence: list[tuple[Path, str, str, int]],
    extraction_request: Optional[tuple[Path, str, str, int]],
    diff_text: Optional[str],
    contexts: list[tuple[Path, str, str, int]],
) -> str:
    parts = [ADVISORY_BANNER, "", _PACKET_FRAMING]
    if args.role == _SOURCE_EXTRACTION_ROLE:
        parts.append(
            "=== SOURCE-EXTRACTION SCOPE ===\n\n"
            "No candidate artifact, prior verdict, proposed correction, or comparison target is "
            "included in this packet. Extract only what the primary and correction sources state "
            "in response to the neutral request below. The request text is not machine-classified; "
            "if it supplies an expected answer instead of a neutral question, report that as a "
            "blocking loss of input independence.\n"
            f"SOURCE_TEXT_ORIGIN: {args.source_text_origin}\n"
            f"CORRECTION_STATUS: {args.correction_status}\n\n"
            "=== END SOURCE-EXTRACTION SCOPE ===\n"
        )
    elif args.role == _SOURCE_FIDELITY_ROLE:
        parts.append(
            "=== SOURCE-FIDELITY SCOPE ===\n\n"
            "The PRIMARY SOURCE and review target are distinct inputs. Compare them literally "
            "before interpreting or normalizing notation. The review target is visible in this pass, so this "
            "run is a comparison pass, not a candidate-withheld independent extraction.\n"
            f"SOURCE_TEXT_ORIGIN: {args.source_text_origin}\n"
            f"CORRECTION_STATUS: {args.correction_status}\n\n"
            "=== END SOURCE-FIDELITY SCOPE ===\n"
        )
    if args.role in _SOURCE_ROLES:
        for path, evidence_text, digest, size in source_provenance_evidence:
            parts.append(
                f"=== SOURCE PROVENANCE EVIDENCE: {path} ===\n"
                f"EVIDENCE_FILE_SHA256: {digest}\n"
                f"EVIDENCE_FILE_BYTES: {size}\n"
                f"EMBEDDED_TEXT_SHA256: {_embedded_text_sha256(evidence_text)}\n"
                "PACKET_DELIMITER_NEWLINE_ADDED: "
                f"{str(_packet_delimiter_newline_added(evidence_text)).lower()}\n\n"
                f"{_verbatim_packet_text(evidence_text)}"
                "=== END SOURCE PROVENANCE EVIDENCE ===\n"
            )
        for path, source_text, digest, size in primary_sources:
            parts.append(
                f"=== PRIMARY SOURCE: {path} ===\n"
                f"SOURCE_FILE_SHA256: {digest}\n"
                f"SOURCE_FILE_BYTES: {size}\n"
                f"EMBEDDED_TEXT_SHA256: {_embedded_text_sha256(source_text)}\n"
                "PACKET_DELIMITER_NEWLINE_ADDED: "
                f"{str(_packet_delimiter_newline_added(source_text)).lower()}\n\n"
                f"{_verbatim_packet_text(source_text)}"
                "=== END PRIMARY SOURCE ===\n"
            )
        for path, correction_text, digest, size in correction_sources:
            parts.append(
                f"=== CORRECTION SOURCE: {path} ===\n"
                f"SOURCE_FILE_SHA256: {digest}\n"
                f"SOURCE_FILE_BYTES: {size}\n"
                f"EMBEDDED_TEXT_SHA256: {_embedded_text_sha256(correction_text)}\n"
                "PACKET_DELIMITER_NEWLINE_ADDED: "
                f"{str(_packet_delimiter_newline_added(correction_text)).lower()}\n\n"
                f"{_verbatim_packet_text(correction_text)}"
                "=== END CORRECTION SOURCE ===\n"
            )
        for path, evidence_text, digest, size in correction_search_evidence:
            parts.append(
                f"=== CORRECTION SEARCH EVIDENCE: {path} ===\n"
                f"EVIDENCE_FILE_SHA256: {digest}\n"
                f"EVIDENCE_FILE_BYTES: {size}\n"
                f"EMBEDDED_TEXT_SHA256: {_embedded_text_sha256(evidence_text)}\n"
                "PACKET_DELIMITER_NEWLINE_ADDED: "
                f"{str(_packet_delimiter_newline_added(evidence_text)).lower()}\n\n"
                f"{_verbatim_packet_text(evidence_text)}"
                "=== END CORRECTION SEARCH EVIDENCE ===\n"
            )
        if extraction_request is not None:
            path, request_text, digest, size = extraction_request
            parts.append(
                f"=== NEUTRAL EXTRACTION REQUEST: {path} ===\n"
                f"REQUEST_FILE_SHA256: {digest}\n"
                f"REQUEST_FILE_BYTES: {size}\n"
                f"EMBEDDED_TEXT_SHA256: {_embedded_text_sha256(request_text)}\n"
                "PACKET_DELIMITER_NEWLINE_ADDED: "
                f"{str(_packet_delimiter_newline_added(request_text)).lower()}\n\n"
                f"{_verbatim_packet_text(request_text)}"
                "=== END NEUTRAL EXTRACTION REQUEST ===\n"
            )
    for path, artifact_text, _digest, _size in artifacts:
        heading = "ARTIFACT UNDER REVIEW" if args.role == _SOURCE_FIDELITY_ROLE else "ARTIFACT"
        parts.append(
            f"=== {heading}: {path} ===\n\n"
            f"{_verbatim_packet_text(artifact_text)}"
            f"=== END {heading} ===\n"
        )
    if args.diff:
        if diff_text is None:
            raise ValueError("internal error: diff target was not loaded")
        parts.append(
            f"=== DIFF ({args.diff}) — output of `git diff {args.diff}` ===\n\n"
            f"{_verbatim_packet_text(diff_text)}"
            "=== END DIFF ===\n"
        )
    for path, context_text, digest, size in contexts:
        parts.append(
            f"=== ADDITIONAL CONTEXT: {path} ===\n"
            f"CONTEXT_FILE_SHA256: {digest}\n"
            f"CONTEXT_FILE_BYTES: {size}\n"
            f"EMBEDDED_TEXT_SHA256: {_embedded_text_sha256(context_text)}\n"
            "PACKET_DELIMITER_NEWLINE_ADDED: "
            f"{str(_packet_delimiter_newline_added(context_text)).lower()}\n\n"
            f"{_verbatim_packet_text(context_text)}"
            "=== END CONTEXT ===\n"
        )
    return "\n".join(parts)


def _source_review_manifest(
    args: argparse.Namespace,
    *,
    artifacts: list[tuple[Path, str, str, int]],
    primary_sources: list[tuple[Path, str, str, int]],
    correction_sources: list[tuple[Path, str, str, int]],
    correction_search_evidence: list[tuple[Path, str, str, int]],
    source_provenance_evidence: list[tuple[Path, str, str, int]],
    extraction_request: Optional[tuple[Path, str, str, int]],
    diff_text: Optional[str],
    contexts: list[tuple[Path, str, str, int]],
) -> dict:
    sources = [
        {
            "path": str(path),
            "sha256": digest,
            "bytes": size,
            "embedded_text_sha256": _embedded_text_sha256(text),
            "packet_delimiter_newline_added": _packet_delimiter_newline_added(text),
        }
        for path, text, digest, size in primary_sources
    ]
    corrections = [
        {
            "path": str(path),
            "sha256": digest,
            "bytes": size,
            "embedded_text_sha256": _embedded_text_sha256(text),
            "packet_delimiter_newline_added": _packet_delimiter_newline_added(text),
        }
        for path, text, digest, size in correction_sources
    ]
    correction_evidence = [
        {
            "path": str(path),
            "sha256": digest,
            "bytes": size,
            "embedded_text_sha256": _embedded_text_sha256(text),
            "packet_delimiter_newline_added": _packet_delimiter_newline_added(text),
            "content_classification": "search_record_content_not_machine_verified",
        }
        for path, text, digest, size in correction_search_evidence
    ]
    provenance_evidence = [
        {
            "path": str(path),
            "sha256": digest,
            "bytes": size,
            "embedded_text_sha256": _embedded_text_sha256(text),
            "packet_delimiter_newline_added": _packet_delimiter_newline_added(text),
            "content_classification": "provenance_record_content_not_machine_verified",
        }
        for path, text, digest, size in source_provenance_evidence
    ]
    target_artifacts = [
        {
            "path": str(path),
            "sha256": digest,
            "bytes": size,
            "embedded_text_sha256": _embedded_text_sha256(text),
            "packet_delimiter_newline_added": _packet_delimiter_newline_added(text),
        }
        for path, text, digest, size in artifacts
    ]
    diff_bytes = diff_text.encode("utf-8") if diff_text is not None else None
    context_entries = [
        {
            "path": str(path),
            "sha256": digest,
            "bytes": size,
            "embedded_text_sha256": _embedded_text_sha256(text),
            "packet_delimiter_newline_added": _packet_delimiter_newline_added(text),
        }
        for path, text, digest, size in contexts
    ]
    # Preserve the historical singular field only when it is unambiguous. New
    # consumers should read additional_contexts.
    context_entry = context_entries[0] if len(context_entries) == 1 else None
    request_entry = None
    if extraction_request is not None:
        path, text, digest, size = extraction_request
        request_entry = {
            "path": str(path),
            "sha256": digest,
            "bytes": size,
            "embedded_text_sha256": _embedded_text_sha256(text),
            "packet_delimiter_newline_added": _packet_delimiter_newline_added(text),
            "content_classification": "neutrality_not_machine_verified",
        }
    is_extraction = args.role == _SOURCE_EXTRACTION_ROLE
    return {
        "schema_version": 2,
        "role": args.role,
        "gate_input_valid": True,
        "primary_sources": sources,
        "source_text_origin": args.source_text_origin,
        "source_provenance_evidence": provenance_evidence,
        "source_page_fidelity": (
            "claimed_by_provenance_evidence_not_machine_verified"
            if args.source_text_origin == "visually-verified-transcription"
            else "direct_original_text_claim_not_machine_verified"
        ),
        "correction_status": args.correction_status,
        "correction_sources": corrections,
        "correction_search_evidence": correction_evidence,
        "target_kind": (
            "neutral_extraction_request"
            if is_extraction
            else ("diff" if args.diff else "artifact")
        ),
        "target_paths": [entry["path"] for entry in target_artifacts],
        "target_artifacts": target_artifacts,
        "target_diff_range": args.diff,
        "target_diff_sha256": hashlib.sha256(diff_bytes).hexdigest() if diff_bytes is not None else None,
        "target_diff_embedded_text_sha256": (
            _embedded_text_sha256(diff_text) if diff_text is not None else None
        ),
        "target_diff_bytes": len(diff_bytes) if diff_bytes is not None else None,
        "target_diff_packet_delimiter_newline_added": (
            _packet_delimiter_newline_added(diff_text) if diff_text is not None else None
        ),
        "additional_context": context_entry,
        "additional_contexts": context_entries,
        "additional_context_count": len(context_entries),
        "additional_context_content_classification": "not_machine_verified",
        "neutral_extraction_request": request_entry,
        "candidate_visibility": (
            "withheld_by_packet_structure" if is_extraction else "visible_in_same_packet"
        ),
        "candidate_withheld_packet_constructed_by_this_run": is_extraction,
        "candidate_withheld_extraction_performed_by_this_run": False,
        "candidate_withheld_extraction_outcome": "not_machine_verified",
        "extraction_request_neutrality": (
            "not_machine_verified" if is_extraction else "not_applicable"
        ),
        "source_dependency_closure": "not_machine_verified",
        "literal_comparison_outcome": "not_machine_verified",
    }


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True,
                    help="Exactly one model spec — required, no default (e.g. codex/default, "
                         "gemini/default, kimi/default, claude/<model>, or an OpenCode provider/model).")
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument("--artifact", action="append", default=None, metavar="PATH",
                        help="File to embed as the review target. Repeatable.")
    source.add_argument("--diff", default=None, metavar="BASE..HEAD",
                        help="Embed the output of `git diff BASE..HEAD` as the review target.")
    source.add_argument("--extraction-request", default=None, metavar="PATH",
                        help="Neutral locator/question list for --role source-extraction; this "
                             "mode forbids candidate artifacts, diffs, and additional context.")
    ap.add_argument("--role", choices=_ROLES, default="generic",
                    help="Reviewer role; the system prompt is templates/<role>.md (default: generic).")
    ap.add_argument("--source", action="append", default=None, metavar="PATH",
                    help="Exact UTF-8 primary-source text for source-extraction/source-fidelity. "
                         "Repeatable; required for those roles and rejected for other roles.")
    ap.add_argument("--source-text-origin", choices=_SOURCE_TEXT_ORIGINS, default=None,
                    help="Required for source roles: declare whether --source is direct original "
                         "machine-readable text or a visually verified transcription of a PDF/scan.")
    ap.add_argument("--source-provenance-evidence", action="append", default=None,
                    metavar="PATH",
                    help="Exact UTF-8 provenance/visual-comparison record. Repeatable and required "
                         "for --source-text-origin visually-verified-transcription.")
    ap.add_argument("--correction-status", choices=_CORRECTION_STATUSES, default=None,
                    help="Required for source-extraction/source-fidelity: explicit correction-chain status.")
    ap.add_argument("--correction-source", action="append", default=None, metavar="PATH",
                    help="Exact UTF-8 correction text. Repeatable and required when correction status "
                         "is checked-corrections-included.")
    ap.add_argument("--correction-search-evidence", action="append", default=None, metavar="PATH",
                    help="Exact UTF-8 record of correction-chain searches. Repeatable and required "
                         "for checked-none-found or checked-corrections-included.")
    ap.add_argument("--context", action="append", default=[], metavar="PATH",
                    help="Optional context file appended to the packet. Repeatable; all files are "
                         "embedded in command-line order.")
    ap.add_argument("--out-dir", type=Path, default=None,
                    help="Output directory (default: ./review-one-<UTC timestamp>/).")
    ap.add_argument("--host-family", default=None, metavar="FAMILY",
                    help="Your own (host) model family, e.g. claude. When --model resolves to it, "
                         "the run is refused: review your own family in-host, not via its CLI.")
    ap.add_argument("--use-project-config", action="store_true",
                    help="Allow .nullius/review-swarm.json auto-discovery in the launcher: "
                         "REVIEW_SWARM_NO_AUTO_CONFIG is removed for the delegated run even "
                         "when the caller's environment already sets it (prior value restored "
                         "afterward). Default: disabled via REVIEW_SWARM_NO_AUTO_CONFIG=1 for "
                         "hermetic runs.")
    ap.add_argument("--timeout-secs", type=int, default=None,
                    help="Per-backend timeout override, forwarded to the launcher.")
    ap.add_argument("--backend-tool-mode", action="append", default=[], metavar="BACKEND=MODE",
                    help="Forwarded to the launcher (e.g. claude=review, gemini=review). Repeatable.")
    guard = ap.add_mutually_exclusive_group()
    guard.add_argument("--max-prompt-bytes", type=int, default=None,
                       help="Refuse when an assembled input exceeds this many bytes.")
    guard.add_argument("--max-prompt-chars", type=int, default=None,
                       help="Refuse when an assembled input exceeds this many characters.")
    for backend in _RUNNER_BACKENDS:
        ap.add_argument(f"--{backend}-runner", type=Path, default=None,
                        help=f"Optional override path to the {backend} runner script (forwarded).")
    return ap.parse_args(argv)


def _validate_model(args: argparse.Namespace) -> None:
    model = str(args.model or "").strip()
    if not model or "," in model:
        raise ValueError("--model takes exactly one model spec (no commas, no default)")
    backend, _ = run_multi_task._classify_model(model)
    if str(args.host_family or "").strip().lower() == backend:
        raise ValueError(
            f"--model {model} resolves to backend '{backend}', which is your own (host) family. "
            "Review your own family in-host — a native child-agent/sub-agent primitive if your "
            "host has one, else inline — never through its own CLI; for an independent reviewer "
            "here, pick a --model from a different family (see SKILL.md, 'Host-aware execution')."
        )


def _delegate(args: argparse.Namespace, *, out_dir: Path, system_path: Path, packet_path: Path) -> int:
    argv = ["run_multi_task.py", "--out-dir", str(out_dir), "--system", str(system_path),
            "--prompt", str(packet_path), "--models", str(args.model).strip(), "--check-review-contract",
            # The launcher default is 0 (strictly additive for its other
            # path-pinned consumers); this entry opts in to one orchestrator-level
            # rerun when the runner exits 0 but writes an empty output file.
            "--retry-empty-output", "1"]
    if args.timeout_secs is not None:
        argv += ["--timeout-secs", str(args.timeout_secs)]
    for entry in args.backend_tool_mode:
        argv += ["--backend-tool-mode", str(entry)]
    for backend in _RUNNER_BACKENDS:
        override = getattr(args, f"{backend}_runner")
        if override is not None:
            argv += [f"--{backend}-runner", str(override)]

    prior_argv, prior_env = sys.argv, os.environ.get("REVIEW_SWARM_NO_AUTO_CONFIG")
    if args.use_project_config:
        # Opt-in must also win over an inherited REVIEW_SWARM_NO_AUTO_CONFIG=1
        # from the caller's environment: remove it for the delegated invocation.
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)
    else:
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"
    try:
        sys.argv = argv
        return int(run_multi_task.main())
    finally:
        sys.argv = prior_argv
        if prior_env is None:
            os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)
        else:
            os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = prior_env


def _print_summary(*, out_dir: Path, packet_path: Path) -> None:
    meta_path = out_dir / "meta.json"
    agent: dict = {}
    with contextlib.suppress(Exception):
        agents = json.loads(meta_path.read_text(encoding="utf-8")).get("agents") or []
        if agents and isinstance(agents[0], dict):
            agent = agents[0]
    print(f"note: {ADVISORY_BANNER}")
    print(f"verdict: {agent.get('verdict') or 'NONE'}")
    print(f"contract_ok: {json.dumps(agent.get('contract_ok'))}")
    print(f"output: {agent.get('out') or ''}")
    print(f"packet: {packet_path}")
    print(f"meta: {meta_path}")
    print(f"trace: {out_dir / 'trace.jsonl'}")


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    try:
        _validate_model(args)
        _validate_source_review_inputs(args)
        template_path = _TEMPLATES_DIR / f"{args.role}.md"
        if not template_path.is_file():
            raise ValueError(f"role template not found: {template_path}")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out_dir = (args.out_dir or Path(f"review-one-{stamp}")).expanduser().resolve()
        inputs_dir = out_dir / "inputs"
        system_path, packet_path = inputs_dir / "system.md", inputs_dir / "packet.md"

        artifacts = [_read_review_artifact(raw) for raw in (args.artifact or [])]
        primary_sources = [_read_primary_source(raw) for raw in (args.source or [])]
        correction_sources = [
            _read_primary_source(raw, flag="--correction-source")
            for raw in (args.correction_source or [])
        ]
        correction_search_evidence = [
            _read_primary_source(raw, flag="--correction-search-evidence")
            for raw in (args.correction_search_evidence or [])
        ]
        source_provenance_evidence = [
            _read_primary_source(raw, flag="--source-provenance-evidence")
            for raw in (args.source_provenance_evidence or [])
        ]
        extraction_request = (
            _read_primary_source(args.extraction_request, flag="--extraction-request")
            if args.extraction_request
            else None
        )
        diff_text = _run_git_diff(args.diff) if args.diff else None
        contexts = [
            _read_text_payload(raw, label="--context") for raw in (args.context or [])
        ]
        packet_text = _assemble_packet(
            args,
            artifacts=artifacts,
            primary_sources=primary_sources,
            correction_sources=correction_sources,
            correction_search_evidence=correction_search_evidence,
            source_provenance_evidence=source_provenance_evidence,
            extraction_request=extraction_request,
            diff_text=diff_text,
            contexts=contexts,
        )
        run_multi_task._atomic_write_text(system_path, template_path.read_text(encoding="utf-8"))
        run_multi_task._atomic_write_text(packet_path, packet_text)
        if args.role in _SOURCE_ROLES:
            manifest_name = (
                "source_extraction_manifest.json"
                if args.role == _SOURCE_EXTRACTION_ROLE
                else "source_fidelity_manifest.json"
            )
            run_multi_task._atomic_write_text(
                inputs_dir / manifest_name,
                json.dumps(
                    _source_review_manifest(
                        args,
                        artifacts=artifacts,
                        primary_sources=primary_sources,
                        correction_sources=correction_sources,
                        correction_search_evidence=correction_search_evidence,
                        source_provenance_evidence=source_provenance_evidence,
                        extraction_request=extraction_request,
                        diff_text=diff_text,
                        contexts=contexts,
                    ),
                    indent=2,
                    sort_keys=True,
                ) + "\n",
            )
        if args.max_prompt_bytes is not None or args.max_prompt_chars is not None:
            for label, path in (("system", system_path), ("prompt", packet_path)):
                # Existing launcher guard semantics; overflow="fail" refuses an
                # oversize input with the guard's own message (no truncation).
                run_multi_task._apply_prompt_limit(
                    path, label=label, out_dir=inputs_dir, trace_path=out_dir / "trace.jsonl",
                    max_bytes=args.max_prompt_bytes, max_chars=args.max_prompt_chars, overflow="fail",
                )
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    rc = _delegate(args, out_dir=out_dir, system_path=system_path, packet_path=packet_path)
    _print_summary(out_dir=out_dir, packet_path=packet_path)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
