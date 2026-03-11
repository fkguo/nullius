#!/usr/bin/env python3
"""
Build a focused LaTeX draft review packet (TeX-source-first).

Goals:
  - Provide deterministic preflight summaries (bib/cite/label/fig/KB linkage).
  - Provide *substantive* focus slices so reviewers read physics/method/results, not just formalia.

This script does not compile TeX and does not require a TeX toolchain.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore
from semantic_packet_curator import CandidateRecord, curate_candidates  # type: ignore
from tex_draft import (  # type: ignore
    TexEnvBlock,
    TexLine,
    TexSection,
    extract_env_blocks,
    extract_occurrences,
    extract_sections,
    flatten_tex,
    parse_bib_keys,
    slice_flat_lines,
    strip_tex_comments,
)

_CITE_INLINE_RE = re.compile(r"\\[A-Za-z]*cite[A-Za-z*]*\s*(?:\\[[^\\]]*\\]\\s*)*{([^}]+)}")


@dataclass(frozen=True)
class _RiskHit:
    kind: str  # provenance | uncertainty
    line: TexLine
    excerpt: str
    cite_keys_inline: tuple[str, ...]


def _slice_lines_with_meta(flat: list[TexLine], start_idx: int, end_idx: int, max_chars: int) -> list[TexLine]:
    if not flat:
        return []
    start_idx = max(0, min(start_idx, len(flat) - 1))
    end_idx = max(start_idx, min(end_idx, len(flat)))
    out: list[TexLine] = []
    total = 0
    for tl in flat[start_idx:end_idx]:
        out.append(tl)
        total += len(tl.text)
        if total >= max_chars:
            break
    return out


def _extract_inline_cite_keys(line: str) -> tuple[str, ...]:
    keys: list[str] = []
    for m in _CITE_INLINE_RE.finditer(line):
        raw = (m.group(1) or "").strip()
        for k in [x.strip() for x in raw.split(",")]:
            if k:
                keys.append(k)

    # Deterministic unique-preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for k in keys:
        if k in seen:
            continue
        seen.add(k)
        out.append(k)
    return tuple(out)


def _risk_scan(lines: list[TexLine], max_hits_per_kind: int = 20) -> tuple[list[_RiskHit], list[_RiskHit]]:
    """
    Heuristic scan for lines that *look like* they discuss:
      - data provenance / sampling (provenance)
      - uncertainty / weighting / error model (uncertainty)

    This is intended to reduce hallucination risk by surfacing candidate claims for
    reviewer evidence-gating. It is not authoritative.
    """
    provenance_pats = [
        re.compile(
            r"\b(?:data|dataset|measurement(?:s)?)\b.*\b(?:taken|obtained|extracted|downloaded|sourced)\s+from\b",
            flags=re.IGNORECASE,
        ),
        re.compile(r"\b(?:taken|obtained|extracted|downloaded|sourced)\s+from\b", flags=re.IGNORECASE),
        re.compile(r"\bfrom\s+(?:the\s+)?(?:database|archive|repository|online)\b", flags=re.IGNORECASE),
        re.compile(r"\bNNOline\b", flags=re.IGNORECASE),
    ]
    uncertainty_pats = [
        re.compile(r"\buncertaint(?:y|ies)\b", flags=re.IGNORECASE),
        re.compile(r"\b(?:statistical|systematic|covariance)\b", flags=re.IGNORECASE),
        re.compile(r"\berror\s*(?:bars?|model)\b", flags=re.IGNORECASE),
        re.compile(r"\buncertainty\s*model\b", flags=re.IGNORECASE),
        re.compile(r"\b(?:weighted|weights?|weighting)\b", flags=re.IGNORECASE),
        re.compile(r"\b(?:added\s+in\s+quadrature|in\s+quadrature)\b", flags=re.IGNORECASE),
        re.compile(r"\buniform\b.*\b(?:error|uncertaint)\b", flags=re.IGNORECASE),
        re.compile(r"\bpoint[- ]by[- ]point\b", flags=re.IGNORECASE),
    ]

    prov_hits: list[_RiskHit] = []
    unc_hits: list[_RiskHit] = []
    seen: set[tuple[str, int, str]] = set()

    for tl in lines:
        raw = strip_tex_comments(tl.text).strip()
        if not raw:
            continue

        is_prov = any(p.search(raw) for p in provenance_pats)
        is_unc = any(p.search(raw) for p in uncertainty_pats)
        if not is_prov and not is_unc:
            continue

        cite_keys = _extract_inline_cite_keys(raw)
        excerpt = raw if len(raw) <= 240 else (raw[:237].rstrip() + "...")

        if is_prov and len(prov_hits) < max_hits_per_kind:
            key = (str(tl.path), int(tl.line_no), "provenance")
            if key not in seen:
                seen.add(key)
                prov_hits.append(
                    _RiskHit(kind="provenance", line=tl, excerpt=excerpt, cite_keys_inline=cite_keys)
                )

        if is_unc and len(unc_hits) < max_hits_per_kind:
            key = (str(tl.path), int(tl.line_no), "uncertainty")
            if key not in seen:
                seen.add(key)
                unc_hits.append(
                    _RiskHit(kind="uncertainty", line=tl, excerpt=excerpt, cite_keys_inline=cite_keys)
                )

        if len(prov_hits) >= max_hits_per_kind and len(unc_hits) >= max_hits_per_kind:
            break

    return prov_hits, unc_hits


def _rel(root: Path, p: Path) -> str:
    try:
        return p.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return p.as_posix()


def _utc_now() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _clip_preview(text: str, *, max_chars: int = 240) -> str:
    text = re.sub(r"\s+", " ", strip_tex_comments(text)).strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _load_structure_map(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {"version": 1}
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"version": 1}
    return obj if isinstance(obj, dict) else {"version": 1}


def _write_structure_map(path: Path, obj: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _keywords_hit_count(text: str, keywords: set[str]) -> int:
    t = text.lower()
    return sum(1 for k in keywords if k in t)


def _section_metrics(flat_lines: list, section: TexSection, env_blocks: list[TexEnvBlock]) -> dict[str, float]:
    start, end = section.start_idx, section.end_idx
    title = section.title or ""
    title_l = title.lower()

    eq_envs = {
        "equation",
        "equation*",
        "align",
        "align*",
        "gather",
        "gather*",
        "multline",
        "multline*",
        "eqnarray",
        "eqnarray*",
        "split",
        "cases",
    }
    algo_envs = {
        "algorithm",
        "algorithm*",
        "algorithm2e",
        "algorithmic",
        "algorithmicx",
        "lstlisting",
        "minted",
        "verbatim",
    }
    theorem_envs = {
        "theorem",
        "lemma",
        "proposition",
        "corollary",
        "definition",
        "proof",
    }

    eq_count = 0
    algo_count = 0
    theorem_count = 0
    for b in env_blocks:
        if b.start_idx < start or b.start_idx >= end:
            continue
        env = b.env.strip()
        base = env[:-1] if env.endswith("*") else env
        if env in eq_envs or base in eq_envs:
            eq_count += 1
        if env in algo_envs or base in algo_envs:
            algo_count += 1
        if env in theorem_envs or base in theorem_envs:
            theorem_count += 1

    cite_count = 0
    fig_count = 0
    word_count = 0
    math_delim_count = 0
    sample_parts: list[str] = []
    sample_chars = 0
    for tl in flat_lines[start:end]:
        ln = strip_tex_comments(tl.text)
        cite_count += ln.count("\\cite")
        fig_count += ln.count("\\includegraphics")
        math_delim_count += ln.count("\\[") + ln.count("\\]") + ln.count("$$")
        word_count += len(re.findall(r"[A-Za-z]{2,}", ln))
        if sample_chars < 8000:
            sample_parts.append(ln)
            sample_chars += len(ln)

    sample_text = "".join(sample_parts).lower()

    method_title_kw = {
        "method",
        "methods",
        "approach",
        "formalism",
        "framework",
        "setup",
        "model",
        "formulation",
        "calculation",
        "derivation",
        "algorithm",
        "implementation",
        "numerical",
        "simulation",
        "scheme",
        "procedure",
    }
    result_title_kw = {
        "result",
        "results",
        "analysis",
        "benchmark",
        "validation",
        "comparison",
        "convergence",
        "uncertainty",
        "error",
        "numerical",
        "simulation",
        "data",
    }
    discussion_title_kw = {
        "discussion",
        "interpretation",
        "physical",
        "implication",
        "phenomenology",
        "conclusion",
        "summary",
        "outlook",
    }

    # Light de-emphasis of intro/related-work sections for default auto focus.
    downweight_kw = {"introduction", "related", "background", "overview", "literature"}
    downweight = 1.0
    if any(k in title_l for k in downweight_kw):
        downweight = 0.6

    method_score = (6.0 * algo_count + 2.5 * eq_count + 1.0 * theorem_count + 0.5 * cite_count) * downweight
    method_score += 4.0 * _keywords_hit_count(title, method_title_kw)
    method_score += 1.2 * _keywords_hit_count(sample_text, method_title_kw)

    result_score = (8.0 * fig_count + 1.5 * eq_count + 0.3 * cite_count) * downweight
    result_score += 4.0 * _keywords_hit_count(title, result_title_kw)
    result_score += 1.2 * _keywords_hit_count(sample_text, result_title_kw)

    discussion_score = (2.0 * eq_count + 0.8 * theorem_count + 0.6 * cite_count) * downweight
    discussion_score += 4.0 * _keywords_hit_count(title, discussion_title_kw)
    discussion_score += 1.2 * _keywords_hit_count(sample_text, discussion_title_kw)

    # If the title is uninformative, let content signals dominate.
    if len(title_l.strip()) <= 3 or title_l.strip() in {"", "notes"}:
        method_score *= 1.2
        result_score *= 1.2
        discussion_score *= 1.2

    return {
        "eq_count": float(eq_count),
        "algo_count": float(algo_count),
        "theorem_count": float(theorem_count),
        "cite_count": float(cite_count),
        "fig_count": float(fig_count),
        "word_count": float(word_count),
        "math_delim_count": float(math_delim_count),
        "method_score": float(method_score),
        "result_score": float(result_score),
        "discussion_score": float(discussion_score),
    }


def _normalize_focus_intents(focus_sections: list[str]) -> list[str]:
    req = [str(x).strip().lower() for x in focus_sections if str(x).strip()]
    if not req or "auto" in req:
        req = ["methods", "results", "discussion"]

    alias = {
        "method": "methods",
        "methods": "methods",
        "result": "results",
        "results": "results",
        "physics": "discussion",
        "discussion": "discussion",
        "interpretation": "discussion",
    }
    out: list[str] = []
    seen: set[str] = set()
    for raw in req:
        normalized = alias.get(raw)
        if normalized is None or normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out or ["methods", "results", "discussion"]


def _rank_focus_section_ids(
    sections: list[TexSection],
    flat_lines: list,
    env_blocks: list[TexEnvBlock],
    focus_sections: list[str],
) -> tuple[list[int], dict[int, dict[str, float]], list[str]]:
    if not sections:
        return [], {}, []

    requested = _normalize_focus_intents(focus_sections)
    metrics: dict[int, dict[str, float]] = {}
    for i, section in enumerate(sections):
        metrics[i] = _section_metrics(flat_lines, section, env_blocks)

    ranked: list[int] = []
    used: set[int] = set()

    def _pick_best(score_key: str) -> int | None:
        best_i: int | None = None
        best_v = -1.0
        for idx in range(len(sections)):
            if idx in used:
                continue
            value = float(metrics[idx].get(score_key, 0.0))
            if value > best_v:
                best_v = value
                best_i = idx
        return best_i

    for intent in requested:
        score_key = {
            "methods": "method_score",
            "results": "result_score",
            "discussion": "discussion_score",
        }.get(intent, "")
        if not score_key:
            continue
        idx = _pick_best(score_key)
        if idx is None:
            continue
        ranked.append(idx)
        used.add(idx)

    scored: list[tuple[float, int]] = []
    for idx in range(len(sections)):
        if idx in used:
            continue
        metric = metrics[idx]
        combined = max(
            float(metric["method_score"]),
            float(metric["result_score"]),
            float(metric["discussion_score"]),
        )
        combined += 0.2 * float(metric["eq_count"]) + 0.5 * float(metric["algo_count"])
        scored.append((combined, idx))
    scored.sort(reverse=True, key=lambda item: item[0])
    ranked.extend(idx for _, idx in scored)
    return ranked, metrics, requested


def _build_section_candidates(
    *,
    sections: list[TexSection],
    ranked_ids: list[int],
    metrics: dict[int, dict[str, float]],
    flat_lines: list[TexLine],
    requested_intents: list[str],
    max_section_chars: int,
    root: Path,
) -> tuple[list[CandidateRecord], dict[str, TexSection]]:
    candidates: list[CandidateRecord] = []
    section_lookup: dict[str, TexSection] = {}
    for fallback_rank, section_idx in enumerate(ranked_ids, start=1):
        section = sections[section_idx]
        metric = metrics[section_idx]
        candidate_id = f"section-{section_idx + 1:03d}"
        snippet = slice_flat_lines(flat_lines, section.start_idx, section.end_idx, max_chars=max_section_chars)
        preview = _clip_preview(snippet)
        hints = {
            "fallback_rank": fallback_rank,
            "requested_intents": requested_intents,
            "intent_scores": {
                "methods": round(float(metric["method_score"]), 3),
                "results": round(float(metric["result_score"]), 3),
                "discussion": round(float(metric["discussion_score"]), 3),
            },
            "eq_count": int(metric["eq_count"]),
            "algo_count": int(metric["algo_count"]),
            "fig_count": int(metric["fig_count"]),
            "cite_count": int(metric["cite_count"]),
        }
        candidates.append(
            CandidateRecord(
                candidate_id=candidate_id,
                unit="tex_section",
                label=section.title or "(untitled section)",
                source_path=f"{_rel(root, section.path)}:{section.line_no}",
                start_line=int(section.line_no),
                end_line=int(section.line_no),
                preview=preview,
                text=snippet,
                hints=hints,
                fallback_rank=fallback_rank,
            )
        )
        section_lookup[candidate_id] = section
    return candidates, section_lookup


def _env_matches(env: str, focus_envs: set[str]) -> bool:
    e = env.strip()
    base = e[:-1] if e.endswith("*") else e
    return e in focus_envs or base in focus_envs or (base + "*") in focus_envs


def _extract_first_label(flat_lines: list, start_idx: int, end_idx: int) -> str:
    pat = re.compile(r"\\label\s*{([^}]+)}")
    for tl in flat_lines[start_idx : min(end_idx, start_idx + 2000)]:
        m = pat.search(strip_tex_comments(tl.text))
        if m:
            return (m.group(1) or "").strip()
    return ""


def _select_env_blocks(
    env_blocks: list[TexEnvBlock],
    focus_sections: list[TexSection],
    flat_lines: list,
    focus_envs: list[str],
    max_env_blocks: int,
) -> list[tuple[TexEnvBlock, str]]:
    focus_set = {str(x).strip() for x in focus_envs if str(x).strip()}
    if not focus_set or "auto" in {x.lower() for x in focus_set}:
        focus_set = {
            "equation",
            "equation*",
            "align",
            "align*",
            "gather",
            "gather*",
            "multline",
            "multline*",
            "algorithm",
            "algorithm*",
            "algorithm2e",
            "algorithmic",
            "lstlisting",
            "minted",
            "theorem",
            "lemma",
            "proposition",
            "corollary",
            "definition",
            "proof",
        }

    # Union of ranges covered by focus sections.
    ranges: list[tuple[int, int]] = [(s.start_idx, s.end_idx) for s in focus_sections]

    def _in_focus(idx: int) -> bool:
        return any(a <= idx < b for a, b in ranges)

    candidates: list[tuple[int, int, TexEnvBlock, str]] = []
    for b in env_blocks:
        if not _in_focus(b.start_idx):
            continue
        if not _env_matches(b.env, focus_set):
            continue
        label = _extract_first_label(flat_lines, b.start_idx, b.end_idx)
        has_label = 1 if label else 0
        # Priority: algorithm/code > theorem/proof > math.
        env_l = b.env.lower()
        prio = 2
        if any(env_l.startswith(x) for x in ("algorithm", "lstlisting", "minted")):
            prio = 0
        elif env_l in {"theorem", "lemma", "proposition", "corollary", "definition", "proof"}:
            prio = 1
        candidates.append((prio, -has_label, b, label))

    candidates.sort(key=lambda x: (x[0], x[1], x[2].start_idx))
    out: list[tuple[TexEnvBlock, str]] = []
    for _, _, b, label in candidates:
        out.append((b, label))
        if len(out) >= max_env_blocks:
            break
    return out


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tag", required=True, help="Round tag (e.g. D0-r1).")
    p.add_argument("--tex", type=Path, required=True, help="Main TeX file.")
    p.add_argument("--bib", type=Path, required=True, help="BibTeX file.")
    p.add_argument("--out", type=Path, required=True, help="Output packet path (Markdown).")
    p.add_argument(
        "--semantic-selection-json",
        type=Path,
        default=None,
        help="Optional structured semantic selection JSON for section adjudication.",
    )
    p.add_argument("--max-sections", type=int, default=0, help="Override focus section count (0 uses config/default).")
    p.add_argument("--max-section-chars", type=int, default=0, help="Override max chars per section slice (0 uses config/default).")
    p.add_argument("--max-env-blocks", type=int, default=0, help="Override env block count (0 uses config/default).")
    return p.parse_args()


def main() -> int:
    args = _parse_args()

    if not args.tex.is_file():
        print(f"[error] TeX file not found: {args.tex}", file=sys.stderr)
        return 2
    if not args.bib.is_file():
        print(f"[error] Bib file not found: {args.bib}", file=sys.stderr)
        return 2

    cfg = load_team_config(args.tex)
    root = args.tex.parent.resolve()
    if cfg.path is not None:
        root = cfg.path.parent.resolve()

    preflight_report = args.out.with_name(f"{args.tag}_draft_preflight.md")
    preflight_json = args.out.with_name(f"{args.tag}_draft_structure.json")

    dr = cfg.data.get("draft_review", {}) if isinstance(cfg.data.get("draft_review", {}), dict) else {}
    focus_sections_cfg = dr.get("focus_sections", ["methods", "results", "discussion"])
    if not isinstance(focus_sections_cfg, list):
        focus_sections_cfg = ["methods", "results", "discussion"]

    focus_envs_cfg = dr.get("focus_envs", ["auto"])
    if not isinstance(focus_envs_cfg, list):
        focus_envs_cfg = ["auto"]

    max_sections = int(args.max_sections or int(dr.get("max_sections", 6)))
    max_section_chars = int(args.max_section_chars or int(dr.get("max_section_chars", 12000)))
    max_env_blocks = int(args.max_env_blocks or int(dr.get("max_env_blocks", 25)))

    kb_base = "knowledge_base"
    kl = cfg.data.get("knowledge_layers", {})
    if isinstance(kl, dict):
        kb_base = str(kl.get("base_dir", kb_base)).strip() or kb_base

    bib_keys, bib_msgs = parse_bib_keys(args.bib)
    for msg in bib_msgs:
        print(msg, file=sys.stderr)

    flat, edges, flat_warnings = flatten_tex(args.tex)
    for w in flat_warnings:
        print(w, file=sys.stderr)

    cites, labels, refs, figs = extract_occurrences(flat)
    sections = extract_sections(flat)
    env_blocks, env_warnings = extract_env_blocks(flat)
    for w in env_warnings:
        print(w, file=sys.stderr)

    cite_keys = sorted({c.value for c in cites if c.value.strip()})
    missing_bib = sorted([k for k in cite_keys if k not in bib_keys])

    label_keys = {x.value for x in labels}
    ref_keys = sorted({x.value for x in refs})
    missing_labels = sorted([k for k in ref_keys if k not in label_keys])

    missing_kb: list[str] = []
    kb_links: list[str] = []
    for k in cite_keys:
        if "/" in k or "\\" in k:
            missing_kb.append(k)
            kb_links.append(f"- {k}: (invalid key for path mapping) (MISSING)\n")
            continue
        p = root / kb_base / "literature" / f"{k}.md"
        relp = _rel(root, p)
        if not p.is_file():
            missing_kb.append(k)
            kb_links.append(f"- {k}: [{relp}]({relp}) (MISSING)\n")
        else:
            kb_links.append(f"- {k}: [{relp}]({relp}) (ok)\n")

    ranked_section_ids, metrics, requested_intents = _rank_focus_section_ids(
        sections=sections,
        flat_lines=flat,
        env_blocks=env_blocks,
        focus_sections=[str(x) for x in focus_sections_cfg],
    )
    section_candidates, section_lookup = _build_section_candidates(
        sections=sections,
        ranked_ids=ranked_section_ids,
        metrics=metrics,
        flat_lines=flat,
        requested_intents=requested_intents,
        max_section_chars=max_section_chars,
        root=root,
    )
    selection_artifact = curate_candidates(
        selection_kind="draft_focus_sections",
        candidates=section_candidates,
        adjudication_path=args.semantic_selection_json.expanduser().resolve() if args.semantic_selection_json else None,
        max_primary=max_sections,
        fallback_count=max_sections,
    )
    structure_obj = _load_structure_map(preflight_json)
    structure_obj["semantic_selection"] = selection_artifact
    _write_structure_map(preflight_json, structure_obj)

    primary_section_ids = selection_artifact["render_plan"]["primary_candidate_ids"]
    focus_sections = [
        section_lookup[candidate_id]
        for candidate_id in primary_section_ids
        if candidate_id in section_lookup
    ]
    focus_sections.sort(key=lambda section: section.start_idx)
    focus_mode = str(selection_artifact["render_plan"]["mode"])

    if focus_mode == "candidate_fallback":
        primary_scan_label = "fallback candidate slices"
    elif focus_mode == "semantic_uncertain":
        primary_scan_label = "semantically uncertain slices"
    elif focus_mode == "semantic_selected":
        primary_scan_label = "semantic-selected slices"
    else:
        primary_scan_label = "focus slices"

    focus_env_blocks = _select_env_blocks(
        env_blocks=env_blocks,
        focus_sections=focus_sections,
        flat_lines=flat,
        focus_envs=[str(x) for x in focus_envs_cfg],
        max_env_blocks=max_env_blocks,
    )

    scan_lines: list[TexLine] = []
    seen_scan: set[tuple[str, int]] = set()
    for s in focus_sections:
        for tl in _slice_lines_with_meta(flat, s.start_idx, s.end_idx, max_section_chars):
            k = (str(tl.path), int(tl.line_no))
            if k in seen_scan:
                continue
            seen_scan.add(k)
            scan_lines.append(tl)
    for b, _label in focus_env_blocks:
        for tl in _slice_lines_with_meta(flat, b.start_idx, b.end_idx + 1, 6000):
            k = (str(tl.path), int(tl.line_no))
            if k in seen_scan:
                continue
            seen_scan.add(k)
            scan_lines.append(tl)

    prov_hits, unc_hits = _risk_scan(scan_lines, max_hits_per_kind=15)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append(f"# Draft Review Packet — {args.tag}\n\n")
    lines.append("## Scope\n")
    lines.append(
        "Focus on substantive issues: derivations, method correctness, results, and diagnostics. "
        "Treat purely formal issues as secondary unless they block correctness.\n\n"
    )
    lines.append("## Provenance\n")
    lines.append(f"- Generated at (UTC): {_utc_now()}\n")
    lines.append(f"- TeX: `{_rel(root, args.tex)}`\n")
    lines.append(f"- Bib: `{_rel(root, args.bib)}`\n")
    if cfg.path is not None:
        lines.append(f"- Config: `{_rel(root, cfg.path)}`\n")
    lines.append("\n## Deterministic Preflight Summary\n")
    # Clickable links: keep them out of backticks.
    lines.append(f"- Preflight report: [{preflight_report.name}]({preflight_report.name})\n")
    lines.append(f"- Preflight structure map (JSON): [{preflight_json.name}]({preflight_json.name})\n")
    prompts_readme = root / "prompts" / "README.md"
    if prompts_readme.is_file():
        href = os.path.relpath(prompts_readme.resolve(), start=args.out.parent.resolve()).replace(os.sep, "/")
        label = _rel(root, prompts_readme)
        lines.append(f"- Prompt files README: [{label}]({href})\n")
    lines.append(f"- Cited keys: {len(cite_keys)} (missing in bib: {len(missing_bib)})\n")
    lines.append(f"- Missing labels for refs: {len(missing_labels)} (WARN)\n")
    lines.append(f"- Missing KB literature notes: {len(missing_kb)} (WARN)\n")
    if missing_bib:
        lines.append("\n### FAIL (if running gate): missing BibTeX keys\n")
        for k in missing_bib:
            lines.append(f"- {k}\n")

    decision_lookup = {candidate["id"]: candidate["decision"] for candidate in selection_artifact["candidates"]}
    candidate_lookup = {candidate["id"]: candidate for candidate in selection_artifact["candidates"]}

    lines.append("\n## Semantic Focus Selection\n")
    lines.append(
        "Deterministic signals are used only to expand and rank candidate sections. "
        "Any semantic authority must come from the structured adjudication artifact below; when that artifact is unavailable or invalid, "
        "the packet falls back to an explicitly labeled candidate bundle instead of pretending a semantic hit.\n\n"
    )
    lines.append(f"- Requested intents: {', '.join(requested_intents)}\n")
    lines.append(f"- Candidate sections: {selection_artifact['counts']['candidates']}\n")
    lines.append(f"- Adjudicator mode: {selection_artifact['adjudicator']['mode']}\n")
    lines.append(f"- Adjudicator status: {selection_artifact['adjudicator']['status']}\n")
    if selection_artifact["adjudicator"]["source_path"]:
        lines.append(f"- Adjudication source: `{selection_artifact['adjudicator']['source_path']}`\n")
    if selection_artifact["adjudicator"]["parse_error"]:
        lines.append(f"- Parse/failure detail: {selection_artifact['adjudicator']['parse_error']}\n")
    lines.append(f"- Render plan: `{focus_mode}` ({len(primary_section_ids)} primary slices)\n")
    if focus_mode == "none":
        lines.append("- Primary slices: none (semantic adjudication explicitly rejected/omitted all candidates)\n")
    else:
        lines.append("\n### Primary slices\n")
        for candidate_id in primary_section_ids:
            candidate = candidate_lookup.get(candidate_id, {})
            decision = decision_lookup.get(candidate_id, {})
            tags = ", ".join(decision.get("semantic_tags", [])) if decision.get("semantic_tags") else "none"
            rationale = decision.get("rationale") or ""
            lines.append(
                f"- `{candidate.get('label', candidate_id)}` [{decision.get('status', 'abstained')}] "
                f"tags: {tags}; source: `{candidate.get('source', {}).get('path', '')}`\n"
            )
            if rationale:
                lines.append(f"  rationale: {rationale}\n")

    lines.append("\n## Provenance / Uncertainty Risk Scan (Deterministic; Heuristic)\n")
    lines.append(
        "This section flags lines in the included TeX slices that *look like* they discuss data provenance/sampling or uncertainty/weighting. "
        "It is heuristic (false positives/negatives possible). Reviewers must enforce the evidence gate.\n\n"
    )
    lines.append(
        f"- Scan scope: {primary_scan_label} + key environments (as included in this packet; truncated slices are scanned only up to the truncation limit).\n"
    )
    lines.append(f"- Provenance-like hits: {len(prov_hits)}\n")
    lines.append(f"- Uncertainty/weighting hits: {len(unc_hits)}\n")

    lines.append("\n### Provenance / sampling cues\n")
    if not prov_hits:
        lines.append("(none)\n")
    else:
        for h in prov_hits:
            src = f"{_rel(root, h.line.path)}:{h.line.line_no}"
            cite = ", ".join(h.cite_keys_inline) if h.cite_keys_inline else "none"
            lines.append(f"- `{src}`: {h.excerpt} (inline cite keys: {cite})\n")

    lines.append("\n### Uncertainty / weighting cues\n")
    if not unc_hits:
        lines.append("(none)\n")
    else:
        for h in unc_hits:
            src = f"{_rel(root, h.line.path)}:{h.line.line_no}"
            cite = ", ".join(h.cite_keys_inline) if h.cite_keys_inline else "none"
            lines.append(f"- `{src}`: {h.excerpt} (inline cite keys: {cite})\n")

    lines.append("\n## KB Literature Notes (Expected)\n")
    lines.extend(kb_links)

    if focus_sections:
        title_lookup = {
            "semantic_selected": "## Focus Slices (semantic-selected)\n",
            "semantic_uncertain": "## Focus Slices (semantic-uncertain)\n",
            "candidate_fallback": "## Focus Slices (candidate fallback)\n",
        }
        lines.append("\n" + title_lookup.get(focus_mode, "## Focus Slices\n"))
        lines.append(
            "Deterministic signals only propose candidates. The included slices are governed by the render plan recorded in "
            f"`{preflight_json.name}`.\n\n"
        )
        for i, s in enumerate(focus_sections, start=1):
            src = f"{_rel(root, s.path)}:{s.line_no}"
            title = s.title or "(untitled)"
            candidate_id = next(
                (
                    item_id
                    for item_id, section in section_lookup.items()
                    if (section.path, section.line_no) == (s.path, s.line_no)
                ),
                "",
            )
            decision = decision_lookup.get(candidate_id, {})
            candidate = candidate_lookup.get(candidate_id, {})
            tags = ", ".join(decision.get("semantic_tags", [])) if decision.get("semantic_tags") else "none"
            rationale = decision.get("rationale") or ""
            lines.append(f"### Slice {i}: {title}\n")
            lines.append(f"- Source: `{src}`\n")
            lines.append(f"- Selection status: `{decision.get('status', 'abstained')}`\n")
            lines.append(f"- Semantic tags: {tags}\n")
            if rationale:
                lines.append(f"- Why surfaced: {rationale}\n")
            else:
                lines.append(
                    f"- Why surfaced: fallback candidate rank {candidate.get('deterministic_hints', {}).get('fallback_rank', '?')} "
                    "(semantic adjudication unavailable or abstained)\n"
                )
            lines.append("\n")
            snippet = slice_flat_lines(flat, s.start_idx, s.end_idx, max_chars=max_section_chars)
            lines.append("```tex\n")
            lines.append(snippet.rstrip() + "\n")
            lines.append("```\n\n")
    else:
        lines.append("\n## Focus Slices\n")
        if focus_mode == "none":
            lines.append("[warn] semantic adjudication yielded no primary slices; inspect `semantic_selection` in the structure JSON.\n")
        else:
            lines.append("[warn] no TeX section markers detected; consider adding \\section{...} or provide manual excerpting.\n")

    if focus_env_blocks:
        lines.append("## Key Environments (math/algorithm)\n")
        lines.append(
            "These are extracted from within the focus slices to ensure reviewers see core derivations/algorithms even if slices are truncated.\n\n"
        )
        for i, (b, label) in enumerate(focus_env_blocks, start=1):
            start_src = f"{_rel(root, b.path)}:{b.start_line_no}"
            end_src = f"{_rel(root, b.end_path)}:{b.end_line_no}"
            label_s = f", label={label}" if label else ""
            lines.append(f"### Env {i}: {b.env}{label_s}\n")
            lines.append(f"- Span: `{start_src}` → `{end_src}`\n\n")
            snippet = slice_flat_lines(flat, b.start_idx, b.end_idx + 1, max_chars=6000)
            lines.append("```tex\n")
            lines.append(snippet.rstrip() + "\n")
            lines.append("```\n\n")

    args.out.write_text("".join(lines), encoding="utf-8")
    print(f"[ok] wrote draft packet: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
