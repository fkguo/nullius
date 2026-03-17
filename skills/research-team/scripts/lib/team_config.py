#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_CONFIG: dict = {
    "version": 1,
    "mode": "theory_numerics",
    # Profile is a domain-neutral "research mode" that controls which requirements are applicable.
    # If omitted in a project's config file, it is derived from `mode` via a conservative mapping.
    "profile": "mixed",
    # Project stage controls strictness of some contracts.
    # - exploration: allow minimal contracts; record warnings/debt rather than fail-fast (where supported)
    # - development: default strictness for serious work
    # - publication: future: most gates should be fail-fast
    "project_stage": "development",
    # Scaffold variant hint (purely informational; used by scaffold contract checks).
    # - full: scaffold created optional wrappers/prompts/scaffolds
    # - minimal: scaffold created only core docs+config+2-member review prompts
    "scaffold_variant": "minimal",
    # Review access mode:
    # - packet_only: members must use only the team packet content (default for backward compatibility)
    # - full_access: members may request file reads / command runs / network fetches via the leader proxy,
    #   and all accesses are logged to per-member evidence JSON for third-party audit.
    "review_access_mode": "packet_only",
    # Isolation strategy for full_access mode (best-effort; enforced by proxy + evidence gates):
    # - separate_worktrees: prefer running each member in an isolated git worktree when possible
    # - sequential_with_acl: run sequentially and deny reading the other member outputs (best-effort)
    "isolation_strategy": "separate_worktrees",
    "features": {
        "capsule_gate": True,
        # Project charter / goal contract (default ON; prevents goal drift across all profiles).
        "project_charter_gate": True,
        # Navigation front door (project_index.md) to prevent "file swamp" confusion.
        "project_map_gate": True,
        # Optional HEP provider bundle: require .hep/workspace.json only when the project explicitly enables HEP tooling.
        "hep_workspace_gate": False,
        "scan_dependency_gate": True,
        "branch_semantics_gate": True,
        "pointer_lint_gate": True,
        "references_gate": False,
        "literature_trace_gate": False,
        "notebook_integrity_gate": False,
        # Global Markdown math hygiene gate (scan key docs + knowledge_base for rendering hazards).
        "markdown_math_hygiene_gate": True,
        # Markdown math portability warnings (renderer-agnostic): e.g. table pipes inside $...$; \slashed.
        "markdown_math_portability_gate": True,
        # Global "double-backslash in math" hygiene gate (scan key docs + knowledge_base; common TOC/LLM over-escape hazard).
        "double_backslash_math_gate": True,
        # Global Markdown link hygiene gate (scan key docs + knowledge_base; enforce clickable KB pointers).
        "markdown_link_hygiene_gate": True,
        # Global LaTeX macro hygiene gate (scan key docs + knowledge_base; forbid custom macros like \Rc).
        "latex_macro_hygiene_gate": True,
        "research_plan_gate": False,
        "agents_anchor_gate": False,
        "milestone_dod_gate": False,
        "knowledge_layers_gate": False,
        "packet_completeness_gate": False,
        # Problem Framing Snapshot in research_preflight.md (Problem Interpretation + P/D separation + sequential review).
        "problem_framing_snapshot_gate": False,
        "trajectory_index": True,
        # Claim DAG (knowledge_graph/) gates (disabled by default; enable per project).
        "claim_graph_gate": False,
        "evidence_manifest_gate": False,
        "claim_trajectory_link_gate": False,
        # Real-research team-cycle evidence gates (default off; enable per project).
        "evidence_schema_gate": False,
        "clean_room_gate": False,
        "logic_isolation_gate": False,
        "independent_reproduction_gate": False,
        "convention_mapping_gate": False,
    },
    "claim_graph": {
        "base_dir": "knowledge_graph",
    },
    "claim_graph_render": {
        "enabled": False,
        "format": "png",
    },
    "pointer_lint": {
        "strategy": "python_import",
        "allow_skip_unimportable": True,
        "env_import_cmd_var": "RESEARCH_TEAM_IMPORT_CMD",
    },
    "scan_dependency": {"require_rules_file_when_scan_detected": False},
    "branch_semantics": {"require_when_declared": True},
    "knowledge_layers": {
        "base_dir": "knowledge_base",
        "require_min_methodology_traces": 1,
        "require_min_literature": 0,
        "require_min_priors": 0,
        "allow_none": True,
    },
    "references": {
        "allowed_external_hosts_extra": [],
    },
    "logic_isolation": {
        "_note": "Independent reproduction scripts may only import these local project roots (default: shared_utils/toolkit).",
        "allowed_local_import_roots": ["shared_utils", "toolkit"],
    },
    "convention_mapping": {
        "_note": "Set required=true when a run depends on cross-paper/module normalization mappings (enables convention_mapping_gate enforcement).",
        "required": False,
    },
    "markdown_math_hygiene": {
        "_note": "Deterministic scan targets for Markdown math hygiene gate (paths/globs relative to project root).",
        "targets": [
            "research_notebook.md",
            "research_contract.md",
            "research_preflight.md",
            "research_plan.md",
            "project_charter.md",
            "project_index.md",
            "knowledge_base/**/*.md",
        ],
        "exclude_globs": [],
    },
    "markdown_math_portability": {
        "_note": "Warn (default) on renderer-fragile math patterns in Markdown (domain-neutral).",
        "_note2": "Table policy: avoid literal '|' inside $...$ in Markdown tables; use \\lvert/\\rvert or \\lVert/\\rVert. Macro policy: prefer avoiding \\slashed in Markdown; use \\not\\! fallback if needed.",
        "targets": [
            "research_notebook.md",
            "research_contract.md",
            "research_preflight.md",
            "research_plan.md",
            "project_charter.md",
            "project_index.md",
            "knowledge_base/**/*.md",
        ],
        "exclude_globs": [],
        "enforce_table_math_pipes": False,
        "enforce_slashed": False,
    },
    "markdown_link_hygiene": {
        "_note": "Deterministic scan targets for Markdown link hygiene gate (paths/globs relative to project root).",
        "targets": [
            "research_notebook.md",
            "research_contract.md",
            "research_preflight.md",
            "research_plan.md",
            "project_charter.md",
            "project_index.md",
            "knowledge_base/**/*.md",
        ],
        "exclude_globs": [],
    },
    "latex_macro_hygiene": {
        "_note": "Disallow project-specific LaTeX macros in Markdown (rendering-safety). Prefer explicit forms like \\mathcal{R}.",
        "targets": [
            "research_notebook.md",
            "research_contract.md",
            "research_preflight.md",
            "research_plan.md",
            "project_charter.md",
            "project_index.md",
            "knowledge_base/**/*.md",
        ],
        "exclude_globs": [],
        "_note_forbidden_macros": "Macro names without leading backslash. Gate flags occurrences like \\Rc and suggests expansions.",
        "forbidden_macros": ["Rc", "Mc", "Cc", "cK", "re", "im"],
        "_note_expansions": "Deterministic macro expansions used by fix_markdown_latex_macros.py.",
        "expansions": {
            "Rc": "{\\mathcal{R}}",
            "Mc": "{\\mathcal{M}}",
            "Cc": "{\\mathcal{C}}",
            "cK": "{\\mathcal{K}}",
            "re": "{\\operatorname{Re}}",
            "im": "{\\operatorname{Im}}",
        },
    },
    "capsule": {
        "min_headline_numbers": 3,
        "min_nontrivial_headlines": 1,
        "nontrivial_tiers": ["T2", "T3"],
        "exploration_minimal": {
            "enabled": True,
            "min_headline_numbers": 0,
            "min_nontrivial_headlines": 0,
            "min_outputs": 1,
            "require_outputs_exist": True,
            "require_data_artifact": False,
            "require_figure_artifact": False,
            "require_figure_embed": False,
            "relax_env_and_sources": True,
        },
    },
    "plan_tracking": {
        "enabled": False,
        "require_task_board": False,
        "require_progress_log": False,
        "log_on_fail": False,
    },
    "sidecar_review": {
        "enabled": False,
        "runner": "claude",
        "model": "sonnet",
        "system_prompt": "prompts/_system_member_c_numerics.txt",
        "output_format": "text",
        "tag_suffix": "member_c",
        "timeout_secs": 180,
    },
    "member_b": {
        "_note": "Member B runner selection (used by scripts/bin/run_team_cycle.sh).",
        "runner_kind": "gemini",
        "_runner_kind_options": ["gemini", "claude", "auto"],
        "_note_runner_kind": "auto tries gemini first and falls back to claude when gemini is unavailable.",
        # Optional alternate system prompt file for Claude runner. If empty, Member B uses the default `--member-b-system`.
        "claude_system_prompt": "",
    },
    # Optional reviewer swarm: additional non-blocking sidecar reviews.
    # If non-empty, `sidecar_reviews` overrides `sidecar_review`.
    "sidecar_reviews": [],
    "draft_review": {
        "require_convergence": False,
        "leader_system_prompt": "prompts/_system_draft_member_c_leader.txt",
        "focus_sections": ["methods", "results", "physics"],
        "focus_envs": ["auto"],
        "max_sections": 6,
        "max_section_chars": 12000,
        "max_env_blocks": 25,
    },
    "language": {
        "pass_tokens": ["pass", "ok", "success", "通过", "合格"],
        "fail_tokens": ["fail", "failed", "error", "失败", "不合格"],
        "ready_tokens": ["ready for next milestone", "ready for review cycle", "ready", "准备好", "就绪", "可推进", "可以推进"],
        "needs_revision_tokens": ["needs revision", "not ready", "需要修改", "需修改", "未通过", "不通过", "需要修订", "需修订"],
    },
}

