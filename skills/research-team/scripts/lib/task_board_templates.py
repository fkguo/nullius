#!/usr/bin/env python3
"""
Shared, deterministic Task Board templates for research_plan.md.

Goal:
- Improve task decomposition quality (profile-aware).
- Ensure knowledge_base expansion is a first-class task across all profiles.

These templates are used by:
- auto_fill_research_plan.py (deterministic plan)
- autopilot_loop.py (_ensure_task_board fallback injection)
"""

from __future__ import annotations


def normalize_profile(profile: str) -> str:
    p = (profile or "").strip().lower()
    return p or "mixed"


def default_task_board_lines(profile: str) -> list[str]:
    p = normalize_profile(profile)

    kb_task = (
        "(manual) KB expansion beyond initial instruction: run scholarly discovery (INSPIRE/arXiv/Crossref/DataCite/GitHub/Scholar/etc.) as needed; "
        "log queries/selection in [literature_queries.md](knowledge_base/methodology_traces/literature_queries.md); "
        "stabilize final citations to stable anchors (DOI/arXiv/INSPIRE/Zenodo/SWH); "
        "add/update KB notes (literature/methodology_traces/priors) + update `## References`; rerun preflight-only"
    )

    # Keep ordering deterministic and small (3–4 tasks). Tasks MUST mention the required team-cycle step.
    if p == "toolkit_extraction":
        return [
            "- [ ] T1: (manual) Toolkit framing: define reusable modules + API boundary; create/update [TOOLKIT_API.md](TOOLKIT_API.md); fill milestone Toolkit delta; run preflight-only",
            f"- [ ] T2: {kb_task}",
            "- [ ] T3: (auto) Extract/implement at least 1 reusable module under [src/](src/) or [toolkit/](toolkit/) + a nontrivial audit proxy; run full team cycle and converge",
        ]

    if p == "literature_review":
        return [
            "- [ ] T1: (manual) Build PREWORK coverage matrix; run constrained literature search beyond initial; create KB literature notes + update `## References`; run preflight-only",
            "- [ ] T2: (auto) Write structured synthesis in [research_contract.md](research_contract.md) with citations; extract reusable priors/method notes; run full team cycle and converge",
            f"- [ ] T3: {kb_task}",
        ]

    if p == "methodology_dev":
        return [
            "- [ ] T1: (manual) Method selection (no brute force): list candidate methods + tradeoffs in a new methodology trace; choose one with justification; run preflight-only",
            f"- [ ] T2: {kb_task}",
            "- [ ] T3: (auto) Prototype minimal implementation + audit proxy headline(s); run full team cycle and converge",
        ]

    if p == "numerics_only":
        return [
            "- [ ] T1: (auto) Define quantities + proxy headlines; fill capsule + audit slices; run preflight-only",
            "- [ ] T2: (manual) Algorithm/method search (no brute force): record candidates + selection rationale in a methodology trace; update `## References`; rerun preflight-only",
            "- [ ] T3: (auto) Implement numerics + produce nontrivial proxy headline(s) from artifacts; run full team cycle and converge",
        ]

    if p == "theory_only":
        return [
            "- [ ] T1: (auto) Convert initial instruction -> explicit scope/claims; fill capsule (Milestone kind: theory) + excerpt; run preflight-only",
            f"- [ ] T2: {kb_task}",
            "- [ ] T3: (auto) Write step-by-step derivation (no skipped steps) + limiting checks; run full team cycle and converge",
        ]

    if p == "exploratory":
        return [
            "- [ ] T1: (manual) Define scope + kill criteria + minimal diagnostics; run preflight-only",
            f"- [ ] T2: {kb_task}",
            "- [ ] T3: (auto) Run a quick prototype/diagnostic + record results; run full team cycle and converge (or stop with explicit kill decision)",
        ]

    # Default: mixed (theory + numerics).
    return [
        "- [ ] T1: (auto) Convert initial instruction -> explicit scope/claims; update [research_contract.md](research_contract.md) capsule + excerpt; run preflight-only",
        f"- [ ] T2: {kb_task}",
        "- [ ] T3: (auto) Draft core derivation/computation + at least one nontrivial audit slice; run full team cycle and converge",
    ]
