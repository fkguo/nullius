#!/usr/bin/env python3
"""
distill_discussion_logic.py

Deterministically distill *consensus vs disagreements* across dual-model
discussion-logic outputs produced by:

  - scripts/bin/research_writer_learn_discussion_logic.py

Input:
  <run_dir>/packs/*/{claude,gemini}.md

Output (written under <run_dir>/distill/):
  - CONSENSUS.md
  - DISAGREEMENTS.md
  - STATS.json

Notes:
- No embeddings, no network. This is a keyword/tag heuristic intended to be
  stable and auditable.
- This tool does NOT update the playbook automatically. The agent/human merges
  selected patterns into `assets/style/physics_discussion_logic_playbook.md`.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _normalize_for_match(text: str) -> str:
    # Deterministic normalization for keyword matching.
    text = text.lower()
    text = text.replace("\u2013", "-").replace("\u2014", "-").replace("\u2212", "-")
    text = re.sub(r"[^a-z0-9_\-\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _strip_evidence_clause(text: str) -> str:
    # Common format: "MOVE: ... | Evidence: <section>"
    text = re.sub(r"^\s*move\s*:\s*", "", text, flags=re.I)
    text = re.sub(r"\|\s*evidence\s*:\s*.*$", "", text, flags=re.I)
    return text.strip()


def _split_sections(md: str) -> dict[str, str]:
    """
    Best-effort Markdown section splitter on "## " headings.
    Returns {heading_text: section_body_text}.
    """
    lines = md.splitlines()
    out: dict[str, list[str]] = {}
    cur = None
    for ln in lines:
        m = re.match(r"^##\s+(.*)$", ln.strip())
        if m:
            cur = m.group(1).strip()
            out.setdefault(cur, [])
            continue
        if cur is not None:
            out[cur].append(ln)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def _extract_bullets(section_body: str) -> list[str]:
    """
    Extract list items from a section body. Supports simple multi-line bullets:
    continuation lines that are indented are appended.
    """
    bullets: list[str] = []
    cur: str | None = None
    for ln in section_body.splitlines():
        m = re.match(r"^\s*(?:[-*]|\d+\.)\s+(.*)$", ln)
        if m:
            if cur is not None:
                bullets.append(cur.strip())
            cur = m.group(1).strip()
            continue
        if cur is not None and (ln.startswith("  ") or ln.startswith("\t")):
            cur = (cur + " " + ln.strip()).strip()
    if cur is not None:
        bullets.append(cur.strip())
    return [b for b in bullets if b]


@dataclass(frozen=True)
class TagRule:
    tag: str
    label: str
    description: str
    keywords: tuple[str, ...]


_TAG_RULES: tuple[TagRule, ...] = (
    TagRule(
        tag="question_observable",
        label="Define observable / question",
        description="States the physical question, target observable, kinematics, or conventions.",
        keywords=("observable", "quantity", "what is being", "we study", "we consider", "kinematic", "convention", "define"),
    ),
    TagRule(
        tag="gap_tension_precision",
        label="Name gap/tension/precision target",
        description="Motivates via a gap, tension, discrepancy, or precision target.",
        keywords=("gap", "tension", "discrepanc", "puzzle", "precision", "target", "motivat", "open question"),
    ),
    TagRule(
        tag="mechanism_constraint",
        label="Mechanism or constraint first",
        description="Highlights the controlling physics (analyticity, unitarity, symmetry, EFT, thresholds, etc.).",
        keywords=(
            "mechanism",
            "constraint",
            "analyticit",
            "unitarit",
            "symmetr",
            "eft",
            "threshold",
            "dispers",
            "sum rule",
            "ope",
            "factorization",
            "rg",
            "matching",
        ),
    ),
    TagRule(
        tag="approach_formalism",
        label="Approach / formalism / representation",
        description="Explains the chosen formalism, representation, model family, or computational approach.",
        keywords=("formalism", "framework", "representation", "approach", "method", "parametr", "model", "ansatz"),
    ),
    TagRule(
        tag="inputs_vs_assumptions",
        label="Separate inputs vs assumptions",
        description="Distinguishes data/inputs from modeling assumptions or approximations.",
        keywords=("input", "assumption", "approximation", "model depend", "prior", "fit", "lecs", "lattice", "data"),
    ),
    TagRule(
        tag="headline_numbers_uncertainty",
        label="Headline numbers + uncertainties",
        description="States headline numerical results with uncertainties and interprets their meaning.",
        keywords=("we obtain", "we find", "result", "value", "uncertaint", "error", "sigma", "dominant"),
    ),
    TagRule(
        tag="error_budget_hierarchy",
        label="Error budget / hierarchy",
        description="Structures uncertainties as an error budget or hierarchy of dominant sources.",
        keywords=("error budget", "uncertainty budget", "dominant uncertainty", "subleading", "systematic", "statistical"),
    ),
    TagRule(
        tag="robustness_variations",
        label="Robustness via variations",
        description="Uses targeted variations/stability checks (cutoffs, windows, scales) to diagnose systematics.",
        keywords=("robust", "stability", "vary", "variation", "scan", "window", "cutoff", "range", "stress test"),
    ),
    TagRule(
        tag="diagnostics_limits_scaling",
        label="Diagnostics: limits / scaling / sum rules",
        description="Uses diagnostic limits, scaling, sum rules, consistency checks, or baselines/counterfactuals.",
        keywords=("diagnostic", "limit", "scaling", "sum rule", "consistency", "cross-check", "baseline", "counterfactual"),
    ),
    TagRule(
        tag="scheme_scale_conventions",
        label="Scheme/scale conventions",
        description="Makes scheme/scale conventions explicit; treats scale dependence as a diagnostic.",
        keywords=("scheme", "renormal", "scale", "mu", "running", "cancel", "dependence"),
    ),
    TagRule(
        tag="comparison_literature_data",
        label="Comparison to literature/data",
        description="Compares to prior work and/or data, attributing differences to specific ingredients.",
        keywords=("compare", "agreement", "literature", "previous", "prior work", "data", "experiment", "measurement"),
    ),
    TagRule(
        tag="shift_attribution",
        label="Attribute shifts (what changed and why)",
        description="Explains why results shift relative to baselines by isolating changed inputs/assumptions.",
        keywords=("shift", "driven by", "due to", "origin", "comes from", "explained by", "difference"),
    ),
    TagRule(
        tag="limitations_missing_effects",
        label="Limitations / missing effects",
        description="Names limitations, missing channels/effects, and bounds their impact for the claim.",
        keywords=("limitation", "missing", "neglect", "subleading", "future work", "systematics remain"),
    ),
    TagRule(
        tag="predictions_outlook_tests",
        label="Predictions / outlook / actionable tests",
        description="Concludes with predictions/implications and what to test/compute next.",
        keywords=("prediction", "outlook", "future", "test", "measurement", "lattice computation", "implication"),
    ),
    TagRule(
        tag="triangulation_multiple_routes",
        label="Triangulation (independent routes)",
        description="Triangulates via two conceptually different methods/representations; treats spread as systematic.",
        keywords=("triangulat", "independent", "two methods", "alternative", "cross-validation", "two routes"),
    ),
    TagRule(
        tag="data_vs_extraction",
        label="Separate data from extraction",
        description="Distinguishes raw measurements from model-dependent extractions/interpretations.",
        keywords=("raw data", "extraction", "model-dependent", "parametrization dependence", "unfold", "fit model"),
    ),
    TagRule(
        tag="global_consistency",
        label="Global consistency / multi-observable logic",
        description="Uses multiple observables/constraints to test global consistency; localizes tensions.",
        keywords=("global", "consistent", "multi-observable", "combined", "simultaneous", "constraint set"),
    ),
    TagRule(
        tag="sensitivity_what_matters",
        label="Sensitivity: what matters most",
        description="Connects results to most sensitive inputs/assumptions; prioritizes high-leverage improvements.",
        keywords=("sensitive", "dominates", "what matters", "leverage", "drives", "controls"),
    ),
)


def _classify_statements(statements: list[str]) -> set[str]:
    tags: set[str] = set()
    for raw in statements:
        s = _strip_evidence_clause(raw)
        s_norm = _normalize_for_match(s)
        if not s_norm:
            continue
        for rule in _TAG_RULES:
            if any(k in s_norm for k in rule.keywords):
                tags.add(rule.tag)
    return tags


def _extract_tags_from_model_output(md: str) -> dict[str, Any]:
    sections = _split_sections(md)
    required = ("Moves (Bullets)", "Diagnostics & Uncertainties", "Reusable General Lessons")
    missing_required = [h for h in required if h not in sections]

    moves = _extract_bullets(sections.get("Moves (Bullets)", ""))
    diags = _extract_bullets(sections.get("Diagnostics & Uncertainties", ""))
    lessons = _extract_bullets(sections.get("Reusable General Lessons", ""))

    statements = moves + diags + lessons
    tags = _classify_statements(statements)

    return {
        "missing_required_sections": missing_required,
        "n_moves": len(moves),
        "n_diags": len(diags),
        "n_lessons": len(lessons),
        "tags": sorted(tags),
    }


def _render_tag_table(defs: list[TagRule]) -> str:
    lines: list[str] = []
    lines.append("| tag | label | description |")
    lines.append("|---|---|---|")
    for r in defs:
        lines.append(f"| `{r.tag}` | {r.label} | {r.description} |")
    return "\n".join(lines)


def _render_stats_table(rows: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    lines.append("| tag | both | either | both/dual | agreement(both/either) | claude_only | gemini_only | examples |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---|")
    for r in rows:
        ex = ", ".join(r.get("examples_both") or [])
        lines.append(
            "| `{tag}` | {both} | {either} | {both_over_dual:.3f} | {agreement:.3f} | {claude_only} | {gemini_only} | {examples} |".format(
                tag=r["tag"],
                both=int(r["both"]),
                either=int(r["either"]),
                both_over_dual=float(r["both_over_dual"]),
                agreement=float(r["agreement"]),
                claude_only=int(r["claude_only"]),
                gemini_only=int(r["gemini_only"]),
                examples=ex,
            )
        )
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", required=True, type=Path, help="Discussion-logic run dir (contains packs/*).")
    ap.add_argument("--top", type=int, default=12, help="Max rows to show in each Markdown report.")
    ap.add_argument("--examples", type=int, default=6, help="Number of example paper IDs to show per tag.")
    ap.add_argument("--strict", action="store_true", help="Fail if any dual outputs are missing or sections are malformed.")
    ap.add_argument(
        "--include-timestamp",
        action="store_true",
        help="Include generation timestamps in outputs. Default is deterministic (no timestamps).",
    )
    args = ap.parse_args()

    run_dir = args.out_dir.expanduser().resolve()
    packs_dir = run_dir / "packs"
    if not packs_dir.is_dir():
        raise SystemExit(f"ERROR: packs dir not found: {packs_dir}")

    per_paper: dict[str, dict[str, Any]] = {}
    missing_claude: list[str] = []
    missing_gemini: list[str] = []
    malformed: list[dict[str, Any]] = []

    pack_ids = sorted([p.name for p in packs_dir.iterdir() if p.is_dir()])
    for pid in pack_ids:
        pd = packs_dir / pid
        c_path = pd / "claude.md"
        g_path = pd / "gemini.md"
        c_obj: dict[str, Any] | None = None
        g_obj: dict[str, Any] | None = None

        if c_path.is_file():
            c_md = _read_text(c_path)
            if not c_md.strip():
                missing_claude.append(pid)
            else:
                c_obj = _extract_tags_from_model_output(c_md)
                if c_obj["missing_required_sections"]:
                    malformed.append({"paper_id": pid, "model": "claude", "missing_sections": c_obj["missing_required_sections"]})
        else:
            missing_claude.append(pid)

        if g_path.is_file():
            g_md = _read_text(g_path)
            if not g_md.strip():
                missing_gemini.append(pid)
            else:
                g_obj = _extract_tags_from_model_output(g_md)
                if g_obj["missing_required_sections"]:
                    malformed.append({"paper_id": pid, "model": "gemini", "missing_sections": g_obj["missing_required_sections"]})
        else:
            missing_gemini.append(pid)

        per_paper[pid] = {
            "paper_id": pid,
            "claude": c_obj,
            "gemini": g_obj,
        }

    total = len(pack_ids)
    n_claude = total - len(missing_claude)
    n_gemini = total - len(missing_gemini)
    dual_ids = sorted([pid for pid in pack_ids if pid not in set(missing_claude) and pid not in set(missing_gemini)])
    dual = len(dual_ids)

    # Aggregate tag stats (papers as unit).
    stats_by_tag: dict[str, dict[str, Any]] = {}
    for rule in _TAG_RULES:
        stats_by_tag[rule.tag] = {
            "tag": rule.tag,
            "label": rule.label,
            "both": 0,
            "either": 0,
            "claude_only": 0,
            "gemini_only": 0,
            "examples_both": [],
            "examples_claude_only": [],
            "examples_gemini_only": [],
        }

    for pid in dual_ids:
        c_tags = set(per_paper[pid]["claude"]["tags"]) if per_paper[pid]["claude"] else set()
        g_tags = set(per_paper[pid]["gemini"]["tags"]) if per_paper[pid]["gemini"] else set()
        union = c_tags | g_tags
        inter = c_tags & g_tags
        for tag in union:
            s = stats_by_tag.get(tag)
            if s is None:
                continue
            s["either"] += 1
            if tag in inter:
                s["both"] += 1
                if len(s["examples_both"]) < int(args.examples):
                    s["examples_both"].append(pid)
            elif tag in c_tags:
                s["claude_only"] += 1
                if len(s["examples_claude_only"]) < int(args.examples):
                    s["examples_claude_only"].append(pid)
            else:
                s["gemini_only"] += 1
                if len(s["examples_gemini_only"]) < int(args.examples):
                    s["examples_gemini_only"].append(pid)

    # Derived ratios.
    rows: list[dict[str, Any]] = []
    for tag, s in stats_by_tag.items():
        either = int(s["either"])
        both = int(s["both"])
        both_over_dual = (both / dual) if dual else 0.0
        agreement = (both / either) if either else 0.0
        rows.append(
            {
                "tag": tag,
                "label": s["label"],
                "both": both,
                "either": either,
                "claude_only": int(s["claude_only"]),
                "gemini_only": int(s["gemini_only"]),
                "both_over_dual": both_over_dual,
                "agreement": agreement,
                "examples_both": list(sorted(s["examples_both"])),
                "examples_claude_only": list(sorted(s["examples_claude_only"])),
                "examples_gemini_only": list(sorted(s["examples_gemini_only"])),
            }
        )

    # Consensus: prioritize high both count; tie-breaker by agreement then tag.
    consensus_rows = sorted(rows, key=lambda r: (-int(r["both"]), -float(r["agreement"]), r["tag"]))
    consensus_rows = [r for r in consensus_rows if int(r["both"]) > 0][: int(args.top)]

    # Disagreements: prioritize asymmetry, then total one-sided mentions.
    dis_rows = []
    for r in rows:
        delta = abs(int(r["claude_only"]) - int(r["gemini_only"]))
        one_sided = int(r["claude_only"]) + int(r["gemini_only"])
        if one_sided <= 0:
            continue
        dis_rows.append({**r, "delta": delta, "one_sided": one_sided})
    dis_rows = sorted(dis_rows, key=lambda r: (-int(r["delta"]), -int(r["one_sided"]), r["tag"]))[: int(args.top)]

    distill_dir = run_dir / "distill"
    distill_dir.mkdir(parents=True, exist_ok=True)

    # STATS.json (SSOT for downstream tooling).
    generated_at = _utc_now() if bool(args.include_timestamp) else None
    stats_obj = {
        **({"generated_at": generated_at} if generated_at else {}),
        "run_dir": str(run_dir),
        "packs_dir": str(packs_dir),
        "total_packs": total,
        "has_claude": n_claude,
        "has_gemini": n_gemini,
        "dual_available": dual,
        "missing_claude": list(missing_claude),
        "missing_gemini": list(missing_gemini),
        "malformed_outputs": malformed,
        "tag_stats": sorted(rows, key=lambda r: r["tag"]),
    }
    _write_json(distill_dir / "STATS.json", stats_obj)

    # CONSENSUS.md
    con_lines: list[str] = []
    con_lines.append("# Distilled discussion-logic patterns — CONSENSUS (dual-model)")
    con_lines.append("")
    if generated_at:
        con_lines.append(f"- Generated: `{generated_at}`")
    con_lines.append(f"- Run: `{run_dir}`")
    con_lines.append(f"- Packs: `{total}` | Dual available: `{dual}` | Claude: `{n_claude}` | Gemini: `{n_gemini}`")
    con_lines.append("")
    con_lines.append("## Tag definitions (heuristic, deterministic)")
    con_lines.append(_render_tag_table(list(_TAG_RULES)))
    con_lines.append("")
    con_lines.append("## Top consensus tags (papers where *both* models mention the tag)")
    if consensus_rows:
        con_lines.append(_render_stats_table(consensus_rows))
    else:
        con_lines.append("(none)")
    con_lines.append("")
    con_lines.append("## Normalization rules (for auditability)")
    con_lines.append("- Lowercase; strip non-alphanumerics; collapse whitespace.")
    con_lines.append("- Strip `MOVE:` prefix and remove `| Evidence: ...` suffix before matching.")
    con_lines.append("- Tags are assigned by keyword substrings (see Tag definitions).")
    _write_text(distill_dir / "CONSENSUS.md", "\n".join(con_lines))

    # DISAGREEMENTS.md
    dis_lines: list[str] = []
    dis_lines.append("# Distilled discussion-logic patterns — DISAGREEMENTS (dual-model)")
    dis_lines.append("")
    if generated_at:
        dis_lines.append(f"- Generated: `{generated_at}`")
    dis_lines.append(f"- Run: `{run_dir}`")
    dis_lines.append(f"- Packs: `{total}` | Dual available: `{dual}`")
    dis_lines.append("")
    dis_lines.append("## Tags with largest asymmetry (Claude-only vs Gemini-only presence)")
    if dis_rows:
        dis_lines.append("| tag | claude_only | gemini_only | delta | examples_claude_only | examples_gemini_only |")
        dis_lines.append("|---|---:|---:|---:|---|---|")
        for r in dis_rows:
            ex_c = ", ".join(r.get("examples_claude_only") or [])
            ex_g = ", ".join(r.get("examples_gemini_only") or [])
            dis_lines.append(
                "| `{tag}` | {c} | {g} | {d} | {ex_c} | {ex_g} |".format(
                    tag=r["tag"],
                    c=int(r["claude_only"]),
                    g=int(r["gemini_only"]),
                    d=int(r["delta"]),
                    ex_c=ex_c,
                    ex_g=ex_g,
                )
            )
    else:
        dis_lines.append("(none)")
    dis_lines.append("")
    dis_lines.append("## Missing or malformed outputs")
    dis_lines.append(f"- Missing Claude outputs: `{len(missing_claude)}`")
    dis_lines.append(f"- Missing Gemini outputs: `{len(missing_gemini)}`")
    dis_lines.append(f"- Malformed outputs (missing required sections): `{len(malformed)}`")
    if missing_claude:
        dis_lines.append(f"  - Example missing Claude: `{', '.join(missing_claude[: min(10, len(missing_claude))])}`")
    if missing_gemini:
        dis_lines.append(f"  - Example missing Gemini: `{', '.join(missing_gemini[: min(10, len(missing_gemini))])}`")
    if malformed:
        ex = malformed[: min(10, len(malformed))]
        dis_lines.append("  - Example malformed entries (first 10):")
        for e in ex:
            dis_lines.append(f"    - `{e['paper_id']}` ({e['model']}): missing {e['missing_sections']}")
    _write_text(distill_dir / "DISAGREEMENTS.md", "\n".join(dis_lines))

    if args.strict:
        if missing_claude or missing_gemini or malformed:
            raise SystemExit("ERROR: strict mode failed due to missing/malformed outputs (see distill/STATS.json).")

    print("[ok] distilled discussion-logic stats written")
    print(f"- distill dir: {distill_dir}")
    print(f"- consensus:   {distill_dir / 'CONSENSUS.md'}")
    print(f"- disagreements: {distill_dir / 'DISAGREEMENTS.md'}")
    print(f"- stats:       {distill_dir / 'STATS.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
