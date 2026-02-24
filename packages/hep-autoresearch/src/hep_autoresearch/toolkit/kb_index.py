from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


def kb_index_path(*, repo_root: Path) -> Path:
    return repo_root / "knowledge_base" / "_index" / "kb_index.json"


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(p)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _extract_title(lines: list[str]) -> str | None:
    for ln in lines:
        s = ln.strip()
        if s.startswith("# "):
            title = s[2:].strip()
            return title if title else None
    return None


def _extract_refkey(lines: list[str]) -> str | None:
    for ln in lines:
        s = ln.strip()
        if s.startswith("RefKey:"):
            v = s.split(":", 1)[1].strip() if ":" in s else ""
            return v if v else None
    return None


def _lang_for_path(p: Path) -> str:
    name = p.name.lower()
    if name.endswith(".zh.md"):
        return "zh"
    return "en"


def validate_kb_index(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise TypeError("kb_index payload must be a JSON object")
    v = payload.get("schema_version")
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        raise ValueError("kb_index.schema_version must be an integer >= 1")

    roots = payload.get("roots")
    if not isinstance(roots, dict):
        raise ValueError("kb_index.roots must be an object")
    for k in ["literature", "methodology_traces", "priors"]:
        if not isinstance(roots.get(k), str) or not str(roots.get(k)).strip():
            raise ValueError(f"kb_index.roots.{k} must be a non-empty string")

    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise ValueError("kb_index.entries must be an array")
    for e in entries:
        if not isinstance(e, dict):
            raise ValueError("kb_index.entries[*] must be an object")
        if not isinstance(e.get("path"), str) or not str(e.get("path")).strip():
            raise ValueError("kb_index.entries[*].path must be a non-empty string")
        if e.get("kind") not in {"literature", "methodology_traces", "priors"}:
            raise ValueError("kb_index.entries[*].kind must be one of: literature, methodology_traces, priors")
        if e.get("lang") not in {"en", "zh"}:
            raise ValueError("kb_index.entries[*].lang must be one of: en, zh")
        sha = e.get("sha256")
        if not isinstance(sha, str) or len(sha) != 64:
            raise ValueError("kb_index.entries[*].sha256 must be a 64-char hex digest")
        b = e.get("bytes")
        if not isinstance(b, int) or isinstance(b, bool) or b < 0:
            raise ValueError("kb_index.entries[*].bytes must be an integer >= 0")
        rk = e.get("refkey")
        if rk is not None and (not isinstance(rk, str) or not rk.strip()):
            raise ValueError("kb_index.entries[*].refkey must be null or a non-empty string")

    stats = payload.get("stats")
    if not isinstance(stats, dict):
        raise ValueError("kb_index.stats must be an object")
    for k in ["total_entries", "refkeys_total", "refkeys_missing"]:
        val = stats.get(k)
        if not isinstance(val, int) or isinstance(val, bool) or val < 0:
            raise ValueError(f"kb_index.stats.{k} must be an integer >= 0")
    if not isinstance(stats.get("by_kind"), dict):
        raise ValueError("kb_index.stats.by_kind must be an object")
    if not isinstance(stats.get("by_lang"), dict):
        raise ValueError("kb_index.stats.by_lang must be an object")


def build_kb_index(*, repo_root: Path) -> dict[str, Any]:
    kb_root = repo_root / "knowledge_base"
    roots: dict[str, Path] = {
        "literature": kb_root / "literature",
        "methodology_traces": kb_root / "methodology_traces",
        "priors": kb_root / "priors",
    }
    entries: list[dict[str, Any]] = []

    for kind, root in roots.items():
        if not root.exists():
            continue
        for p in sorted(root.rglob("*.md")):
            if not p.is_file():
                continue
            if p.name.startswith("_"):
                continue
            # Keep extraction minimal and deterministic.
            try:
                lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unreadable files
                lines = []
            title = _extract_title(lines)
            refkey = _extract_refkey(lines)
            try:
                size = int(p.stat().st_size)
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort optional read
                size = 0
            entries.append(
                {
                    "path": _safe_rel(repo_root, p),
                    "kind": kind,
                    "lang": _lang_for_path(p),
                    "title": title or None,
                    "refkey": refkey,
                    "sha256": _sha256_file(p),
                    "bytes": size,
                }
            )

    entries.sort(key=lambda e: str(e.get("path") or ""))
    by_kind: dict[str, int] = {"literature": 0, "methodology_traces": 0, "priors": 0}
    by_lang: dict[str, int] = {"en": 0, "zh": 0}
    refkeys_total = 0
    for e in entries:
        k = str(e.get("kind") or "")
        if k in by_kind:
            by_kind[k] += 1
        lang = str(e.get("lang") or "")
        if lang in by_lang:
            by_lang[lang] += 1
        if isinstance(e.get("refkey"), str) and str(e.get("refkey")).strip():
            refkeys_total += 1

    payload: dict[str, Any] = {
        "schema_version": 1,
        "roots": {k: _safe_rel(repo_root, p) for k, p in roots.items()},
        "entries": entries,
        "stats": {
            "total_entries": int(len(entries)),
            "by_kind": by_kind,
            "by_lang": by_lang,
            "refkeys_total": int(refkeys_total),
            "refkeys_missing": int(len(entries) - refkeys_total),
        },
    }
    validate_kb_index(payload)
    return payload


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def write_kb_index(*, repo_root: Path, out_path: Path | None = None) -> tuple[str, str]:
    out = out_path or kb_index_path(repo_root=repo_root)
    payload = build_kb_index(repo_root=repo_root)
    _write_json_atomic(out, payload)
    sha = _sha256_file(out)
    return _safe_rel(repo_root, out), sha