MODE_DEFAULTS: dict[str, dict] = {
    # Max portability: keep capsule gate; prefer file-based pointers; disable branch semantics by default.
    "generic": {
        "features": {
            "capsule_gate": True,
            "scan_dependency_gate": True,
            "branch_semantics_gate": False,
            "pointer_lint_gate": True,
            "references_gate": True,
            "knowledge_layers_gate": False,
        },
        "pointer_lint": {"strategy": "file_symbol_grep"},
    },
    # Python-first projects: dotted import pointers.
    "python_project": {
        "features": {"pointer_lint_gate": True, "references_gate": True},
        "pointer_lint": {"strategy": "python_import"},
    },
    # Julia-first projects: file-based pointers (e.g. `src/foo.jl:myfunc`).
    "julia_project": {
        "features": {"pointer_lint_gate": True, "references_gate": True},
        "pointer_lint": {"strategy": "file_symbol_grep"},
    },
    # Pure-theory milestones/projects: keep capsule, but default-disable compute-heavy gates.
    "theory_only": {
        "features": {
            "capsule_gate": True,
            "scan_dependency_gate": False,
            "branch_semantics_gate": False,
            "pointer_lint_gate": False,
            "references_gate": True,
            "knowledge_layers_gate": False,
        }
    },
    # Pure-numerics projects: keep capsule; keep scan semantics; branch semantics depends on domain.
    "numerics_only": {"features": {"capsule_gate": True, "scan_dependency_gate": True, "references_gate": True}},
    # Exploratory projects: prefer warn-only by disabling most hard gates; keep capsule for basic provenance.
    "exploratory": {
        "features": {
            "capsule_gate": True,
            "scan_dependency_gate": False,
            "branch_semantics_gate": False,
            "pointer_lint_gate": False,
            "references_gate": False,
            "knowledge_layers_gate": False,
        }
    },
    "literature_review": {
        "features": {
            "capsule_gate": True,
            "scan_dependency_gate": False,
            "branch_semantics_gate": False,
            "pointer_lint_gate": False,
            "references_gate": True,
            "knowledge_layers_gate": True,
        }
    },
    "methodology_dev": {
        "features": {
            "capsule_gate": True,
            "scan_dependency_gate": True,
            "branch_semantics_gate": True,
            "pointer_lint_gate": True,
            "references_gate": True,
            "knowledge_layers_gate": True,
            "problem_framing_snapshot_gate": True,
        }
    },
    # Multi-root / spectral projects: keep all gates; emphasize branch semantics.
    "spectral_multi_root": {
        "features": {
            "capsule_gate": True,
            "scan_dependency_gate": True,
            "branch_semantics_gate": True,
            "pointer_lint_gate": True,
            "references_gate": True,
            "knowledge_layers_gate": True,
        },
        "branch_semantics": {"require_when_declared": True},
    },
    # Default mode for this repo's original target audience.
    "theory_numerics": {"features": {"knowledge_layers_gate": True, "references_gate": True, "problem_framing_snapshot_gate": True}},
}


