from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from ._json import read_json
from .kb_index import kb_index_path, write_kb_index


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root))
    except Exception:
        return os.fspath(p)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _md_escape_cell(text: str) -> str:
    s = str(text).replace("\r", " ").replace("\n", " ").strip()
    s = s.replace("|", "\\|")
    s = s.replace("`", "\\`")
    s = s.replace("[", "\\[").replace("]", "\\]")
    return s


def kb_profile_defs_dir(*, repo_root: Path) -> Path:
    return repo_root / "knowledge_base" / "_index" / "kb_profiles"


def _resolve_profile_def_path(repo_root: Path, *, profile: str, user_profile_path: str | None) -> Path | None:
    prof = str(profile).strip()
    if prof in {"curated", "minimal"}:
        return kb_profile_defs_dir(repo_root=repo_root) / f"{prof}.json"
    if prof == "user":
        if user_profile_path:
            p = Path(str(user_profile_path))
            return p if p.is_absolute() else (repo_root / p)
        return repo_root / ".autoresearch" / "kb_profile_user.json"
    raise ValueError(f"unknown kb_profile: {profile!r}")


def _read_profile_paths(repo_root: Path, *, profile: str, user_profile_path: str | None) -> tuple[list[str], str | None, list[str]]:
    warnings: list[str] = []
    p = _resolve_profile_def_path(repo_root, profile=profile, user_profile_path=user_profile_path)
    if p is None:
        return [], None, warnings
    if not p.exists():
        if profile == "user":
            raise FileNotFoundError(
                f"kb_profile=user requires a profile file; expected {os.fspath(p)} "
                "(or pass --kb-profile-user-path)"
            )
        warnings.append(
            "kb_profile definition missing; using an empty selection until knowledge_base/_index/kb_profiles/ is bootstrapped"
        )
        return [], None, warnings

    data = read_json(p)
    if not isinstance(data, dict):
        raise ValueError("kb_profile definition must be a JSON object")
    declared = data.get("profile")
    if declared is not None and str(declared).strip() and str(declared).strip() != str(profile).strip():
        warnings.append(f"profile def declares profile={declared!r} but selected profile={profile!r}")

    raw_paths = data.get("paths") or []
    if not isinstance(raw_paths, list):
        raise ValueError("kb_profile definition field 'paths' must be a list")
    out: list[str] = []
    seen: set[str] = set()
    for x in raw_paths:
        if not isinstance(x, str):
            continue
        s = x.replace("\\", "/").strip()
        if s.startswith("./"):
            s = s[2:]
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)

    return out, _safe_rel(repo_root, p), warnings


