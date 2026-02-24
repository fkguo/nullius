from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report
from .run_card import ensure_run_card


@dataclass(frozen=True)
class LiteratureSurveyPolishInputs:
    tag: str
    compile_pdf: bool = True
    timeout_seconds: int = 900


def _find_research_writer_consume_script() -> Path:
    codex_home = os.environ.get("CODEX_HOME", "").strip()
    base = Path(codex_home).expanduser().resolve() if codex_home else (Path.home() / ".codex").resolve()
    p = base / "skills" / "research-writer" / "scripts" / "bin" / "research_writer_consume_paper_manifest.sh"
    if not p.is_file():
        raise FileNotFoundError(f"research-writer consume script not found: {p}")
    return p


def find_research_writer_consume_script() -> Path:
    """Locate the research-writer deterministic publisher entrypoint (consume paper manifest)."""
    return _find_research_writer_consume_script()


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root))
    except Exception:
        return os.fspath(p)


def _run_capture(cmd: list[str], *, cwd: Path, timeout_seconds: int) -> tuple[int, str]:
    try:
        p = subprocess.run(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            timeout=int(timeout_seconds),
            check=False,
        )
        return int(p.returncode), p.stdout
    except subprocess.TimeoutExpired:
        return 124, f"[timeout] {' '.join(cmd)} (timeout_seconds={timeout_seconds})\n"