_CONFIG_FILENAMES = (
    "research_team_config.json",
    ".research-team.json",
    "research_team_config.yaml",
    "research_team_config.yml",
)


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _find_project_root(start: Path) -> Path:
    markers = (".git", "pyproject.toml", "Project.toml", "environment.yml")
    cur = start.resolve()
    while True:
        for m in markers:
            if (cur / m).exists():
                return cur
        if cur.parent == cur:
            return start.resolve()
        cur = cur.parent


def _try_load_yaml(path: Path) -> dict | None:
    try:
        import yaml  # type: ignore
    except Exception:
        return None
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _load_config_file(path: Path) -> dict | None:
    if not path.is_file():
        return None
    if path.suffix.lower() in (".yaml", ".yml"):
        return _try_load_yaml(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def find_config_path(seed_path: Path) -> Path | None:
    """
    Search order:
    1) RESEARCH_TEAM_CONFIG env var (absolute or relative to cwd)
    2) notebook dir and parents up to project root (or filesystem root)
    """
    env = os.environ.get("RESEARCH_TEAM_CONFIG", "").strip()
    if env:
        p = Path(env)
        if not p.is_absolute():
            p = Path.cwd() / p
        return p if p.is_file() else None

    base = seed_path.parent if seed_path.is_file() else seed_path
    root = _find_project_root(base)
    cur = base.resolve()
    while True:
        for name in _CONFIG_FILENAMES:
            cand = cur / name
            if cand.is_file():
                return cand
        if cur == root or cur.parent == cur:
            break
        cur = cur.parent
    return None


@dataclass(frozen=True)
class TeamConfig:
    path: Path | None
    data: dict

    def feature_enabled(self, name: str, default: bool = True) -> bool:
        feats = self.data.get("features", {})
        if isinstance(feats, dict) and name in feats:
            return bool(feats.get(name))
        return default


def load_team_config(seed_path: Path) -> TeamConfig:
    path = find_config_path(seed_path)
    raw: dict | None = None
    if path is not None:
        raw = _load_config_file(path)

    mode = "theory_numerics"
    if isinstance(raw, dict):
        mode = str(raw.get("mode", mode)).strip() or mode

    def _mode_to_profile(mode_s: str) -> str:
        m = (mode_s or "").strip()
        if m in (
            "theory_only",
            "numerics_only",
            "exploratory",
            "literature_review",
            "methodology_dev",
            "mixed",
            "custom",
        ):
            return m
        # Back-compat mapping: existing modes mainly encode language/strictness rather than research profile.
        if m in ("python_project", "julia_project", "generic", "spectral_multi_root", "theory_numerics"):
            return "mixed"
        return "mixed"

    profile = _mode_to_profile(mode)
    if isinstance(raw, dict):
        p = str(raw.get("profile", "")).strip()
        if p:
            profile = p

    # Normalize: allow "empty string" fields to mean "unset" (use mode defaults).
    if isinstance(raw, dict):
        pl = raw.get("pointer_lint")
        if isinstance(pl, dict) and ("strategy" in pl) and (pl.get("strategy") is None or str(pl.get("strategy")).strip() == ""):
            pl = dict(pl)
            pl.pop("strategy", None)
            raw["pointer_lint"] = pl
        feats = raw.get("features")
        if isinstance(feats, dict) and len(feats) == 0:
            # Keep as-is: empty dict means "no overrides".
            pass

    mode_defaults = MODE_DEFAULTS.get(mode, {})
    cfg = _deep_merge(DEFAULT_CONFIG, mode_defaults)

    # Explicit config always overrides mode defaults.
    if isinstance(raw, dict):
        cfg = _deep_merge(cfg, raw)

    # Ensure derived profile is present (unless explicitly overridden).
    cfg["mode"] = mode
    cfg["profile"] = str(cfg.get("profile", "")).strip() or profile

    return TeamConfig(path=path, data=cfg)


def get_language_tokens(cfg: TeamConfig) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    lang = cfg.data.get("language", {}) if isinstance(cfg.data.get("language", {}), dict) else {}
    pass_tokens = tuple(str(x).lower() for x in lang.get("pass_tokens", DEFAULT_CONFIG["language"]["pass_tokens"]))
    fail_tokens = tuple(str(x).lower() for x in lang.get("fail_tokens", DEFAULT_CONFIG["language"]["fail_tokens"]))
    ready_tokens = tuple(str(x).lower() for x in lang.get("ready_tokens", DEFAULT_CONFIG["language"]["ready_tokens"]))
    needs_tokens = tuple(str(x).lower() for x in lang.get("needs_revision_tokens", DEFAULT_CONFIG["language"]["needs_revision_tokens"]))
    return pass_tokens, fail_tokens, ready_tokens, needs_tokens
