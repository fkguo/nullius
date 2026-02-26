"""Report renderer — generates self-contained human reports from run results (NEW-04).

Supports Markdown and LaTeX output. Each artifact reference includes URI + SHA256
audit pointer for reproducibility.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class RunResult:
    """Summary of a single run's results for report rendering."""

    run_id: str
    workflow_id: str = ""
    headline_numbers: dict[str, Any] = field(default_factory=dict)
    artifacts: list[dict[str, str]] = field(default_factory=list)
    summary: str = ""


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _artifact_uri(run_id: str, rel_path: str) -> str:
    return f"rep://{run_id}/{rel_path}"


def collect_run_result(repo_root: Path, run_id: str) -> RunResult:
    """Collect result data from a run's artifacts directory."""
    run_dir = repo_root / "artifacts" / "runs" / run_id
    result = RunResult(run_id=run_id)

    # Load analysis.json — prefer run-level file, fall back to nested
    analysis_candidates = [run_dir / "analysis.json"]
    analysis_candidates.extend(
        p for p in sorted(run_dir.rglob("analysis.json")) if p != run_dir / "analysis.json"
    )
    for analysis_path in analysis_candidates:
        try:
            data = json.loads(analysis_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if isinstance(data.get("summary"), str):
            result.summary = data["summary"]
        if isinstance(data.get("workflow_id"), str):
            result.workflow_id = data["workflow_id"]
        results = data.get("results")
        if isinstance(results, dict):
            for k, v in results.items():
                if isinstance(v, (int, float, str, bool)):
                    result.headline_numbers[k] = v
        break  # use first analysis.json found

    # Collect artifact refs with SHA256
    for f in sorted(run_dir.rglob("*")):
        if not f.is_file():
            continue
        try:
            rel = str(f.relative_to(run_dir))
        except ValueError:
            continue
        sha = _sha256_file(f)
        uri = _artifact_uri(run_id, rel)
        result.artifacts.append({"path": rel, "uri": uri, "sha256": sha})

    return result


def render_md(results: list[RunResult]) -> str:
    """Render a self-contained Markdown report from run results."""
    lines: list[str] = [
        "# Research Report",
        "",
        f"Runs: {', '.join(r.run_id for r in results)}",
        "",
        "---",
        "",
    ]
    for r in results:
        lines.append(f"## Run: {r.run_id}")
        lines.append("")
        if r.workflow_id:
            lines.append(f"**Workflow**: {r.workflow_id}")
            lines.append("")
        if r.summary:
            lines.append("### Summary")
            lines.append("")
            lines.append(r.summary)
            lines.append("")
        if r.headline_numbers:
            lines.append("### Key Results")
            lines.append("")
            lines.append("| Metric | Value |")
            lines.append("|--------|-------|")
            for k, v in r.headline_numbers.items():
                lines.append(f"| {k} | {v} |")
            lines.append("")
        if r.artifacts:
            lines.append("### Audit Pointers")
            lines.append("")
            lines.append("| Path | URI | SHA256 |")
            lines.append("|------|-----|--------|")
            for a in r.artifacts:
                lines.append(
                    f"| `{a['path']}` | `{a['uri']}` | `{a['sha256']}` |"
                )
            lines.append("")
        lines.append("---")
        lines.append("")
    return "\n".join(lines)


def _tex_escape(s: str) -> str:
    """Escape special LaTeX characters."""
    for ch in ("\\", "&", "%", "$", "#", "_", "{", "}"):
        s = s.replace(ch, "\\" + ch)
    s = s.replace("~", "\\textasciitilde{}")
    s = s.replace("^", "\\textasciicircum{}")
    return s


def render_tex(results: list[RunResult]) -> str:
    """Render a self-contained LaTeX report from run results."""
    lines: list[str] = [
        r"\documentclass[12pt]{article}",
        r"\usepackage[utf8]{inputenc}",
        r"\usepackage{booktabs}",
        r"\usepackage{hyperref}",
        r"\usepackage{geometry}",
        r"\geometry{margin=1in}",
        r"\begin{document}",
        "",
        r"\title{Research Report}",
        r"\maketitle",
        "",
    ]
    for r in results:
        lines.append(f"\\section{{Run: {_tex_escape(r.run_id)}}}")
        lines.append("")
        if r.workflow_id:
            lines.append(f"\\textbf{{Workflow}}: {_tex_escape(r.workflow_id)}")
            lines.append("")
        if r.summary:
            lines.append("\\subsection{Summary}")
            lines.append(_tex_escape(r.summary))
            lines.append("")
        if r.headline_numbers:
            lines.append("\\subsection{Key Results}")
            lines.append("")
            lines.append(r"\begin{tabular}{ll}")
            lines.append(r"\toprule")
            lines.append(r"Metric & Value \\")
            lines.append(r"\midrule")
            for k, v in r.headline_numbers.items():
                lines.append(
                    f"{_tex_escape(str(k))} & {_tex_escape(str(v))} \\\\"
                )
            lines.append(r"\bottomrule")
            lines.append(r"\end{tabular}")
            lines.append("")
        if r.artifacts:
            lines.append("\\subsection{Audit Pointers}")
            lines.append("")
            lines.append(r"\begin{tabular}{lll}")
            lines.append(r"\toprule")
            lines.append(r"Path & URI & SHA256 \\")
            lines.append(r"\midrule")
            for a in r.artifacts:
                p = _tex_escape(a["path"])
                u = _tex_escape(a["uri"])
                lines.append(f"\\texttt{{{p}}} & \\texttt{{{u}}} & \\texttt{{{a['sha256']}}} \\\\")
            lines.append(r"\bottomrule")
            lines.append(r"\end{tabular}")
            lines.append("")
    lines.append(r"\end{document}")
    lines.append("")
    return "\n".join(lines)
