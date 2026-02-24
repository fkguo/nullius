#!/usr/bin/env python3
"""
research_writer_consume_paper_manifest.py

Deterministic v1 "publisher" for an MCP-exported `paper/` scaffold.

Principles:
- Deterministic: no network, no LLM calls.
- Does not generate new physics content; only validate/hygiene/compile/audit.

Entry point:
- `paper/paper_manifest.json` is the only entrypoint (can be overridden via
  `--paper-manifest`).

What it does:
1) Validate (fail-fast):
   - schemaVersion
   - existence of main.tex / sections / bib / figures paths
   - no `hep://` appears in any `.tex` under the paper root
   - no citekey conflicts between `references_generated.bib` and `references_manual.bib`
2) Bib layering (deterministic hygiene):
   - create an empty `references_manual.bib` if missing
   - ensure `main.tex` references BOTH generated+manual bib databases
3) Optional compile:
   - if `latexmk` exists and `--compile` set: `latexmk -pdf main.tex`
   - else: record a deterministic SKIPPED result (not a failure)
4) Audit:
   - append to `paper/build_trace.jsonl` with checksums and step results
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")

def _write_json(path: Path, obj: Any) -> None:
    _write_text(path, json.dumps(obj, indent=2, sort_keys=True) + "\n")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_json_summary(obj: Any) -> dict[str, Any]:
    """
    Best-effort summary for a run-card-like JSON value.

    The caller is responsible for preserving the full raw run-card elsewhere.
    """
    if not isinstance(obj, dict):
        return {"type": type(obj).__name__}

    approval = obj.get("approval") if isinstance(obj.get("approval"), dict) else {}
    return {
        "run_id": obj.get("run_id") or obj.get("runId") or obj.get("id"),
        "workflow_id": obj.get("workflow_id") or obj.get("workflowId"),
        "backend": obj.get("backend"),
        "approval_trace_id": (
            obj.get("approval_trace_id")
            or obj.get("approvalTraceId")
            or approval.get("trace_id")
            or approval.get("traceId")
            or approval.get("id")
        ),
    }


def _stage_run_card(run_card_path: Path, *, paper_root: Path) -> dict[str, Any]:
    raw = run_card_path.read_bytes()
    digest = _sha256_bytes(raw)

    dest = paper_root / "run_card.json"
    if dest.exists():
        try:
            if dest.read_bytes() != raw:
                dest = paper_root / f"run_card.{digest[:12]}.json"
        except Exception:
            dest = paper_root / f"run_card.{digest[:12]}.json"
    if not dest.exists():
        dest.write_bytes(raw)

    parsed: Any = None
    parse_error: str | None = None
    try:
        parsed = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as exc:
        parse_error = str(exc)

    return {
        "input_path": str(run_card_path),
        "path": _relpath_str(dest, paper_root),
        "sha256": digest,
        "parse_error": parse_error,
        "summary": _safe_json_summary(parsed),
    }


def _relpath_str(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except Exception:
        return str(path)


def _reject_dotdot(rel: str) -> None:
    p = Path(rel)
    if any(part == ".." for part in p.parts):
        raise ValueError(f"refuses path with '..': {rel}")


def _resolve_from_paper_root(paper_root: Path, rel: str) -> Path:
    rel = str(rel).strip()
    if not rel:
        raise ValueError("empty path")
    if os.path.isabs(rel):
        return Path(rel)
    _reject_dotdot(rel)
    return paper_root / rel


def _load_json(path: Path) -> dict[str, Any]:
    try:
        obj = json.loads(_read_text(path))
    except Exception as exc:
        raise ValueError(f"failed to parse JSON: {path} ({exc})") from exc
    if not isinstance(obj, dict):
        raise ValueError(f"manifest JSON must be an object: {path}")
    return obj


def _first_present(d: dict[str, Any], keys: list[str]) -> Any:
    for k in keys:
        if k in d:
            return d[k]
    return None


@dataclass(frozen=True)
class PaperManifestV1:
    manifest_path: Path
    paper_root: Path
    schema_version: int
    main_tex: Path
    sections_dir: Path | None
    section_files: list[Path]
    figures_dir: Path
    bib_generated: Path
    bib_manual: Path
    bib_generated_db: str
    bib_manual_db: str


def _bib_dbname(path_rel: str) -> str:
    # BibTeX database name: path without ".bib", always use forward slashes.
    p = Path(path_rel)
    if p.suffix.lower() == ".bib":
        p = p.with_suffix("")
    return p.as_posix()


def _parse_manifest_v1(path: Path) -> PaperManifestV1:
    paper_root = path.parent
    obj = _load_json(path)

    schema = obj.get("schemaVersion")
    if not isinstance(schema, int):
        raise ValueError("manifest.schemaVersion must be an integer")
    if schema != 1:
        raise ValueError(f"unsupported schemaVersion={schema} (supported: 1)")

    main_tex_rel = _first_present(obj, ["mainTex", "main_tex", "main"]) or "main.tex"
    if not isinstance(main_tex_rel, str):
        raise ValueError("manifest.mainTex must be a string")

    sections_rel: str | None = None
    section_files_rel: list[str] = []
    sections_field = _first_present(obj, ["sections", "sectionsDir", "sections_dir"])
    if isinstance(sections_field, str):
        sections_rel = sections_field
    elif isinstance(sections_field, list):
        section_files_rel = [str(x) for x in sections_field]
    elif isinstance(sections_field, dict):
        ddir = _first_present(sections_field, ["dir", "path"])
        if isinstance(ddir, str):
            sections_rel = ddir
        files = sections_field.get("files")
        if isinstance(files, list):
            section_files_rel = [str(x) for x in files]

    figures_rel = _first_present(obj, ["figuresDir", "figures_dir", "figures"]) or "figures"
    if isinstance(figures_rel, dict):
        figures_rel = _first_present(figures_rel, ["dir", "path"])
    if not isinstance(figures_rel, str):
        raise ValueError("manifest.figuresDir must be a string (or {dir: ...})")

    bib_field = _first_present(obj, ["bib", "bibliography"])
    if not isinstance(bib_field, dict):
        raise ValueError("manifest.bib must be an object")
    gen_rel = _first_present(bib_field, ["generated", "references_generated", "generatedBib"])
    man_rel = _first_present(bib_field, ["manual", "references_manual", "manualBib"])
    if not isinstance(gen_rel, str) or not gen_rel.strip():
        raise ValueError("manifest.bib.generated must be a non-empty string")
    if man_rel is None:
        man_rel = "references_manual.bib"
    if not isinstance(man_rel, str) or not man_rel.strip():
        raise ValueError("manifest.bib.manual must be a string (or omit to use default references_manual.bib)")

    main_tex = _resolve_from_paper_root(paper_root, main_tex_rel)
    sections_dir = _resolve_from_paper_root(paper_root, sections_rel) if sections_rel else None
    figures_dir = _resolve_from_paper_root(paper_root, figures_rel)
    bib_generated = _resolve_from_paper_root(paper_root, gen_rel)
    bib_manual = _resolve_from_paper_root(paper_root, man_rel)

    section_files: list[Path] = []
    for rel in section_files_rel:
        section_files.append(_resolve_from_paper_root(paper_root, rel))

    return PaperManifestV1(
        manifest_path=path,
        paper_root=paper_root,
        schema_version=schema,
        main_tex=main_tex,
        sections_dir=sections_dir,
        section_files=section_files,
        figures_dir=figures_dir,
        bib_generated=bib_generated,
        bib_manual=bib_manual,
        bib_generated_db=_bib_dbname(gen_rel),
        bib_manual_db=_bib_dbname(man_rel),
    )


def _iter_tex_files(paper_root: Path) -> Iterable[Path]:
    for p in sorted(paper_root.rglob("*.tex")):
        if p.is_file():
            yield p


def _scan_for_hep_uri(path: Path) -> list[int]:
    text = _read_text(path)
    lines: list[int] = []
    for i, ln in enumerate(text.splitlines(), start=1):
        if "hep://" in ln:
            lines.append(i)
            if len(lines) >= 30:
                break
    return lines


_RE_BIBKEY = re.compile(r"^\s*@\w+\s*\{\s*([^,\s]+)\s*,", flags=re.M)


def _read_bib_keys(path: Path) -> list[str]:
    if not path.is_file():
        return []
    keys = _RE_BIBKEY.findall(_read_text(path))
    seen: set[str] = set()
    out: list[str] = []
    for k in keys:
        if k in seen:
            continue
        seen.add(k)
        out.append(k)
    return out


_RE_BIBCMD = re.compile(r"\\bibliography\s*\{([^}]*)\}", flags=re.S)


def _ensure_main_bibliography(main_tex_path: Path, *, gen_db: str, man_db: str) -> dict[str, Any]:
    """
    Ensure main.tex has a single \\bibliography{...} that references both dbs.

    Returns a small dict describing what happened.
    """
    before = _read_text(main_tex_path)
    matches = list(_RE_BIBCMD.finditer(before))
    if not matches:
        raise ValueError(
            f"main.tex has no \\\\bibliography{{...}}; add one referencing '{gen_db},{man_db}' before \\end{{document}}"
        )
    if len(matches) != 1:
        raise ValueError("main.tex has multiple \\\\bibliography{...} commands; refuse to auto-patch")
    m = matches[0]
    raw = m.group(1)
    items: list[str] = []
    for part in raw.split(","):
        t = part.strip()
        if not t:
            continue
        if t.lower().endswith(".bib"):
            t = t[: -len(".bib")]
        items.append(t)

    # Ensure required DBs are included.
    had_gen = gen_db in items
    had_man = man_db in items
    if not had_gen:
        items.insert(0, gen_db)
    if not had_man:
        # Keep manual last so it never "accidentally" masks generated entries.
        items.append(man_db)

    new_cmd = f"\\bibliography{{{','.join(items)}}}"
    after = before[: m.start()] + new_cmd + before[m.end() :]
    changed = after != before
    return {
        "changed": changed,
        "before_text": before,
        "after_text": after,
        "old": raw.strip(),
        "new": ",".join(items),
        "had_generated": had_gen,
        "had_manual": had_man,
    }


def _maybe_write_backup(original_path: Path) -> tuple[bool, Path]:
    """
    Create a deterministic backup next to the file, if not already present.
    Returns (created, backup_path).
    """
    backup = original_path.with_suffix(original_path.suffix + ".bak")
    if backup.exists():
        return False, backup
    _write_text(backup, _read_text(original_path))
    return True, backup


def _have_latexmk() -> bool:
    return shutil.which("latexmk") is not None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--paper-manifest",
        type=Path,
        default=None,
        help="Path to paper_manifest.json (default: ./paper/paper_manifest.json, then ./paper_manifest.json).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and report what would change, but do not write any files and do not compile.",
    )
    ap.add_argument("--compile", action="store_true", help="If latexmk exists, compile via `latexmk -pdf main.tex`.")
    ap.add_argument("--run-card", type=Path, default=None, help="Optional run-card JSON to copy into paper/ for traceability.")
    args = ap.parse_args()

    manifest_path: Path | None = args.paper_manifest
    if manifest_path is None:
        cand1 = Path("paper") / "paper_manifest.json"
        cand2 = Path("paper_manifest.json")
        if cand1.is_file():
            manifest_path = cand1
        elif cand2.is_file():
            manifest_path = cand2
        else:
            print("ERROR: --paper-manifest not provided and no default manifest found (paper/paper_manifest.json)", file=sys.stderr)
            return 2

    manifest_path = manifest_path.expanduser()
    if not manifest_path.is_file():
        print(f"ERROR: paper manifest not found: {manifest_path}", file=sys.stderr)
        return 2

    try:
        manifest = _parse_manifest_v1(manifest_path)
    except Exception as exc:
        print(f"ERROR: invalid paper manifest: {exc}", file=sys.stderr)
        return 2

    paper_root = manifest.paper_root
    trace_path = paper_root / "build_trace.jsonl"
    _append_jsonl(
        trace_path,
        {
            "event": "run_start",
            "ts": _utc_now(),
            "paper_root": str(paper_root),
            "manifest": str(manifest.manifest_path),
            "schemaVersion": manifest.schema_version,
            "dry_run": bool(args.dry_run),
            "compile_requested": bool(args.compile),
        },
    )

    run_card_info: dict[str, Any] | None = None
    if args.run_card is not None:
        run_card_path = args.run_card.expanduser().resolve()
        if not run_card_path.is_file():
            _append_jsonl(
                trace_path,
                {
                    "event": "run_card_error",
                    "ts": _utc_now(),
                    "message": "run-card not found",
                    "path": str(run_card_path),
                },
            )
            print(f"ERROR: --run-card not found: {run_card_path}", file=sys.stderr)
            return 2
        try:
            if args.dry_run:
                raw = run_card_path.read_bytes()
                digest = _sha256_bytes(raw)
                parsed: Any = None
                parse_error: str | None = None
                try:
                    parsed = json.loads(raw.decode("utf-8", errors="replace"))
                except Exception as exc:
                    parse_error = str(exc)
                run_card_info = {
                    "input_path": str(run_card_path),
                    "path": None,
                    "sha256": digest,
                    "parse_error": parse_error,
                    "summary": _safe_json_summary(parsed),
                    "dry_run": True,
                }
            else:
                run_card_info = _stage_run_card(run_card_path, paper_root=paper_root)
        except Exception as exc:
            run_card_info = {"input_path": str(run_card_path), "error": str(exc)}
        _append_jsonl(trace_path, {"event": "run_card_loaded", "ts": _utc_now(), "run_card": run_card_info})

    def fail(msg: str, *, details: dict[str, Any] | None = None) -> int:
        payload = {"event": "run_failed", "ts": _utc_now(), "message": msg}
        if details:
            payload.update(details)
        _append_jsonl(trace_path, payload)
        print(f"ERROR: {msg}", file=sys.stderr)
        return 2

    # Validate: required paths exist.
    if not manifest.main_tex.is_file():
        return fail("main.tex not found", details={"path": _relpath_str(manifest.main_tex, paper_root)})
    if manifest.sections_dir is not None and not manifest.sections_dir.is_dir():
        return fail("sections directory not found", details={"path": _relpath_str(manifest.sections_dir, paper_root)})
    for p in manifest.section_files:
        if not p.is_file():
            return fail("section file not found", details={"path": _relpath_str(p, paper_root)})
    if not manifest.bib_generated.is_file():
        return fail("references_generated.bib not found", details={"path": _relpath_str(manifest.bib_generated, paper_root)})
    if not manifest.figures_dir.exists():
        return fail("figures path not found", details={"path": _relpath_str(manifest.figures_dir, paper_root)})

    # Hygiene: create empty manual bib if missing.
    created_manual = False
    if not manifest.bib_manual.exists():
        if args.dry_run:
            _append_jsonl(
                trace_path,
                {
                    "event": "manual_bib_missing",
                    "ts": _utc_now(),
                    "path": _relpath_str(manifest.bib_manual, paper_root),
                    "would_create": True,
                },
            )
        else:
            _write_text(manifest.bib_manual, "% references_manual.bib (created by research-writer; user-maintained)\n")
            created_manual = True
            _append_jsonl(
                trace_path,
                {
                    "event": "manual_bib_created",
                    "ts": _utc_now(),
                    "path": _relpath_str(manifest.bib_manual, paper_root),
                    "sha256": _sha256_file(manifest.bib_manual),
                },
            )

    # Validate: no hep:// in any .tex under paper root.
    hep_violations: list[dict[str, Any]] = []
    tex_files = list(_iter_tex_files(paper_root))
    for p in tex_files:
        lines = _scan_for_hep_uri(p)
        if lines:
            hep_violations.append({"path": _relpath_str(p, paper_root), "lines": lines})
    if hep_violations:
        return fail("found forbidden 'hep://' in .tex files", details={"violations": hep_violations})

    # Validate: citekey conflicts between generated and manual bib.
    gen_keys = _read_bib_keys(manifest.bib_generated)
    man_keys = _read_bib_keys(manifest.bib_manual)
    overlap = sorted(set(gen_keys).intersection(set(man_keys)))
    if overlap:
        return fail(
            "citekey conflict between references_generated.bib and references_manual.bib",
            details={
                "conflicts": overlap[:200],
                "suggestion": (
                    "Rename citekeys in references_manual.bib (recommended) or regenerate references_generated.bib "
                    "to avoid duplicates; do not keep the same key in both files."
                ),
            },
        )

    # Hygiene: ensure main.tex references both bib databases.
    try:
        before_sha = _sha256_file(manifest.main_tex)
        bib_patch = _ensure_main_bibliography(manifest.main_tex, gen_db=manifest.bib_generated_db, man_db=manifest.bib_manual_db)
        changed = bool(bib_patch.get("changed"))

        if changed and args.dry_run:
            _append_jsonl(
                trace_path,
                {
                    "event": "main_tex_bibliography_planned",
                    "ts": _utc_now(),
                    "path": _relpath_str(manifest.main_tex, paper_root),
                    "before_sha256": before_sha,
                    "old": bib_patch.get("old"),
                    "new": bib_patch.get("new"),
                },
            )
        else:
            backup_created = False
            backup_path: Path | None = None
            if changed and (not args.dry_run):
                backup_created, backup_path = _maybe_write_backup(manifest.main_tex)
                _write_text(manifest.main_tex, str(bib_patch.get("after_text")))

            after_sha = _sha256_file(manifest.main_tex)
            if changed:
                _append_jsonl(
                    trace_path,
                    {
                        "event": "main_tex_bibliography_updated",
                        "ts": _utc_now(),
                        "path": _relpath_str(manifest.main_tex, paper_root),
                        "before_sha256": before_sha,
                        "after_sha256": after_sha,
                        "backup_created": backup_created,
                        "backup_path": _relpath_str(backup_path, paper_root) if backup_path else None,
                        "old": bib_patch.get("old"),
                        "new": bib_patch.get("new"),
                        "had_generated": bib_patch.get("had_generated"),
                        "had_manual": bib_patch.get("had_manual"),
                    },
                )
            else:
                _append_jsonl(
                    trace_path,
                    {
                        "event": "main_tex_bibliography_ok",
                        "ts": _utc_now(),
                        "path": _relpath_str(manifest.main_tex, paper_root),
                        "before_sha256": before_sha,
                        "after_sha256": after_sha,
                        "old": bib_patch.get("old"),
                        "new": bib_patch.get("new"),
                        "had_generated": bib_patch.get("had_generated"),
                        "had_manual": bib_patch.get("had_manual"),
                    },
                )
    except Exception as exc:
        return fail(f"failed to ensure main.tex bibliography layering: {exc}")

    # Audit: record input checksums for core inputs (manifest, tex, bib, figures).
    try:
        _append_jsonl(
            trace_path,
            {
                "event": "input_hash",
                "ts": _utc_now(),
                "path": _relpath_str(manifest.manifest_path, paper_root),
                "sha256": _sha256_file(manifest.manifest_path),
            },
        )
        for p in tex_files:
            _append_jsonl(
                trace_path,
                {
                    "event": "input_hash",
                    "ts": _utc_now(),
                    "path": _relpath_str(p, paper_root),
                    "sha256": _sha256_file(p),
                },
            )
        for p in (manifest.bib_generated, manifest.bib_manual):
            if p.exists():
                _append_jsonl(
                    trace_path,
                    {
                        "event": "input_hash",
                        "ts": _utc_now(),
                        "path": _relpath_str(p, paper_root),
                        "sha256": _sha256_file(p),
                    },
                )
        if manifest.figures_dir.is_dir():
            for p in sorted(manifest.figures_dir.rglob("*")):
                if p.is_file():
                    _append_jsonl(
                        trace_path,
                        {
                            "event": "input_hash",
                            "ts": _utc_now(),
                            "path": _relpath_str(p, paper_root),
                            "sha256": _sha256_file(p),
                        },
                    )
    except Exception as exc:
        return fail(f"failed to write input checksums: {exc}")

    _append_jsonl(
        trace_path,
        {
            "event": "validate_ok",
            "ts": _utc_now(),
            "created_manual_bib": created_manual,
        },
    )

    compile_status = "not_requested"
    compile_details: dict[str, Any] = {"requested": bool(args.compile)}
    # Optional compile.
    if args.compile and (not args.dry_run):
        if not _have_latexmk():
            _append_jsonl(
                trace_path,
                {
                    "event": "compile_skipped",
                    "ts": _utc_now(),
                    "reason": "latexmk not found",
                },
            )
            print("SKIPPED: latexmk not found")
            compile_status = "skipped"
            compile_details.update({"status": "skipped", "reason": "latexmk not found"})
        else:
            _append_jsonl(trace_path, {"event": "compile_start", "ts": _utc_now()})
            proc = subprocess.run(
                ["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", "main.tex"],
                cwd=str(paper_root),
                text=True,
                capture_output=True,
            )
            out = (proc.stdout or "") + (proc.stderr or "")
            _append_jsonl(
                trace_path,
                {
                    "event": "compile_end",
                    "ts": _utc_now(),
                    "exit_code": proc.returncode,
                    "stdout_stderr_tail": out[-4000:],
                },
            )
            if proc.returncode != 0:
                return fail("latexmk failed (see build_trace.jsonl for tail)", details={"exit_code": proc.returncode})
            compile_status = "ok"
            compile_details.update({"status": "ok", "exit_code": proc.returncode})
    elif args.dry_run:
        compile_status = "dry_run"
        compile_details.update({"status": "dry_run"})

    _append_jsonl(trace_path, {"event": "run_done", "ts": _utc_now()})

    if not args.dry_run:
        export_manifest = {
            "schemaVersion": 1,
            "tool": "research-writer",
            "entrypoint": "consume_paper_manifest",
            "generated_at_utc": _utc_now(),
            "paper_manifest": _relpath_str(manifest.manifest_path, paper_root),
            "paper": {
                "main_tex": _relpath_str(manifest.main_tex, paper_root),
                "bib": {
                    "generated": _relpath_str(manifest.bib_generated, paper_root),
                    "manual": _relpath_str(manifest.bib_manual, paper_root),
                },
                "figures_dir": _relpath_str(manifest.figures_dir, paper_root),
            },
            "compile": {
                **compile_details,
                "status": compile_status,
                "pdf": "main.pdf" if (paper_root / "main.pdf").is_file() else None,
                "log": "main.log" if (paper_root / "main.log").is_file() else None,
            },
            "run_card": run_card_info,
            "trace": {"build_trace_jsonl": "build_trace.jsonl"},
        }
        _write_json(paper_root / "export_manifest.json", export_manifest)

    print(f"[consume_manifest] ok: validated paper at {paper_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
