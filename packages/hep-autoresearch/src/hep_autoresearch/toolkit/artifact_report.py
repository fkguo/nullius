from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable


def _md_escape_cell(s: str) -> str:
    # Keep this minimal and deterministic; this is for Markdown tables.
    return str(s).replace("|", "\\|").replace("\n", "<br>")


def _format_scalar(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # Preserve enough precision for audit without being unreadable.
        return f"{v:.16g}"
    return str(v)


def _truncate(s: str, *, max_chars: int = 200) -> str:
    s = str(s)
    if len(s) <= max_chars:
        return s
    return s[: max(0, max_chars - 3)].rstrip() + "..."


def _is_scalar(v: Any) -> bool:
    return v is None or isinstance(v, (bool, int, float, str))


def _pointer_escape(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def _json_pointer(base: str, tokens: Iterable[str]) -> str:
    parts = [_pointer_escape(str(t)) for t in tokens]
    return base + "#/" + "/".join(parts)


def _md_link(text: str, href: str) -> str:
    # Use <...> destinations to keep things robust with spaces/parentheses.
    t = _md_escape_cell(str(text))
    h = str(href).replace("\\", "/").strip().replace(" ", "%20")
    return f"[{t}](<{h}>)"


def _row(key: str, value: Any, pointer: str) -> str:
    return (
        f"| `{_md_escape_cell(key)}` |"
        f" `{_md_escape_cell(_truncate(_format_scalar(value)))}` |"
        f" {_md_link(pointer, pointer)} |"
    )


def render_artifact_report(
    *,
    repo_root: Path,
    artifact_dir: Path,
    manifest: dict[str, Any] | None,
    summary: dict[str, Any] | None,
    analysis: dict[str, Any] | None,
) -> str:
    """
    Deterministically render a human-readable report.md from manifest/summary/analysis (JSON SSOT).

    Design goals:
    - Human-first: easy to scan "what ran / what happened / where to look".
    - Deterministic: should be safely regeneratable; do not hand-edit.
    - Pointer-first: every headline should have a JSON pointer for citation and audit.
    """

    created_at = None
    if isinstance(manifest, dict):
        created_at = manifest.get("created_at")
    if created_at is None and isinstance(summary, dict):
        created_at = summary.get("created_at")
    if created_at is None and isinstance(analysis, dict):
        created_at = analysis.get("created_at")

    defs: dict[str, Any] = (summary.get("definitions") or {}) if isinstance(summary, dict) else {}
    workflow = defs.get("workflow") or defs.get("kind") or "(unknown)"

    try:
        rel_dir = os.fspath(artifact_dir.resolve().relative_to(repo_root.resolve()))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        # Best-effort: repo_root may be a symlinked tempdir on some platforms (e.g. /var -> /private/var on macOS).
        rel_dir = os.fspath(artifact_dir)

    rel_dir_posix = str(rel_dir).replace(os.sep, "/")

    def _href_from_repo_rel(p: str) -> str:
        """Compute a Markdown href (relative to artifact_dir) from a repo-root-relative path."""
        s = str(p).strip().replace("\\", "/")
        if not s:
            return s
        if rel_dir_posix and (s == rel_dir_posix or s.startswith(rel_dir_posix + "/")):
            return s[len(rel_dir_posix) + 1 :] if s != rel_dir_posix else "."
        try:
            target = (repo_root / s).resolve()
            href = os.path.relpath(os.fspath(target), start=os.fspath(artifact_dir.resolve()))
            return href.replace(os.sep, "/")
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            return s

    lines: list[str] = [
        f"# Report — {workflow}",
        "",
        "> This file is a deterministic, human-readable view derived from JSON SSOT files in the same directory.",
        "> Regenerate (do not hand-edit) if needed.",
        "",
        f"- artifact_dir: {_md_link(rel_dir, '.')}",
        f"- created_at: `{created_at or '(unknown)'}`",
        "",
        "## Files (SSOT)",
        "",
        f"- {_md_link('manifest.json', 'manifest.json')}",
        f"- {_md_link('summary.json', 'summary.json')}",
        f"- {_md_link('analysis.json', 'analysis.json')}",
        "",
    ]

    if isinstance(manifest, dict):
        lines.extend(["## Run", ""])
        cmd = manifest.get("command")
        cwd = manifest.get("cwd")
        if cmd:
            lines.append(f"- command: `{_truncate(cmd, max_chars=240)}`")
        if cwd:
            lines.append(f"- cwd: `{_truncate(cwd, max_chars=240)}`")
        git_meta = manifest.get("git") if isinstance(manifest.get("git"), dict) else None
        if git_meta:
            commit = git_meta.get("commit")
            branch = git_meta.get("branch")
            if commit:
                lines.append(f"- git.commit: `{commit}`")
            if branch:
                lines.append(f"- git.branch: `{branch}`")
        lines.append("")

        params = manifest.get("params") if isinstance(manifest.get("params"), dict) else {}
        if params:
            lines.extend(["### Params", "", "| key | value | pointer |", "|---|---|---|"])
            for k in sorted(params.keys())[:40]:
                v = params[k]
                ptr = _json_pointer("manifest.json", ["params", str(k)])
                lines.append(_row(str(k), v, ptr))
            if len(params.keys()) > 40:
                lines.append(f"\n(Showing 40/{len(params.keys())} keys; see full JSON.)\n")

        versions = manifest.get("versions") if isinstance(manifest.get("versions"), dict) else {}
        if versions:
            lines.extend(["### Versions", "", "| key | value | pointer |", "|---|---|---|"])
            for k in sorted(versions.keys())[:40]:
                v = versions[k]
                ptr = _json_pointer("manifest.json", ["versions", str(k)])
                lines.append(_row(str(k), v, ptr))
            if len(versions.keys()) > 40:
                lines.append(f"\n(Showing 40/{len(versions.keys())} keys; see full JSON.)\n")

        outs = manifest.get("outputs")
        if isinstance(outs, list) and outs:
            lines.extend(["### Outputs (paths)", ""])
            for p in outs[:60]:
                p_s = str(p)
                href = _href_from_repo_rel(p_s)
                lines.append(f"- {_md_link(_truncate(p_s, max_chars=240), href)}")
            if len(outs) > 60:
                lines.append(f"- … ({len(outs) - 60} more; see manifest.json)")
            lines.append("")

    if isinstance(summary, dict):
        lines.extend(["## Summary", ""])
        stats = summary.get("stats") if isinstance(summary.get("stats"), dict) else {}
        if stats:
            lines.extend(["| key | value | pointer |", "|---|---|---|"])
            for k in sorted(stats.keys())[:40]:
                v = stats[k]
                ptr = _json_pointer("summary.json", ["stats", str(k)])
                lines.append(_row(str(k), v, ptr))
            if len(stats.keys()) > 40:
                lines.append(f"\n(Showing 40/{len(stats.keys())} keys; see full JSON.)\n")
        else:
            lines.append("- (no summary.stats)")
        lines.append("")

    if isinstance(analysis, dict):
        lines.extend(["## Results", ""])
        results = analysis.get("results") if isinstance(analysis.get("results"), dict) else {}
        if not results:
            lines.append("- (no analysis.results)")
        else:
            # Keep the report deterministic and avoid repeating the same keys across sections.
            rendered_keys: set[str] = set()

            ok_val = results.get("ok") if "ok" in results else None
            if ok_val is not None:
                lines.append(f"- ok: `{_format_scalar(ok_val)}` ({_md_link('analysis.json#/results/ok', 'analysis.json#/results/ok')})")
                rendered_keys.add("ok")
            errors = results.get("errors")
            if isinstance(errors, list):
                lines.append(f"- errors: `{len(errors)}` ({_md_link('analysis.json#/results/errors', 'analysis.json#/results/errors')})")
                rendered_keys.add("errors")
                if errors:
                    for e in errors[:10]:
                        lines.append(f"  - `{_truncate(e, max_chars=240)}`")
                    if len(errors) > 10:
                        lines.append(f"  - … ({len(errors) - 10} more)")
            lines.append("")

            # Headline numbers can be represented as:
            # - analysis.results.headlines: a simple object (most workflows)
            # - analysis.results.headline_numbers: a list of {label,tier,value,source,pointer} (W_compute/run_card v2)
            headlines = results.get("headlines")
            if isinstance(headlines, dict) and headlines:
                rendered_keys.add("headlines")
                lines.extend(["### Headline numbers", "", "| key | value | pointer |", "|---|---:|---|"])
                for k in sorted(headlines.keys())[:60]:
                    v = headlines[k]
                    ptr = _json_pointer("analysis.json", ["results", "headlines", str(k)])
                    lines.append(_row(str(k), v, ptr))
                if len(headlines.keys()) > 60:
                    lines.append(f"\n(Showing 60/{len(headlines.keys())} keys; see full JSON.)\n")
                lines.append("")

            hn_rows = results.get("headline_numbers")
            if isinstance(hn_rows, list) and hn_rows:
                rendered_keys.add("headline_numbers")
                lines.extend(["### Headline numbers", "", "| tier | label | value | pointer |", "|---|---|---:|---|"])
                for idx, r in enumerate(hn_rows[:80]):
                    if not isinstance(r, dict):
                        continue
                    tier = r.get("tier")
                    label = r.get("label")
                    value = r.get("value")
                    source = r.get("source")
                    ptr = r.get("pointer")
                    full_ptr = None
                    if isinstance(source, str) and source.strip() and isinstance(ptr, str) and ptr.strip():
                        # Avoid backslashes inside f-string expressions (Python syntax restriction).
                        full_ptr = source.strip().replace("\\", "/") + ptr.strip()
                    # Fallback pointer into analysis.json if the source pointer is missing.
                    pointer_cell = full_ptr or _json_pointer("analysis.json", ["results", "headline_numbers", str(idx)])
                    tier_cell = str(tier).strip() if isinstance(tier, str) and tier.strip() else "(missing)"
                    label_cell = str(label).strip() if isinstance(label, str) and label.strip() else "(missing)"
                    lines.append(
                        "|"
                        f" `{_md_escape_cell(tier_cell)}` |"
                        f" `{_md_escape_cell(_truncate(label_cell, max_chars=120))}` |"
                        f" `{_md_escape_cell(_truncate(_format_scalar(value), max_chars=80))}` |"
                        f" {_md_link(pointer_cell, pointer_cell)} |"
                    )
                if len(hn_rows) > 80:
                    lines.append(f"\n(Showing 80/{len(hn_rows)} rows; see full JSON.)\n")
                lines.append("")

            acc_rows = results.get("acceptance_checks")
            if isinstance(acc_rows, list) and acc_rows:
                rendered_keys.add("acceptance_checks")
                passed = 0
                total = 0
                for r in acc_rows:
                    if not isinstance(r, dict):
                        continue
                    total += 1
                    if bool(r.get("ok")):
                        passed += 1
                lines.extend(
                    [
                        "### Acceptance checks",
                        "",
                        f"- passed: `{passed}/{total}` ({_md_link('analysis.json#/results/acceptance_checks', 'analysis.json#/results/acceptance_checks')})",
                        "",
                        "| ok | value | min | max | pointer |",
                        "|---|---:|---:|---:|---|",
                    ]
                )
                for r in acc_rows[:80]:
                    if not isinstance(r, dict):
                        continue
                    ok = "true" if bool(r.get("ok")) else "false"
                    value = r.get("value")
                    mn = r.get("min")
                    mx = r.get("max")
                    path = r.get("path")
                    ptr = r.get("pointer")
                    full_ptr = None
                    if isinstance(path, str) and path.strip() and isinstance(ptr, str) and ptr.strip():
                        # Avoid backslashes inside f-string expressions (Python syntax restriction).
                        full_ptr = path.strip().replace("\\", "/") + ptr.strip()
                    pointer_cell = full_ptr or _json_pointer("analysis.json", ["results", "acceptance_checks"])
                    lines.append(
                        "|"
                        f" `{_md_escape_cell(ok)}` |"
                        f" `{_md_escape_cell(_truncate(_format_scalar(value), max_chars=80))}` |"
                        f" `{_md_escape_cell(_truncate(_format_scalar(mn), max_chars=80))}` |"
                        f" `{_md_escape_cell(_truncate(_format_scalar(mx), max_chars=80))}` |"
                        f" {_md_link(pointer_cell, pointer_cell)} |"
                    )
                if len(acc_rows) > 80:
                    lines.append(f"\n(Showing 80/{len(acc_rows)} rows; see full JSON.)\n")
                lines.append("")

            # Fallback: show top-level scalar results (excluding errors/headlines).
            scalar_keys = [k for k, v in results.items() if k not in ({"errors"} | rendered_keys) and _is_scalar(v)]
            if scalar_keys:
                lines.extend(["### Other scalar results", "", "| key | value | pointer |", "|---|---:|---|"])
                for k in sorted(scalar_keys)[:60]:
                    v = results[k]
                    ptr = _json_pointer("analysis.json", ["results", str(k)])
                    lines.append(_row(str(k), v, ptr))
                if len(scalar_keys) > 60:
                    lines.append(f"\n(Showing 60/{len(scalar_keys)} keys; see full JSON.)\n")
                lines.append("")

            # Non-scalar: list pointers and types to guide the reader.
            complex_keys = [k for k, v in results.items() if k not in ({"errors"} | rendered_keys) and not _is_scalar(v)]
            if complex_keys:
                lines.extend(["### Structured outputs (inspect in JSON)", ""])
                for k in sorted(complex_keys)[:60]:
                    v = results[k]
                    ptr = _json_pointer("analysis.json", ["results", str(k)])
                    if isinstance(v, list):
                        lines.append(f"- `{k}`: list(len={len(v)}) — {_md_link(ptr, ptr)}")
                    elif isinstance(v, dict):
                        lines.append(f"- `{k}`: object(keys={len(v.keys())}) — {_md_link(ptr, ptr)}")
                    else:
                        lines.append(f"- `{k}`: {type(v).__name__} — {_md_link(ptr, ptr)}")
                if len(complex_keys) > 60:
                    lines.append(f"- … ({len(complex_keys) - 60} more; see analysis.json)")
                lines.append("")

    lines.extend(
        [
            "## Notes",
            "",
            "- JSON is the source of truth (SSOT). This report is derived for humans.",
            "- For citations/audit, prefer stable pointers into SSOT JSON (e.g. `analysis.json#/results/headlines/<key>` when present),",
            "  and for run_card-derived values use the source pointers like `phases/<phase>/.../result.json#/...`.",
            "",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


def write_artifact_report(
    *,
    repo_root: Path,
    artifact_dir: Path,
    manifest: dict[str, Any] | None,
    summary: dict[str, Any] | None,
    analysis: dict[str, Any] | None,
    report_name: str = "report.md",
) -> str:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    report_path = artifact_dir / report_name
    report_path.write_text(
        render_artifact_report(repo_root=repo_root, artifact_dir=artifact_dir, manifest=manifest, summary=summary, analysis=analysis),
        encoding="utf-8",
    )
    try:
        return os.fspath(report_path.resolve().relative_to(repo_root.resolve()))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(report_path)