def validate_kb_profile(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise TypeError("kb_profile payload must be a JSON object")
    v = payload.get("schema_version")
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise ValueError("kb_profile.schema_version must be an integer >= 1")
    profile = payload.get("profile")
    if profile not in {"minimal", "curated", "user"}:
        raise ValueError("kb_profile.profile must be one of: minimal, curated, user")
    if not isinstance(payload.get("kb_index_path"), str) or not str(payload.get("kb_index_path")).strip():
        raise ValueError("kb_profile.kb_index_path must be a non-empty string")
    if not isinstance(payload.get("kb_index_sha256"), str) or len(str(payload.get("kb_index_sha256"))) < 64:
        raise ValueError("kb_profile.kb_index_sha256 must be a 64+ char string")

    selected = payload.get("selected")
    if not isinstance(selected, list):
        raise ValueError("kb_profile.selected must be an array")
    for e in selected:
        if not isinstance(e, dict):
            raise ValueError("kb_profile.selected[*] must be an object")
        for k in ["path", "kind", "lang", "sha256", "bytes", "title", "refkey"]:
            if k not in e:
                raise ValueError(f"kb_profile.selected[*] missing key: {k}")
        if not isinstance(e.get("path"), str) or not str(e.get("path")).strip():
            raise ValueError("kb_profile.selected[*].path must be a non-empty string")
        if e.get("kind") not in {"literature", "methodology_traces", "priors"}:
            raise ValueError("kb_profile.selected[*].kind invalid")
        if e.get("lang") not in {"en", "zh"}:
            raise ValueError("kb_profile.selected[*].lang invalid")
        sha = e.get("sha256")
        if not isinstance(sha, str) or len(sha) < 64:
            raise ValueError("kb_profile.selected[*].sha256 must be a 64+ char string")
        b = e.get("bytes")
        if not isinstance(b, int) or isinstance(b, bool) or b < 0:
            raise ValueError("kb_profile.selected[*].bytes must be an integer >= 0")
        title = e.get("title")
        if title is not None and (not isinstance(title, str) or not title.strip()):
            raise ValueError("kb_profile.selected[*].title must be null or a non-empty string")
        rk = e.get("refkey")
        if rk is not None and (not isinstance(rk, str) or not rk.strip()):
            raise ValueError("kb_profile.selected[*].refkey must be null or a non-empty string")

    stats = payload.get("stats")
    if not isinstance(stats, dict):
        raise ValueError("kb_profile.stats must be an object")
    for k in ["total_entries", "total_bytes"]:
        val = stats.get(k)
        if not isinstance(val, int) or isinstance(val, bool) or val < 0:
            raise ValueError(f"kb_profile.stats.{k} must be an integer >= 0")
    if not isinstance(stats.get("by_kind"), dict):
        raise ValueError("kb_profile.stats.by_kind must be an object")
    if not isinstance(stats.get("by_lang"), dict):
        raise ValueError("kb_profile.stats.by_lang must be an object")

    issues = payload.get("issues")
    if not isinstance(issues, dict):
        raise ValueError("kb_profile.issues must be an object")
    for k in ["missing_paths", "warnings"]:
        if not isinstance(issues.get(k), list):
            raise ValueError(f"kb_profile.issues.{k} must be an array")


def build_kb_profile(
    *,
    repo_root: Path,
    profile: str,
    user_profile_path: str | None = None,
) -> dict[str, Any]:
    prof = str(profile).strip()
    if prof not in {"minimal", "curated", "user"}:
        raise ValueError(f"unknown kb_profile: {profile!r}")

    paths, source_rel, warnings = _read_profile_paths(repo_root, profile=prof, user_profile_path=user_profile_path)

    idx_path = kb_index_path(repo_root=repo_root)
    if not idx_path.exists():
        write_kb_index(repo_root=repo_root, out_path=idx_path)
    idx = read_json(idx_path)
    if not isinstance(idx, dict):
        raise ValueError("kb_index.json must be a JSON object")
    raw_entries = idx.get("entries") if isinstance(idx.get("entries"), list) else []
    idx_by_path: dict[str, dict[str, Any]] = {}
    for e in raw_entries:
        if isinstance(e, dict) and isinstance(e.get("path"), str):
            idx_by_path[str(e.get("path")).replace("\\", "/")] = e

    missing: list[str] = []
    selected: list[dict[str, Any]] = []
    for p in paths:
        ent = idx_by_path.get(p)
        if ent is None:
            missing.append(p)
            continue
        selected.append(
            {
                "path": str(ent.get("path") or p),
                "kind": str(ent.get("kind") or ""),
                "lang": str(ent.get("lang") or ""),
                "sha256": str(ent.get("sha256") or ""),
                "bytes": int(ent.get("bytes") or 0),
                "title": ent.get("title") if isinstance(ent.get("title"), str) and ent.get("title").strip() else None,
                "refkey": ent.get("refkey") if isinstance(ent.get("refkey"), str) and ent.get("refkey").strip() else None,
            }
        )

    by_kind: dict[str, int] = {"literature": 0, "methodology_traces": 0, "priors": 0}
    by_lang: dict[str, int] = {"en": 0, "zh": 0}
    total_bytes = 0
    for e in selected:
        k = str(e.get("kind") or "")
        if k in by_kind:
            by_kind[k] += 1
        lang = str(e.get("lang") or "")
        if lang in by_lang:
            by_lang[lang] += 1
        try:
            total_bytes += int(e.get("bytes") or 0)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip malformed KB entry metadata
            pass

    payload: dict[str, Any] = {
        "schema_version": 1,
        "profile": prof,
        "kb_index_path": _safe_rel(repo_root, idx_path),
        "kb_index_sha256": _sha256_file(idx_path),
        "source": source_rel,
        "selected": selected,
        "stats": {
            "total_entries": int(len(selected)),
            "total_bytes": int(total_bytes),
            "by_kind": by_kind,
            "by_lang": by_lang,
        },
        "issues": {"missing_paths": missing, "warnings": warnings},
    }
    validate_kb_profile(payload)
    return payload


def write_kb_profile(
    *,
    repo_root: Path,
    out_dir: Path,
    profile: str,
    user_profile_path: str | None = None,
) -> dict[str, str]:
    """Write SSOT + deterministic report. Returns relative paths."""
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = build_kb_profile(repo_root=repo_root, profile=profile, user_profile_path=user_profile_path)

    kb_profile_path = out_dir / "kb_profile.json"
    report_path = out_dir / "report.md"

    _write_json_atomic(kb_profile_path, payload)

    lines: list[str] = []
    lines.append("# KB profile export (deterministic)")
    lines.append("")
    lines.append(f"- profile: {payload.get('profile')}")
    lines.append(f"- total_entries: {payload.get('stats', {}).get('total_entries')}")
    lines.append(f"- total_bytes: {payload.get('stats', {}).get('total_bytes')}")
    lines.append(f"- kb_index: `{payload.get('kb_index_path')}`")
    lines.append(f"- kb_index_sha256: `{payload.get('kb_index_sha256')}`")
    lines.append(f"- source: `{payload.get('source') or '(none)'}`")
    lines.append("")

    issues = payload.get("issues") if isinstance(payload.get("issues"), dict) else {}
    missing = issues.get("missing_paths") if isinstance(issues.get("missing_paths"), list) else []
    warns = issues.get("warnings") if isinstance(issues.get("warnings"), list) else []
    if missing or warns:
        lines.append("## Issues")
        lines.append("")
        if missing:
            lines.append("- missing_paths:")
            for x in missing:
                if x:
                    lines.append(f"  - `{x}`")
        if warns:
            lines.append("- warnings:")
            for x in warns[:50]:
                if x:
                    lines.append(f"  - `{x}`")
        lines.append("")

    lines.append("## Selected entries")
    lines.append("")
    lines.append("| Path | Kind | Lang | RefKey | Title |")
    lines.append("|---|---|---|---|---|")
    for e in payload.get("selected") if isinstance(payload.get("selected"), list) else []:
        if not isinstance(e, dict):
            continue
        p = str(e.get("path") or "")
        kind = str(e.get("kind") or "")
        lang = str(e.get("lang") or "")
        rk = str(e.get("refkey") or "")
        title = str(e.get("title") or "")
        lines.append(
            "| "
            + " | ".join(
                [
                    f"`{p}`" if p else "",
                    f"`{kind}`" if kind else "",
                    f"`{lang}`" if lang else "",
                    f"`{rk}`" if rk else "",
                    _md_escape_cell(title),
                ]
            )
            + " |"
        )
    lines.append("")

    _write_text_atomic(report_path, "\n".join(lines).rstrip() + "\n")

    return {
        "kb_profile_json": _safe_rel(repo_root, kb_profile_path),
        "report": _safe_rel(repo_root, report_path),
    }