def literature_survey_polish_one(inps: LiteratureSurveyPolishInputs, repo_root: Path) -> dict[str, Any]:
    if not inps.tag or not str(inps.tag).strip():
        raise ValueError("tag is required")

    created_at = utc_now_iso()
    tag = str(inps.tag).strip()

    # Fail fast: do not ask for A4 approval if the external tool isn't available.
    rw_script = _find_research_writer_consume_script()

    survey_dir = repo_root / "artifacts" / "runs" / tag / "literature_survey"
    survey_tex = survey_dir / "survey.tex"
    survey_bib = survey_dir / "literature_survey.bib"
    if not survey_tex.exists():
        raise FileNotFoundError(f"missing survey.tex (run export first): {survey_tex}")
    if not survey_bib.exists():
        raise FileNotFoundError(f"missing literature_survey.bib (run export first): {survey_bib}")

    out_dir = repo_root / "artifacts" / "runs" / tag / "literature_survey_polish"
    logs_dir = out_dir / "logs"
    paper_root = out_dir / "paper"
    figures_dir = paper_root / "figures"
    logs_dir.mkdir(parents=True, exist_ok=True)
    figures_dir.mkdir(parents=True, exist_ok=True)

    run_card_rel, run_card_sha = ensure_run_card(
        repo_root=repo_root,
        run_id=tag,
        workflow_id="W3_literature_survey_polish",
        params={"tag": tag, "compile_pdf": bool(inps.compile_pdf)},
        backend={"kind": "research-writer", "argv": ["bash", os.fspath(rw_script)], "cwd": ".", "env": {}},
        notes="auto-generated run-card (v0)",
        overwrite=False,
    )
    run_card_path = Path(run_card_rel)
    if not run_card_path.is_absolute():
        run_card_path = repo_root / run_card_path

    paper_manifest = paper_root / "paper_manifest.json"
    main_tex = paper_root / "main.tex"
    section_tex = paper_root / "survey.tex"
    bib_generated = paper_root / "references_generated.bib"
    bib_manual = paper_root / "references_manual.bib"

    # Stage deterministic inputs into a minimal paper scaffold under artifacts/.
    shutil.copyfile(survey_tex, section_tex)
    shutil.copyfile(survey_bib, bib_generated)
    if not bib_manual.exists():
        bib_manual.write_text("% manual bib entries (optional)\n", encoding="utf-8")

    main_tex.write_text(
        "\n".join(
            [
                "% Auto-generated for deterministic literature survey polish (v0).",
                "% This paper exists only to run research-writer hygiene + optional compile.",
                "",
                "\\documentclass{article}",
                "\\begin{document}",
                "\\input{survey.tex}",
                "",
                "\\bibliographystyle{plain}",
                "\\bibliography{references_generated}",
                "\\end{document}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    write_json(
        paper_manifest,
        {
            "schemaVersion": 1,
            "mainTex": "main.tex",
            "sections": ["survey.tex"],
            "figuresDir": "figures",
            "bib": {"generated": "references_generated.bib", "manual": "references_manual.bib"},
        },
    )

    logs_path = logs_dir / "research_writer_consume.txt"
    cmd = ["bash", os.fspath(rw_script), "--paper-manifest", os.fspath(paper_manifest), "--run-card", os.fspath(run_card_path)]
    if inps.compile_pdf:
        cmd.append("--compile")
    rc, out = _run_capture(cmd, cwd=repo_root, timeout_seconds=int(inps.timeout_seconds))
    logs_path.write_text(out, encoding="utf-8")

    export_manifest_path = paper_root / "export_manifest.json"
    export_manifest: dict[str, Any] | None = None
    if export_manifest_path.exists():
        try:
            export_manifest = read_json(export_manifest_path)
        except Exception:
            export_manifest = None

    compile_status = None
    if isinstance(export_manifest, dict):
        comp = export_manifest.get("compile")
        if isinstance(comp, dict) and isinstance(comp.get("status"), str):
            compile_status = str(comp.get("status"))

    errors: list[str] = []
    if rc != 0:
        errors.append(f"research-writer consume failed (exit_code={rc}); see logs: {os.fspath(logs_path.relative_to(repo_root))}")

    versions: dict[str, Any] = {"python": sys.version.split()[0], "os": platform.platform()}
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_literature_survey_polish.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "inputs": {"run_card_path": run_card_rel, "run_card_sha256": run_card_sha},
        "params": {"tag": tag, "compile_pdf": bool(inps.compile_pdf), "timeout_seconds": int(inps.timeout_seconds)},
        "versions": versions,
        "outputs": [
            _safe_rel(repo_root, out_dir / "manifest.json"),
            _safe_rel(repo_root, out_dir / "summary.json"),
            _safe_rel(repo_root, out_dir / "analysis.json"),
            _safe_rel(repo_root, out_dir / "report.md"),
            _safe_rel(repo_root, paper_manifest),
            _safe_rel(repo_root, main_tex),
            _safe_rel(repo_root, section_tex),
            _safe_rel(repo_root, bib_generated),
            _safe_rel(repo_root, bib_manual),
            _safe_rel(repo_root, logs_path),
            _safe_rel(repo_root, export_manifest_path) if export_manifest_path.exists() else None,
            _safe_rel(repo_root, paper_root / "build_trace.jsonl") if (paper_root / "build_trace.jsonl").exists() else None,
            _safe_rel(repo_root, paper_root / "main.pdf") if (paper_root / "main.pdf").exists() else None,
        ],
    }
    manifest["outputs"] = [p for p in manifest["outputs"] if isinstance(p, str) and p.strip()]

    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    ok = (rc == 0) and not errors
    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "literature_survey_polish"},
        "stats": {"ok": bool(ok), "consume_exit_code": int(rc), "compile_status": compile_status},
        "outputs": {
            "artifact_dir": _safe_rel(repo_root, out_dir),
            "paper_root": _safe_rel(repo_root, paper_root),
            "logs": _safe_rel(repo_root, logs_path),
            "paper_export_manifest": _safe_rel(repo_root, export_manifest_path) if export_manifest_path.exists() else None,
        },
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": tag, "compile_pdf": bool(inps.compile_pdf), "timeout_seconds": int(inps.timeout_seconds)},
        "results": {
            "ok": bool(ok),
            "errors": errors,
            "consume_exit_code": int(rc),
            "compile_status": compile_status,
            "research_writer_consume": {
                "script": _safe_rel(repo_root, rw_script),
                "command": cmd,
                "logs": _safe_rel(repo_root, logs_path),
            },
        },
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    write_json(out_dir / "manifest.json", manifest)
    write_json(out_dir / "summary.json", summary)
    write_json(out_dir / "analysis.json", analysis)
    report_rel = write_artifact_report(
        repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis
    )

    artifact_paths: dict[str, str] = {
        "manifest": _safe_rel(repo_root, out_dir / "manifest.json"),
        "summary": _safe_rel(repo_root, out_dir / "summary.json"),
        "analysis": _safe_rel(repo_root, out_dir / "analysis.json"),
        "report": report_rel,
        "paper_manifest": _safe_rel(repo_root, paper_manifest),
        "paper_export_manifest": _safe_rel(repo_root, export_manifest_path) if export_manifest_path.exists() else None,
    }
    artifact_paths = {k: v for k, v in artifact_paths.items() if isinstance(v, str) and v.strip()}

    return {"errors": errors, "artifact_paths": artifact_paths}
