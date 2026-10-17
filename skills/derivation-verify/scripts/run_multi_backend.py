#!/usr/bin/env python3
"""
derivation-verify — Executor 2 (CLI multi-backend) — cross-model convergence gate.

Satisfies the SAME backend-agnostic contract as the Claude/Workflow-native executor
(../workflows/derivation_verify.js; see ../references/contract.md), but runs the >=2 INDEPENDENT
blind re-derivations across SEPARATE model CLIs (Claude / Codex / Gemini / OpenCode / Kimi) for TRUE
cross-model independence — the reliability ceiling per the SOTA on multi-agent verification.

At least two independently constructed/executed blind evidence lanes must agree after a
fresh source-grounded applicability/provenance assessment. Method diversity and model-family
diversity are separate records, not generic rejection predicates. A comparator checks actual
steps, input visibility, known defects and diagnostic power; CAS agreement alone never approves
unassessed evidence. Diversity-first tie-break scheduling remains bounded by max_iter.

It reuses review-swarm's multi-backend runner (skills/review-swarm/scripts/bin/run_multi_task.py)
as the per-backend launcher: each deriver/comparator is one runner invocation pinned to one model
spec, writing its raw text to a known path which we parse into the JSON verdict contract.

INPUT (identical to Executor 1; a caller's claims.json ports verbatim):
  { "context": str, "max_iter": int?, "claims": [ {id, statement, report_format, method0, method1} ] }

OUTPUT: the verification matrix (Executor 1 schema + cross-model fields). See _summarize().

Usage:
    python3 run_multi_backend.py --claims claims.json \
        --backends claude/default,codex/default,gemini/default,opencode/default \
        --comparator codex/default --out matrix.json
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from read_coverage import NOT_READ, WRAP_CHARS, freeze_material, read_coverage
from independence import quoted_in_derivation, derivation_body, assessed_indices, independence_record, packet_transport, valid_derivation_transport, method_risk_passes, observe_runtime_derivation

_THIS = Path(__file__).resolve()
_SKILLS_ROOT = _THIS.parents[2]  # skills/derivation-verify/scripts/run_multi_backend.py -> skills/
_DEFAULT_RUNNER = _SKILLS_ROOT / "review-swarm" / "scripts" / "bin" / "run_multi_task.py"
_REVIEW_BIN = _DEFAULT_RUNNER.parent
_REQUEST_LIB = _SKILLS_ROOT / "research-team" / "scripts" / "lib"
if str(_REQUEST_LIB) not in sys.path:
    sys.path.insert(0, str(_REQUEST_LIB))
from request_capacity import OUTPUT_RESERVE, request_budgets, validate_request_bytes, validate_request_capacity


def _resolve_runner(explicit):
    """Locate review-swarm's run_multi_task.py (Executor 2's per-backend launcher). Order, all
    host-neutral: explicit --runner > $DERIVATION_VERIFY_RUNNER > the review-swarm skill installed
    ALONGSIDE this one (the declared market dependency). Returns a Path or None."""
    for cand in (explicit, os.environ.get("DERIVATION_VERIFY_RUNNER"), _DEFAULT_RUNNER):
        if cand:
            p = Path(cand)
            if p.exists():
                # Absolute so the launcher subprocess resolves the same file regardless of any
                # cwd differences between this gate and the environment it was invoked from.
                return p.resolve()
    return None

# Reuse review-swarm's generic output cleanup; request capacity is validated
# separately and does not import the review-specific output contract.
if str(_REVIEW_BIN) not in sys.path:
    sys.path.insert(0, str(_REVIEW_BIN))
try:
    from review_contract import normalize_newlines, strip_markdown_fences  # type: ignore
except Exception:  # pragma: no cover - fallback keeps the gate usable if review-swarm moves
    def normalize_newlines(text: str) -> str:
        return text.replace("\r\n", "\n").replace("\r", "\n")

    def strip_markdown_fences(text: str) -> str:
        s = text.strip()
        if s.startswith("```"):
            s = s[s.index("\n") + 1:] if "\n" in s else ""
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
        return s.strip()

_DEFAULT_BACKENDS = "claude/default,codex/default,gemini/default,opencode/default"
# No hard deadline by default, matching the review-swarm launcher: a long blind derivation that
# is still producing output is not killed by a fixed wall clock. The launcher's soft expected
# duration is recorded instead; pass --timeout-secs only for a cap sized from earlier runs.
_DEFAULT_TIMEOUT = 0
_CONFIDENCE = {"high", "medium", "low"}
_TOOL_MODES = {"claude": "review", "gemini": "review", "opencode": "workspace"}  # codex always execs


# --------------------------------------------------------------------------------------
# Third-party agents file (family -> runner -> model-string mapping).
#
# Single update point for which model families exist on this machine, which execution
# route serves each family, and which model string each route takes. Schema, discovery
# order, and degradation semantics: docs/AGENTS_FILE.md. Deliberately self-contained
# (same shape as review-swarm's parser but no shared library); the checked-in template
# docs/examples/agents.example.json is the shared parsing fixture keeping both aligned.
# --------------------------------------------------------------------------------------
_AGENTS_FILENAME = "agents.json"
_AGENTS_RUNNERS = {"native", "codex", "opencode", "kimi", "gemini", "claude-cli"}
# Runner label -> the launcher backend namespace family_of() uses. `native` maps to no
# backend: the host runs its own family in-process (native_derivations), never via CLI.
_AGENTS_RUNNER_BACKEND = {
    "codex": "codex",
    "opencode": "opencode",
    "kimi": "kimi",
    "gemini": "gemini",
    "claude-cli": "claude",
}
_AGENTS_RUNNER_BINARY = {
    "codex": "codex",
    "opencode": "opencode",
    "kimi": "kimi",
    "gemini": "gemini",
    "claude-cli": "claude",
}
_FAMILY_SPEC_PREFIX = "family:"

# Module-level roster set once by main() (or tests via set_agents_roster); when None,
# every roster-aware helper degrades to the exact pre-agents-file behavior.
_AGENTS_ROSTER: Optional[dict] = None
_AGENTS_SOURCE: str = "none"
_AGENTS_PATH: Optional[Path] = None


def set_agents_roster(roster: Optional[dict], *, source: str = "none", path: Optional[Path] = None) -> None:
    global _AGENTS_ROSTER, _AGENTS_SOURCE, _AGENTS_PATH
    _AGENTS_ROSTER = roster
    _AGENTS_SOURCE = source
    _AGENTS_PATH = path


def validate_agents_roster(obj, *, source) -> dict:
    if not isinstance(obj, dict):
        raise ValueError(f"{source}: agents file root must be a JSON object")
    # Unknown keys at any level are rejected, matching the other two
    # self-contained parsers of this contract (review-swarm,
    # idea-pairwise-match): a misspelled field would otherwise be silently
    # treated as absent and change the run's semantics. Top-level "_notes"
    # is the one sanctioned comment carrier.
    unknown_top = sorted(set(obj) - {"version", "families", "policy", "_notes"})
    if unknown_top:
        raise ValueError(
            f"{source}: unknown top-level keys: {', '.join(unknown_top)} "
            "(expected only: version, families, policy, _notes)"
        )
    version = obj.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise ValueError(f"{source}: unsupported agents file version: {version!r} (expected the integer 1)")
    families = obj.get("families")
    if not isinstance(families, dict):
        raise ValueError(f"{source}: 'families' must be a JSON object")
    # One non-opencode CLI runner serves ONE model family (opencode is a multi-provider
    # gateway and may serve several). Two families on one dedicated runner, or two
    # families declaring the same (runner, model string), would make family attribution
    # ambiguous and could count one physical family twice in the cross-family gate — that
    # is a configuration contradiction, rejected here rather than guessed at later.
    runner_owner: dict = {}
    seen_models: dict = {}
    for name, fam in families.items():
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{source}: family names must be non-empty strings")
        if name != name.strip().lower():
            # Family names travel through case-normalized channels (family: specs,
            # native family tags); a non-lowercase name would compare unequal to its
            # own normalized form and could label one physical family two ways.
            raise ValueError(f"{source}: family names must be lowercase: {name!r}")
        if not isinstance(fam, dict):
            raise ValueError(f"{source}: family {name!r} must be a JSON object")
        unknown_fam = sorted(set(fam) - {"runner", "models", "available", "notes"})
        if unknown_fam:
            raise ValueError(
                f"{source}: family {name!r} has unknown keys: {', '.join(unknown_fam)} "
                "(expected only: runner, models, available, notes)"
            )
        runner = fam.get("runner")
        if runner not in _AGENTS_RUNNERS:
            raise ValueError(
                f"{source}: family {name!r} has unknown runner {runner!r} "
                f"(expected one of: {', '.join(sorted(_AGENTS_RUNNERS))})"
            )
        if runner not in ("native", "opencode"):
            other = runner_owner.get(runner)
            if other is not None:
                raise ValueError(
                    f"{source}: families {other!r} and {name!r} both declare runner {runner!r}: "
                    "one dedicated execution route is one model family; merge them into one "
                    "family with multiple model tiers"
                )
            runner_owner[runner] = name
        models = fam.get("models", {})
        if not isinstance(models, dict):
            raise ValueError(f"{source}: family {name!r} 'models' must be a JSON object")
        for tier, value in models.items():
            if not isinstance(tier, str) or not tier.strip() or not isinstance(value, str) or not value.strip():
                raise ValueError(
                    f"{source}: family {name!r} model tiers must map non-empty strings to non-empty strings"
                )
            key = (str(runner), value.strip())
            other = seen_models.get(key)
            if other is not None and other != name:
                raise ValueError(
                    f"{source}: families {other!r} and {name!r} both declare model {value!r} "
                    f"on runner {runner!r}: one model string is one family"
                )
            seen_models[key] = name
        if "available" in fam and not isinstance(fam["available"], bool):
            raise ValueError(f"{source}: family {name!r} 'available' must be a boolean")
        if "notes" in fam and not isinstance(fam["notes"], str):
            raise ValueError(f"{source}: family {name!r} 'notes' must be a string")
    if "policy" in obj and not isinstance(obj["policy"], dict):
        raise ValueError(f"{source}: 'policy' must be a JSON object")
    policy = obj.get("policy") or {}
    unknown_policy = sorted(set(policy) - {"cross_family_minimum", "when_below_minimum"})
    if unknown_policy:
        raise ValueError(
            f"{source}: policy has unknown keys: {', '.join(unknown_policy)} "
            "(expected only: cross_family_minimum, when_below_minimum)"
        )
    minimum = policy.get("cross_family_minimum", 3)
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 1:
        raise ValueError(f"{source}: policy.cross_family_minimum must be a positive integer")
    when_below = policy.get("when_below_minimum", "native_subagents")
    if when_below != "native_subagents":
        raise ValueError(
            f"{source}: policy.when_below_minimum must be \"native_subagents\" "
            "(the only value defined by schema version 1)"
        )
    return obj


def find_agents_file(start: Optional[Path] = None) -> tuple:
    """Auto-discover the agents file: project level <git-root>/.nullius/agents.json
    (upward walk from CWD to the first directory containing .git) first, then user
    level ~/.nullius/agents.json. Disabled when DERIVATION_VERIFY_NO_AUTO_CONFIG=1
    (an explicit --agents-file bypasses this switch entirely)."""
    if os.environ.get("DERIVATION_VERIFY_NO_AUTO_CONFIG"):
        return None, "none"
    cur = (start or Path.cwd()).resolve()
    while True:
        if (cur / ".git").exists():
            candidate = cur / ".nullius" / _AGENTS_FILENAME
            if candidate.is_file():
                return candidate, "project"
            break
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    user_candidate = Path.home() / ".nullius" / _AGENTS_FILENAME
    if user_candidate.is_file():
        return user_candidate, "user"
    return None, "none"


def load_agents_file(explicit: Optional[str]) -> tuple:
    """Load the agents file. Returns (roster or None, source, path or None).

    A missing file (no explicit path, nothing discovered) is the pure-native
    configuration and never an error. An explicit path that does not exist, or any
    file that fails to parse or validate, IS an input error: the gate stops rather
    than silently continuing without the declared configuration."""
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"--agents-file not found: {p}")
        roster = validate_agents_roster(json.loads(p.read_text(encoding="utf-8")), source=p)
        return roster, "explicit", p
    found, source = find_agents_file()
    if found is None:
        return None, "none", None
    roster = validate_agents_roster(json.loads(found.read_text(encoding="utf-8")), source=found)
    return roster, source, found


def resolve_family_spec(spec: str, roster: Optional[dict]) -> str:
    """Resolve a family:<name>[:<tier>] spec into an explicit model spec via the agents
    file. Every failure is an explicit input error; a family spec is never silently
    reinterpreted, and an unusable family is never substituted."""
    body = spec[len(_FAMILY_SPEC_PREFIX):].strip()
    name, _, tier = body.partition(":")
    # Family names are lowercase by schema; normalize the request the same way.
    name = name.strip().lower()
    tier = tier.strip() or "default"
    if not name:
        raise ValueError(f"empty family spec: {spec!r}")
    if not roster:
        raise ValueError(
            f"model spec {spec!r} needs an agents file and none was found "
            "(pass --agents-file or create .nullius/agents.json; see docs/AGENTS_FILE.md)"
        )
    families = roster.get("families") or {}
    fam = families.get(name)
    if not isinstance(fam, dict):
        raise ValueError(
            f"agents file has no family {name!r} (declared: {', '.join(sorted(families)) or 'none'})"
        )
    if fam.get("available") is False:
        notes = str(fam.get("notes") or "").strip()
        raise ValueError(
            f"family {name!r} is declared unavailable in the agents file"
            + (f" ({notes})" if notes else "")
        )
    runner = str(fam.get("runner") or "")
    if runner == "native":
        raise ValueError(
            f"family {name!r} is declared native: use the in-host Workflow executor; "
            "external native_derivations JSON has no validated invocation authority in this CLI"
        )
    if not agents_runner_available(runner):
        raise ValueError(
            f"family {name!r} is declared available but its runner executable is not present "
            f"on this machine (runner {runner!r}); the family is honestly absent, never substituted"
        )
    models = fam.get("models") or {}
    model = models.get(tier)
    if not isinstance(model, str) or not model.strip():
        raise ValueError(
            f"family {name!r} has no model tier {tier!r} "
            f"(declared tiers: {', '.join(sorted(models)) or 'none'})"
        )
    model = model.strip()
    backend = _AGENTS_RUNNER_BACKEND[runner]
    if backend == "opencode":
        # OpenCode model strings already carry their provider/model prefix. A provider
        # segment that collides with a reserved launcher prefix would make the spec
        # classifier re-route the agent to a DIFFERENT runner than the file declares —
        # reject the collision instead of silently overriding the declared runner.
        head = model.split("/", 1)[0].strip().lower()
        if head in ("claude", "codex", "gemini", "kimi") or model.lower().startswith(_FAMILY_SPEC_PREFIX):
            raise ValueError(
                f"family {name!r} declares opencode model {model!r} whose leading segment "
                "collides with a reserved launcher prefix (claude/, codex/, gemini/, kimi/, family:)"
            )
        return model
    return f"{backend}/{model}"


def roster_family(backend: str, model: str, roster: Optional[dict]) -> str:
    """Family label for one (backend, model) execution. Attribution works on the
    resolved execution: an exact model-string match against a declared tier wins; a
    runner used by exactly one declared family maps to that family; opencode model
    strings match by their provider/ prefix; anything the file cannot attribute keeps
    the backend name as its family label (the pre-agents-file behavior)."""
    if not roster:
        return backend
    families = roster.get("families") or {}
    m = (model or "").strip()
    if backend != "opencode" and m.startswith(backend + "/"):
        m = m.split("/", 1)[1]
    runner_families = []
    for fam_name in sorted(families):
        fam = families[fam_name]
        if not isinstance(fam, dict):
            continue
        if _AGENTS_RUNNER_BACKEND.get(str(fam.get("runner") or "")) != backend:
            continue
        runner_families.append(fam_name)
        tiers = fam.get("models") or {}
        if m and isinstance(tiers, dict) and m in {str(v).strip() for v in tiers.values()}:
            return fam_name
    if backend != "opencode":
        if len(runner_families) == 1:
            return runner_families[0]
        return backend
    provider = m.split("/", 1)[0] if "/" in m else ""
    if provider:
        hits = [
            fam_name
            for fam_name in runner_families
            if any(
                "/" in str(v) and str(v).strip().split("/", 1)[0] == provider
                for v in (families[fam_name].get("models") or {}).values()
            )
        ]
        if len(hits) == 1:
            return hits[0]
    return backend


def roster_family_of(spec: str) -> str:
    """Roster-aware family of a model spec: family_of() refined by the agents file
    when one is in force. Used everywhere the GATE reasons about family identity
    (cross-family counting, diversity tie-break, native auto-exclusion, reports);
    the launcher-backend routing in MultiTaskRunner keeps plain family_of()."""
    backend = family_of(spec)
    if _AGENTS_ROSTER is None:
        return backend
    return roster_family(backend, (spec or "").strip(), _AGENTS_ROSTER)


def agents_runner_available(runner: str) -> bool:
    if runner == "native":
        return True
    binary = _AGENTS_RUNNER_BINARY.get(runner)
    return bool(binary and shutil.which(binary))


def usable_families(roster: dict) -> list:
    """Families that count as usable on this machine: declared available (`available`
    absent or true) AND the runner's executable actually exists (`native` always
    passes). Everything else is honestly absent — never substituted."""
    out = []
    for name in sorted(roster.get("families") or {}):
        fam = roster["families"][name]
        if not isinstance(fam, dict) or fam.get("available") is False:
            continue
        if agents_runner_available(str(fam.get("runner") or "")):
            out.append(name)
    return out


def independence_summary(participating: list) -> dict:
    """Independence record for the matrix: which families actually produced usable
    derivations, at which level, and — when an agents file is in force — how that
    compares to declared availability and the cross-family minimum. A degraded gate
    run must be visible as degraded; falling back to the host's native subagent panel
    is the calling skill's move, per policy.when_below_minimum."""
    participating = sorted(set(participating))
    if len(participating) >= 2:
        level = "cross_family"
    elif len(participating) == 1:
        level = "single_family"
    else:
        level = "none"
    # The field set is identical on every path. Without an agents file the
    # declaration-relative fields are null — "nothing was declared", which is
    # different from an empty list ("everything declared participated").
    info = {
        "level": level,
        "participating_families": participating,
        "declared_available_families": None,
        "absent_families": None,
        "cross_family_minimum": None,
        "below_minimum": None,
        "when_below_minimum": None,
    }
    if _AGENTS_ROSTER:
        declared = sorted(_AGENTS_ROSTER.get("families") or {})
        usable = usable_families(_AGENTS_ROSTER)
        policy = _AGENTS_ROSTER.get("policy") or {}
        minimum = policy.get("cross_family_minimum", 3)
        info.update(
            {
                "declared_available_families": usable,
                "absent_families": [f for f in declared if f not in participating],
                "cross_family_minimum": int(minimum),
                "below_minimum": len(usable) < int(minimum),
                "when_below_minimum": str(policy.get("when_below_minimum", "native_subagents")),
            }
        )
    return info


# --------------------------------------------------------------------------------------
# Pure helpers (no I/O, no subprocess) — unit-tested directly.
# --------------------------------------------------------------------------------------
def family_of(spec: str) -> str:
    """Model FAMILY (== review-swarm backend) of a model spec. Mirrors run_multi_task._classify_model."""
    m = (spec or "").strip()
    if not m or m == "default":
        return "opencode"
    for fam in ("claude", "codex", "gemini", "kimi"):
        if m.startswith(fam + "/"):
            return fam
    return "opencode"


def normalize_family(tag: str) -> str:
    """Canonicalize a host-declared native `family` tag into the SAME namespace as the gate's family
    labels so native and CLI families compare correctly (auto-exclusion + cross-family counting).
    Accepts a bare family name (`claude`/`Claude`), a full spec (`claude/default`), or any
    opencode-class provider. With an agents file in force, a declared family name is kept verbatim
    and a backend-namespace alias is mapped through the roster (a host tagging itself `codex` and a
    CLI derivation labeled `gpt` are ONE physical family — leaving the alias unmapped would count it
    twice and fake a cross-family confirmation). Everything else non-{claude,codex,gemini,kimi}
    folds to `opencode` exactly as `family_of` does for CLI specs."""
    t = (tag or "").strip().lower()
    if not t or t == "default":
        return "opencode"
    if "/" in t:
        return roster_family_of(t)
    if _AGENTS_ROSTER is not None:
        families = _AGENTS_ROSTER.get("families") or {}
        if t in families:
            return t
        if t in ("claude", "codex", "gemini", "kimi", "opencode"):
            return roster_family(t, "", _AGENTS_ROSTER)
    return t if t in ("claude", "codex", "gemini", "kimi") else "opencode"


_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)```", re.DOTALL)


def extract_json(text: Optional[str], prefer_keys: Optional[set] = None) -> Optional[dict]:
    """Pull the intended JSON object a CLI model emitted, robust to surrounding/trailing prose.

    Gathers every parseable dict from (a) fenced ```json blocks (last first — the final answer block),
    (b) the whole/ fence-stripped string, (c) balanced top-level {...} in document order; then, when
    ``prefer_keys`` is given, returns the FIRST candidate that contains all required keys (so a real
    verdict block wins over a stray ``{...}`` in trailing prose — the asymmetry that a naive
    last-balanced-wins scan got wrong). Falls back to the best partial / first candidate otherwise.
    """
    if not text:
        return None
    cleaned = normalize_newlines(text)
    raw_candidates: list[str] = list(reversed(_FENCE_RE.findall(cleaned)))
    raw_candidates += [strip_markdown_fences(cleaned), cleaned]
    for start in (i for i, ch in enumerate(cleaned) if ch == "{"):
        depth = 0
        for j in range(start, len(cleaned)):
            if cleaned[j] == "{":
                depth += 1
            elif cleaned[j] == "}":
                depth -= 1
                if depth == 0:
                    raw_candidates.append(cleaned[start:j + 1])
                    break
    parsed: list[dict] = []
    for cand in raw_candidates:
        try:
            obj = json.loads(cand)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(obj, dict):
            parsed.append(obj)
    if not parsed:
        return None
    if prefer_keys:
        complete = [o for o in parsed if prefer_keys.issubset(o.keys())]
        if complete:
            return complete[0]
        parsed.sort(key=lambda o: len(prefer_keys & set(o.keys())), reverse=True)
    return parsed[0]


def parse_derivation(text: Optional[str]) -> Optional[dict]:
    """Validate a deriver's JSON verdict {canonical_answer, derivation_summary, confidence}."""
    obj = extract_json(text, prefer_keys={"canonical_answer"})
    if not isinstance(obj, dict):
        return None
    ans = obj.get("canonical_answer")
    summ = obj.get("derivation_summary")
    conf = str(obj.get("confidence", "")).strip().lower()
    if not isinstance(ans, str) or not ans.strip():
        return None
    form = obj.get("checkable_form")
    try:
        whole = json.loads(strip_markdown_fences(normalize_newlines(text)).strip())
        additional_text = whole != obj
    except (ValueError, TypeError):
        additional_text = True
    return {
        "original_assistant_output": text,
        "additional_assistant_text_present": additional_text,
        "canonical_answer": ans.strip(),
        "derivation_summary": summ.strip() if isinstance(summ, str) else "",
        "derivation": obj.get("derivation", "") if isinstance(obj.get("derivation"), str) else "",
        "confidence": conf if conf in _CONFIDENCE else "low",
        # optional strict-sympy rewrite of the answer for deterministic equivalence; "" if not a
        # closed-form/number (asymptotic bound, set, prose) -> CAS abstains, gate falls back to LLM.
        "checkable_form": form.strip() if isinstance(form, str) else "",
    }


def parse_native_derivation(d) -> Optional[dict]:
    """Normalize an externally supplied native record for readable provenance.
    Author transport and observation flags are stripped: no validated external capture authority is
    supported, so this record cannot count as a runtime-observed confirmation.
    Returns None when its canonical answer or family is absent."""
    if not isinstance(d, dict):
        return None
    ans, fam = d.get("canonical_answer"), d.get("family")
    if not isinstance(ans, str) or not ans.strip() or not isinstance(fam, str) or not fam.strip():
        return None
    summ, form = d.get("derivation_summary"), d.get("checkable_form")
    conf = str(d.get("confidence", "")).strip().lower()
    return {
        "canonical_answer": ans.strip(),
        "derivation_summary": summ.strip() if isinstance(summ, str) else "",
        "derivation": d.get("derivation", "") if isinstance(d.get("derivation"), str) else "",
        "transport": None,  # External author fields are not a runtime observation authority.
        "confidence": conf if conf in _CONFIDENCE else "high",  # host-native default: high
        "checkable_form": form.strip() if isinstance(form, str) else "",
        "execution_id": d.get("execution_id", ""),
        "method": d.get("method", "unspecified"),
        "family": normalize_family(fam),  # canonical namespace, so it dedups/excludes vs CLI families
    }


def parse_comparison(text: Optional[str], n_derivations: int) -> Optional[dict]:
    """Validate the comparator JSON, incl. the Executor-2 extensions majority_indices + veto flag."""
    obj = extract_json(text, prefer_keys={"majority_size", "majority_answer"})
    if not isinstance(obj, dict):
        return None
    majority_size = obj.get("majority_size")
    if type(majority_size) is not int or majority_size < 0:
        return None
    raw_idx = obj.get("majority_indices")
    if (not isinstance(raw_idx, list) or any(type(i) is not int or not 0 <= i < n_derivations for i in raw_idx)
            or len(set(raw_idx)) != len(raw_idx) or majority_size != len(raw_idx)):
        return None
    indices = sorted(raw_idx)
    return {
        "majority_answer": str(obj.get("majority_answer", "")).strip(),
        "majority_size": majority_size,
        "majority_indices": indices,
        "independence_assessments": obj.get("independence_assessments", []),
        "method_risk_assessments": obj.get("method_risk_assessments", []),
        "all_equivalent": obj.get("all_equivalent") is True,
        "adjudicated_matches_majority": obj.get("adjudicated_matches_majority") is True and majority_size == len(indices),
        "outliers": str(obj.get("outliers", "")).strip() or "none",
        "correct_answer_adjudicated": str(obj.get("correct_answer_adjudicated", "")).strip(),
    }


def parse_lane_assessment(text: Optional[str], index: int) -> Optional[list]:
    """The assessments a per-lane request returned for ITS lane. Entries naming any other index are dropped:
    that request did not hold the other lanes' material. Duplicates stay, so assessed_indices refuses them."""
    obj = extract_json(text, prefer_keys={"independence_assessments"})
    records = obj.get("independence_assessments") if isinstance(obj, dict) else None
    if not isinstance(records, list):
        return None
    own = [a for a in records if isinstance(a, dict) and type(a.get("index")) is int and a["index"] == index]
    return own or None


def answer_supported(d: dict, assessment: dict) -> bool:
    """A per-lane assessment never sees the other lanes, and the joint request sees only canonical answers, so
    the lane request must itself state that the lane's body supports its stated canonical answer, quoting
    the concluding steps under the construction rule."""
    support = assessment.get("answer_support") if isinstance(assessment, dict) else None
    if not isinstance(support, dict) or support.get("supports_canonical_answer") is not True:
        return False
    span, reason = support.get("source_span"), support.get("reason")
    return (isinstance(span, str) and bool(span.strip()) and isinstance(reason, str) and len(reason.strip()) >= 20
            and quoted_in_derivation(span, d))


def parse_pair_risk(text: Optional[str], pair: tuple) -> Optional[list]:
    """The method-risk assessments a per-pair request returned for ITS pair only."""
    obj = extract_json(text, prefer_keys={"method_risk_assessments"})
    records = obj.get("method_risk_assessments") if isinstance(obj, dict) else None
    if not isinstance(records, list):
        return None
    own = [r for r in records if isinstance(r, dict) and isinstance(r.get("indices"), list)
           and sorted(i for i in r["indices"] if type(i) is int) == sorted(pair) and len(r["indices"]) == 2]
    return own or None


# A dead/garbled comparator must degrade THIS claim to unconverged, never crash the run (cf.
# contract.md: "transient executor failures must NOT count; report unconverged honestly").
SAFE_CMP = {
    "majority_answer": "(comparator unavailable)", "majority_size": 0, "majority_indices": [],
    "all_equivalent": False, "adjudicated_matches_majority": False,
    "independence_assessments": [],
    "outliers": "comparator backend produced no parseable verdict",
    "correct_answer_adjudicated": "(unadjudicated — comparator unavailable)",
}


def cross_family_confirmations(cmp: dict, families: list[str]) -> int:
    """# of DISTINCT model families inside the comparator's agreeing cluster (R1)."""
    fams = {families[i] for i in cmp.get("majority_indices", []) if 0 <= i < len(families)}
    return len(fams)


def decide_converged(cmp: dict, families: list[str], native_count: int = 0,
                     derivations: Optional[list[dict]] = None) -> bool:
    """Use the same answer-bound acceptance policy as the runtime consumer."""
    return claim_status(cmp, derivations or [], families, native_count)[0]


def pick_next_spec(pool: list[str], used: list[str]) -> Optional[str]:
    """Diversity-first tie-break (R3): a spec whose FAMILY is unused; else least-used family; else None.
    Family identity is roster-aware, so two specs the agents file attributes to one family never count
    as diversity."""
    used_fams = [roster_family_of(s) for s in used]
    for spec in pool:
        if roster_family_of(spec) not in used_fams:
            return spec
    # all families already used at least once -> reuse the least-used family's spec (still adds a derivation)
    if pool:
        counts = {spec: used_fams.count(roster_family_of(spec)) for spec in pool}
        return min(pool, key=lambda s: counts[s])
    return None


# --------------------------------------------------------------------------------------
# Capability-first deterministic equivalence (LLM-INDEPENDENT; abstains unless confident).
# Operates on each deriver's MODEL-DECLARED `checkable_form` (a strict sympy rewrite of its answer) —
# NOT on the free-text canonical_answer, because naive parsing of free text is unsafe (e.g. implicit
# multiplication turns "arctan(q/2m)" into a*r*c*t*a*n*..., and "Θ(n log n)" parses to a symbol product).
# When >=2 cross-family derivations are CAS-verified equal, convergence is decided WITHOUT the
# (anchored) comparator — the blind/de-anchored adjudication the design targets. Any doubt -> abstain.
# --------------------------------------------------------------------------------------
try:
    import sympy as _sp
    from sympy.parsing.sympy_parser import parse_expr as _parse_expr, standard_transformations
    from sympy.core.function import AppliedUndef as _AppliedUndef
    _SYMPY_OK = True
    # Math-only eval namespace for parse_expr (parse_expr eval()s its input, so a hostile checkable_form
    # could execute code DURING parsing). builtins blanked -> __import__/open/exec/eval are absent; and
    # we drop side-effecting callables from sympy's plotting/printing/interactive/utilities modules
    # (plot()/preview()/pprint()/lambdify() would render, shell out to latex, or pollute stdout when
    # eval'd) — keeping only the mathematical functions/constants we actually compare.
    _UNSAFE_MODS = ("plotting", "printing", "interactive", "utilities")
    _SYMPY_NS = {
        k: v for k, v in ((n, getattr(_sp, n)) for n in dir(_sp) if not n.startswith("_"))
        if not (callable(v) and any(m in getattr(v, "__module__", "") for m in _UNSAFE_MODS))
    }
    _SYMPY_NS["__builtins__"] = {}
except Exception:  # pragma: no cover - CAS path simply abstains if sympy is unavailable
    _SYMPY_OK = False

# Pre-parse denylist: code-execution gadgets (dunders / builtins) AND compute-heavy or value-ambiguous
# sympy heads we refuse to CAS-compare. Defense-in-depth for the restricted namespace (security), and
# it also fixes indefinite-integral "+C" false-refutation and parse-time DoS (integrate/solve/factor).
_FORM_DENY = re.compile(
    r"__|\b(import|lambda|exec|eval|open|getattr|setattr|globals|locals|compile|input|"
    r"subprocess|system|integrate|solve|factor|diff|limit|series|summation|"
    r"Integral|Sum|Product|Derivative|Matrix|lambdify)\b"
)
# Quote chars get their own structural rule because the restricted namespace does NOT cover the worst
# vector: a string literal lets the form call S("...")/sympify("...")/parse_expr("..."), which RE-ENTER
# sympy's parser with its OWN default globals (builtins exposed) and eval the inner payload — bypassing
# _SYMPY_NS entirely. A genuine math answer is digits/names/operators only and never needs a quote, so
# any quote/backtick means "not a value, possibly a re-entry payload" -> abstain before parsing.
_FORM_QUOTES = ("'", '"', "`")


def _strict_expr(form):
    """Strict-parse a model-declared sympy form (NO implicit multiplication) inside a builtins-free
    namespace. Return a sympy Expr only if it is a genuine finite algebraic/numeric value we can
    compare; else None (abstain). Rejects code-execution gadgets, string-literal re-entry, undefined
    functions (f(...), Θ(...)), big-O/asymptotic, unevaluated Integral/Sum/Product/Derivative,
    booleans/relations, lists, non-finite.

    SECURITY: `form` is untrusted backend/LLM output and parse_expr eval()s it, so a hostile/hallucinated
    checkable_form could execute code DURING parsing. Three layers stop it: the structural pre-parse gate
    here (no quotes -> no S("...")/sympify("...") re-entry; no dunders/builtin names -> no gadget chain),
    the sympy-only _SYMPY_NS with __builtins__ blanked, and the post-parse type/atom checks below."""
    if not _SYMPY_OK or not isinstance(form, str):
        return None
    s = form.strip().replace("^", "**")
    if not s or len(s) > 4000 or any(q in s for q in _FORM_QUOTES) or _FORM_DENY.search(s):
        return None
    try:
        e = _parse_expr(s, transformations=standard_transformations, evaluate=True,
                        global_dict=_SYMPY_NS, local_dict={})
    except Exception:
        return None
    if not isinstance(e, _sp.Expr):
        return None
    if (e.atoms(_AppliedUndef)
            or e.has(_sp.Order, _sp.Integral, _sp.Sum, _sp.Product, _sp.Derivative)
            or e.has(_sp.zoo, _sp.nan, _sp.oo)):
        return None
    return e


def equivalent_forms(a_form, b_form):
    """True/False if a CAS can confidently decide a==b; None to abstain (unparseable / undecidable).

    Uses sympy `simplify(a-b)==0` (sound True) then `Expr.equals` (symbolic + internal high-precision
    random-point testing — True/False/None). We deliberately do NOT roll our own numeric sampling:
    fixed integer points give false-positives for periodic functions (e.g. sin(pi*x) is 0 at every
    integer), whereas `.equals` samples generic points and returns False there. Undecided -> abstain;
    never guess (a wrong CAS verdict is worse than falling back to the LLM path)."""
    ea, eb = _strict_expr(a_form), _strict_expr(b_form)
    if ea is None or eb is None or (ea.free_symbols ^ eb.free_symbols):
        return None
    try:
        if _sp.simplify(ea - eb) == 0:
            return True
    except Exception:
        pass
    try:
        eq = ea.equals(eb)
        if eq is True:
            return True
        if eq is False:
            return False
    except Exception:
        pass
    return None


def verified_cross_family(forms: list[str], families: list[str], native_count: int = 0) -> tuple[int, bool]:
    """Max # of DISTINCT families in any CAS-verified-equal cluster THAT CONTAINS >=1 independent (non-
    native, i.e. CLI-derived) member, and whether ANY pair was CAS-decided. A natives-only cluster (all
    member indices < native_count) does NOT count — host-supplied derivations cannot self-certify without
    an independent engine. decidable=False => CAS abstained entirely (fall back to the LLM path)."""
    n = len(forms)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    decidable = False
    for i in range(n):
        for j in range(i + 1, n):
            r = equivalent_forms(forms[i], forms[j])
            if r is not None:
                decidable = True
            if r is True:
                parent[find(i)] = find(j)
    members: dict[int, list] = {}
    for i in range(n):
        members.setdefault(find(i), []).append(i)
    xfam = 0
    for idxs in members.values():
        if any(i >= native_count for i in idxs):  # require >=1 independent CLI member in the cluster
            xfam = max(xfam, len({families[i] for i in idxs}))
    return xfam, decidable


def claim_status(cmp: dict, derivations: list[dict], families: list[str],
                 native_count: int = 0) -> tuple[bool, str, int]:
    eligible = [i for i in assessed_indices(derivations, cmp.get("independence_assessments", [])) if valid_derivation_transport(derivations[i])]
    if cmp.get("assessment_input_sha256") != hashlib.sha256(json.dumps(derivations, ensure_ascii=False, sort_keys=True).encode()).hexdigest():
        eligible = []
    # CAS checks agreement only; it cannot bypass provenance/applicability review.
    groups: list[list[int]] = []
    decidable = False
    for i in eligible:
        placed = False
        for group in groups:
            same = equivalent_forms(derivations[i].get("checkable_form", ""),
                                    derivations[group[0]].get("checkable_form", ""))
            decidable |= same is not None
            if same is True:
                group.append(i)
                placed = True
                break
        if not placed:
            groups.append([i])
    raw_indices = cmp.get("majority_indices", [])
    valid_indices = (isinstance(raw_indices, list) and all(type(i) is int and 0 <= i < len(derivations) for i in raw_indices)
                     and len(set(raw_indices)) == len(raw_indices))
    idx = sorted(i for i in raw_indices if i in eligible) if valid_indices else []
    answer = cmp.get("majority_answer")
    representative = (isinstance(answer, str) and bool(answer.strip()) and any(
        answer.strip() == str(derivations[i].get("canonical_answer", "")).strip() for i in idx))
    adjudicated = len(idx) >= 2 and type(cmp.get("majority_size")) is int and cmp["majority_size"] == len(raw_indices) and cmp.get("adjudicated_matches_majority") is True
    if decidable:
        # Equality is evidence about this cluster only. An inconclusive or
        # different adjudicated cluster cannot publish some other group's answer.
        same_group = any(set(idx).issubset(group) for group in groups)
        bindings = [equivalent_forms(answer, derivations[i].get("checkable_form", "")) for i in idx] if isinstance(answer, str) else []
        answer_bound = bool(bindings) and all(x is True for x in bindings)
        if representative and bindings and all(x is not False for x in bindings):
            answer_bound = True
        accepted = idx if adjudicated and same_group and answer_bound else []
        cmp["accepted_indices"] = accepted
        return bool(accepted), "cas", len({families[i] for i in accepted})
    accepted = idx if adjudicated and representative else []
    cmp["accepted_indices"] = accepted
    return bool(accepted), "llm", len({families[i] for i in accepted})


# --------------------------------------------------------------------------------------
# Prompts (mirror Executor 1's vPrompt/cmpPrompt/tiePrompt; comparator schema extended for R1/R2).
# --------------------------------------------------------------------------------------
_DERIVE_SYSTEM = (
    "Derive the requested result blindly from the neutral question and raw inputs. Do not assume any answer. "
    "Return ONLY one JSON object with canonical_answer, derivation (the full written derivation, as it would "
    "appear in a paper appendix: every mathematical step stated explicitly, with all premises, conventions, "
    "applicability and diagnostic limits; do not abbreviate it), derivation_summary "
    "(optional navigation summary), confidence (high|medium|low), and checkable_form (strict sympy expression "
    "or empty for non-algebraic answers). Include complete computation source and actual output if used; "
    "say unavailable when actual execution records are unavailable. Never invent execution or provenance."
)
_COMPARE_SYSTEM = (
    "You are an impartial comparator+adjudicator. You are given the canonical answers of candidate derivations of one "
    "claim. Decide which are MATHEMATICALLY EQUIVALENT (not string-equal; e.g. -pi/(4mu) == -(1/4)pi/mu). "
    "Then INDEPENDENTLY RECOMPUTE the answer yourself. Output ONLY a single fenced ```json block with "
    'EXACTLY these keys: "majority_answer" (canonical answer of the largest equivalent cluster), '
    '"majority_size" (int), "majority_indices" (array of the 0-based input indices in that cluster), '
    '"all_equivalent" (bool), "outliers" (each non-majority index + its specific error, or "none"), '
    '"correct_answer_adjudicated" (the answer YOU recompute as correct + one-line reason), '
    '"adjudicated_matches_majority" (bool: does YOUR recomputed answer equal majority_answer?). '
    "No prose outside the json block."
)
_COMBINED_SYSTEM = (
    "You are an impartial comparator+adjudicator. You are given candidate derivations of one "
    "claim. Decide which are MATHEMATICALLY EQUIVALENT (not string-equal; e.g. -pi/(4mu) == -(1/4)pi/mu). "
    "Then INDEPENDENTLY RECOMPUTE the answer yourself. Output ONLY a single fenced ```json block with "
    'EXACTLY these keys: "majority_answer" (canonical answer of the largest equivalent cluster), '
    '"majority_size" (int), "majority_indices" (array of the 0-based input indices in that cluster), '
    '"all_equivalent" (bool), "outliers" (each non-majority index + its specific error, or "none"), '
    '"correct_answer_adjudicated" (the answer YOU recompute as correct + one-line reason), '
    '"adjudicated_matches_majority" (bool: does YOUR recomputed answer equal majority_answer?). '
    "Include independence_assessments and method_risk_assessments as required by the user prompt. No prose outside the json block."
)
_ASSESS_SYSTEM = (
    "You review one written derivation of a claim, supplied as a document. "
    "Read the whole document before writing your assessment. Output ONLY a single fenced ```json block with the key \"independence_assessments\": "
    "an array holding exactly one assessment, for the lane index named in the user prompt. No prose outside the json block."
)
_RISK_SYSTEM = (
    "You review a declared shared failure mode across two written derivations of a claim, supplied as documents. "
    "Read both documents completely before writing your assessment. Output ONLY a single fenced ```json block with the key "
    "\"method_risk_assessments\": an array holding exactly one assessment, for the index pair named in the user prompt. "
    "No prose outside the json block."
)


def _derive_prompt(ctx: str, c: dict, method: str) -> str:
    return (
        f"{ctx}\n\nBLIND TASK (derive from scratch; the answer is NOT given):\n{c['statement']}\n\n"
        f"Suggested route: {method or '(choose any rigorous route)'}\n\n"
        f"Report canonical_answer in EXACTLY this format: {c['report_format']}\n"
        "If your CLI exposes a code-execution / CAS tool (python sympy/mpmath, julia), you MAY use it to "
        "verify integrals/algebra/numerics and show the output; otherwise derive analytically and say so."
    )


def _tiebreak_prompt(ctx: str, c: dict, method: str, prior: list[dict]) -> str:
    # Prior answers are deliberately withheld: asking a reader to ignore them does not un-anchor input.
    return _derive_prompt(ctx, c, method)


def _lane_entry(d: dict, family: str, index: int) -> dict:
    """One lane as every comparator request carries it. Byte-identical copies only consume the request
    budget: original_assistant_output equals transport.raw_output; derivation_context appears only when it
    differs from the structured derivation, and then the lane's transport names it instead of repeating
    the same raw output (packet_transport). No concatenated assessment_source is shipped: source_material()
    is the span check, reading the same texts. Entries are encoded with sorted keys so the transport
    appears to the comparator byte for byte as that check encodes it. transport.captured_records are
    carried per record by packet_transport: a record whose bytes are proven equal to a shipped field or to
    the stream's terminal event goes by reference (path, sha256, size from artifact_refs); a live stream
    is shown as its content, the lane's own text replaced by a reference to the shipped field it is proven
    equal to, every other block and field verbatim; only ids, timing/usage/cost counters, status,
    token-counter and rate-limit events, stream markers, empty thinking and thinking signatures are left
    out; anything else stays inline."""
    entry = {k: v for k, v in d.items() if k != "original_assistant_output"}
    entry.update(index=index, family=family, transport=packet_transport(d))
    context = derivation_body(d)
    if context != d.get("derivation"):
        entry["derivation_context"] = context
    return entry


def _encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


_MATERIAL_RULES = (
    "Read the complete written derivation together with its recorded request, recorded output text and run records. "
    "The structured derivation field is unchanged; transport.raw_output is the recorded output text exactly as returned. "
    "derivation_context is present only when that output holds assistant text outside the selected JSON object; it is then that complete "
    "recorded output text, and the lane's transport marks raw_output_given_as=derivation_context instead of repeating the same bytes. "
    "transport.captured_records states for each captured file how it is carried: inline (content verbatim), by_reference "
    "(ref = path, sha256, size, with the equality proven at assembly), or content_blocks for a run's event log: its entries in "
    "recorded order, where a text value given as {equals, sha256} is exactly the complete named shipped field (proven equal at "
    "assembly) and every other entry and field is verbatim; only bookkeeping is not shown (ids, timestamps, usage, cost and "
    "timing counters, status, counter and rate-limit entries, start/stop markers, empty blocks and opaque signature fields). "
    "Check whether earlier text contains necessary steps, contradictions, repetitions or unrelated commentary. "
    "Do not assume all text is a derivation, or that one selected JSON field contains every necessary step. "
    "If the JSON already contains the complete derivation, retain that contract and substantively explain coverage of earlier text. "
    "Summaries, author assertions of freshness and labels cannot substitute for the written material itself. "
)


def _material_section(entries: list[dict], frozen: Optional[dict] = None) -> str:
    """The lane material of one request: inline as JSON, or, when it does not fit one request, as frozen part
    files the comparator reads completely with the Read tool."""
    if frozen is None:
        return "FULL_DERIVATION_RECORDS_JSON:\n" + _encoded(entries) + "\n\n"
    lines = ["FULL_DERIVATION_RECORDS_FILES:"]
    for entry in entries:
        parts = frozen[entry["index"]]
        lines.append(f"lane #{entry['index']}: {len(parts)} part files; joined, they are this lane's record encoded as one JSON object")
        lines += [f"  {f['path']} (sha256 {f['sha256']}, {f['size']} bytes, {f['lines']} lines)" for f in parts]
    return "\n".join(lines) + (
        "\n\nThis document is too long for one message, so it is stored on disk as the part files listed above, whose bytes "
        "and sha256 were fixed before you started. Open every listed part with the Read tool so that each line of each part is "
        "shown to you, from the first line to the last (one Read call holds a part; offset and limit are fine as long as every line "
        "is shown). The parts are consecutive pieces of one JSON text: put the lines of all parts of a lane together in the listed "
        "order with nothing between them (a piece ends after each \\n escape or after at most "
        f"{WRAP_CHARS} characters, never inside an escape). The assessment is used only if every line of every listed file was "
        "shown to you by the Read tool, so finish reading all parts first and write the assessment in your last message, after the "
        "last Read. Do not use other files or tools instead.\n\n")


def _assess_prompt(ctx: str, c: dict, entry: dict, frozen: Optional[dict] = None) -> str:
    i = entry["index"]
    return (
        f"{ctx}\n\nClaim:\n{c['statement']}\nExpected canonical format: {c['report_format']}\n\n"
        f"This request holds the complete material of ONE candidate derivation, lane #{i} (recorded model family {entry['family']}). "
        "Each lane is assessed in its own request holding that lane's complete material; equivalence and adjudication are decided separately.\n\n"
        + _material_section([entry], frozen) + _MATERIAL_RULES +
        f"Provide independence_assessments with exactly one entry, index {i}. "
        "It has booleans input_independent, execution_independent, construction_independent, method_applicable, diagnostic; "
        "unresolved_defects (array); observed_method (source-grounded description, not the hint); evidence with input, execution, "
        "construction, applicability, diagnostic. Each entry quotes an exact source_span plus a substantive reason: construction/applicability/diagnostic MUST quote, when derivation_context is present, its text OUTSIDE every answer-shaped JSON object (the selected one and any other decodable JSON object with a canonical_answer or derivation_summary key, e.g. drafts or wrappers), or the COMPLETE structured derivation body as read; the fields of those objects are never derivation steps; input/execution may also quote the transport record exactly as shown (request, raw_output, invocation, captured_records) or any of its decoded string values, or derivation_summary. "
        "Equivalence between answers is decided elsewhere from the stated answers only, so say here whether the written steps of this "
        "derivation arrive at its stated canonical_answer: answer_support {supports_canonical_answer:boolean, source_span (the concluding "
        "steps as written, quoted under the construction rule), reason}; false when the written steps reach a different result, "
        "contradict it or do not reach it. "
        "Reject missing written steps or records, failed invocations, text copied from another lane, reruns of the original code, contaminated inputs, "
        "known relevant defects and non-diagnostic checks. Same/similar methods, same family and shared legitimate libraries alone do not reject. "
        "Missing material is unavailable, never approval."
    )


def _risk_prompt(ctx: str, c: dict, entries: list[dict], frozen: Optional[dict] = None) -> str:
    pair = [e["index"] for e in entries]
    return (
        f"{ctx}\n\nClaim:\n{c['statement']}\nExpected canonical format: {c['report_format']}\n\n"
        f"This request holds the complete material of TWO candidate derivations, lanes #{pair[0]} and #{pair[1]}.\n\n"
        + _material_section(entries, frozen) + _MATERIAL_RULES +
        f"Explicit method risk required: {c.get('requires_method_diversity') is True}. Declared risk: {c.get('method_diversity_risk', 'assess shared failure modes substantively')}. "
        f"Provide method_risk_assessments with exactly one entry, indices {pair}: {{indices:[i,j], addresses_shared_failure:boolean, methods_distinct:boolean (actual mechanisms, never hint labels), risk:string, method_analysis:string, "
        "evidence:[{index,source_span,reason} from each lane's derivation_context text outside every decodable answer-shaped JSON object when present or its COMPLETE structured derivation BODY as read, never fields of those objects, request or metadata]}. Approval must explain with both actual derivations why the declared shared "
        "failure mode is independently tested or avoided through substantively distinct mechanisms; differently named hints or rewordings do not establish orthogonality. "
        "Missing material or unsupported risk assessment is unavailable, never approval."
    )


def _combined_prompt(ctx: str, c: dict, derivations: list[dict], families: list[str]) -> str:
    """One request holding every lane's complete material: clustering, recomputation, every lane's assessment
    and any method risk in one comparator context, as when every lane fits one request."""
    listing = "\n".join(f'[#{i}] (family={families[i]}) canonical_answer="{d["canonical_answer"]}" | {d["derivation_summary"]}'
                        for i, d in enumerate(derivations))
    # Entries exactly as the earlier single request carried them: the listing above names each index.
    packet = [{k: v for k, v in _lane_entry(d, families[i], i).items() if k != "index"} | ({"index": d["index"]} if "index" in d else {})
              for i, d in enumerate(derivations)]
    return (
        f"{ctx}\n\nClaim:\n{c['statement']}\nExpected canonical format: {c['report_format']}\n\n"
        f"{len(derivations)} candidate derivations with recorded model-family metadata:\n{listing}\n\n"
        "FULL_DERIVATION_RECORDS_JSON:\n" + json.dumps(packet, ensure_ascii=False, sort_keys=True) + "\n\n"
        "Read the COMPLETE original derivations and runtime-observed requests, raw outputs and execution records. "
        "The structured derivation field is unchanged; transport.raw_output is the exact original assistant output. "
        "derivation_context is present only when that output holds assistant text outside the selected JSON object; it is then that complete "
        "original output, and the lane's transport marks raw_output_given_as=derivation_context instead of repeating the same bytes. "
        "transport.captured_records states for each captured file how it is carried: inline (content verbatim), by_reference "
        "(ref = path, sha256, size, with the equality proven at assembly), or content_blocks for a live stream: its content in "
        "emission order, where a text value given as {equals, sha256} is exactly the complete named shipped field (proven equal at "
        "assembly) and every other block and field is verbatim; only ids, timestamps, usage, cost and timing counters, status, "
        "token-counter and rate-limit events, stream markers, empty thinking blocks and thinking signatures are not shown. "
        "Check whether earlier text contains necessary steps, contradictions, repetitions or unrelated commentary. "
        "Do not assume all text is a derivation, or that one selected JSON field contains every necessary step. "
        "If the JSON already contains the complete derivation, retain that contract and substantively explain coverage of earlier text. "
        "Summaries, author assertions of freshness and labels cannot substitute for original material. "
        "Cluster by mathematical equivalence, independently recompute, and provide independence_assessments for EVERY index. "
        "majority_answer must be an exact canonical_answer representative from its majority_indices; no empty or unenumerated cluster can converge. "
        "Each has booleans input_independent, execution_independent, construction_independent, method_applicable, diagnostic; "
        "unresolved_defects (array); observed_method (source-grounded description, not the hint); evidence with input, execution, "
        "construction, applicability, diagnostic. Each entry quotes an exact source_span plus a substantive reason: construction/applicability/diagnostic MUST quote, when derivation_context is present, its text OUTSIDE every answer-shaped JSON object (the selected one and any other decodable JSON object with a canonical_answer or derivation_summary key, e.g. drafts or wrappers), or the COMPLETE structured derivation body as read; the fields of those objects are never derivation steps; input/execution may also quote the transport record exactly as shown (request, raw_output, invocation, captured_records) or any of its decoded string values, or derivation_summary. "
        "Reject absent original steps/transport, failed invocations, copied reasoning, original-code reruns, contaminated inputs, "
        "known relevant defects and non-diagnostic checks. Same/similar methods, same family and shared legitimate libraries alone do not reject. "
        f"Explicit method risk required: {c.get('requires_method_diversity') is True}. Declared risk: {c.get('method_diversity_risk', 'assess shared failure modes substantively')}. "
        "Provide method_risk_assessments: array of {indices:[i,j], addresses_shared_failure:boolean, methods_distinct:boolean (actual mechanisms, never hint labels), risk:string, method_analysis:string, "
        "evidence:[{index,source_span,reason} from each lane's derivation_context text outside every decodable answer-shaped JSON object when present or its COMPLETE structured derivation BODY as read, never fields of those objects, request or metadata]}. Approval must explain with both actual derivations why the declared shared "
        "failure mode is independently tested or avoided through substantively distinct mechanisms; differently named hints or rewordings do not establish orthogonality. "
        "Missing material or unsupported risk assessment is unavailable, never approval."
    )


def _joint_prompt(ctx: str, c: dict, derivations: list[dict], families: list[str]) -> str:
    listing = "\n".join(f'[#{i}] (family={families[i]}) canonical_answer="{d["canonical_answer"]}" | {d["derivation_summary"]}'
                        for i, d in enumerate(derivations))
    return (
        f"{ctx}\n\nClaim:\n{c['statement']}\nExpected canonical format: {c['report_format']}\n\n"
        f"{len(derivations)} candidate answers with recorded model-family metadata:\n{listing}\n\n"
        "Cluster these canonical answers by mathematical equivalence and independently recompute the answer. "
        "majority_answer must be an exact canonical_answer representative from its majority_indices; no empty or unenumerated cluster can converge. "
        "The complete original material of each lane is assessed in separate requests, one lane per request, and the summaries above are "
        "navigation only; do not assess independence here."
    )


# --------------------------------------------------------------------------------------
# Backend runner adapter — invokes review-swarm's run_multi_task.py once per (spec, prompt).
# Injectable: the gate takes any callable run(spec, system, prompt, tag) -> str|None.
# --------------------------------------------------------------------------------------
RunFn = Callable[[str, str, str, str], Optional[str]]

# A provider safeguard stop is a refusal of this request, not an empty derivation and not an
# infrastructure failure. The CLI reports it as stop_reason "refusal" in the stream and, when it
# gives up, as an "API Error: ... safeguards flagged this message ... Details: `[code]`" text.
_PROVIDER_STOP_TEXT = re.compile(r"safeguards flagged this message")
_PROVIDER_STOP_DETAIL = re.compile(r"Details:\s*`?\[(\w+)\]")


def provider_stop(raw: Optional[str] = None, attempts: Optional[Path] = None) -> Optional[dict]:
    """Return the provider refusal recorded in returned text or captured stream records, else None."""
    texts, stopped, details = [], False, set()
    if isinstance(raw, str) and not parse_derivation(raw):
        texts.append(raw)  # a returned derivation is never read as an error message
    for path in sorted(attempts.glob("run.*/*")) if attempts is not None else []:
        try:
            body = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        if path.suffix == ".log":  # error and stderr logs; answer text files are not scanned
            texts.append(body)
            continue
        if path.suffix != ".jsonl":
            continue
        for line in body.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            event = record.get("event") if record.get("type") == "stream_event" else None
            delta = event.get("delta") if isinstance(event, dict) else None
            message = record.get("message") if record.get("type") == "assistant" else None
            for carrier in (delta, message, record if record.get("type") == "result" else None):
                if isinstance(carrier, dict) and carrier.get("stop_reason") == "refusal":
                    stopped = True
                    category = (carrier.get("stop_details") or {}).get("category") if isinstance(carrier.get("stop_details"), dict) else None
                    if isinstance(category, str) and category:
                        details.add(category)
            if record.get("type") == "result" and record.get("is_error") and isinstance(record.get("result"), str):
                texts.append(record["result"])
    lines = [line.strip() for t in texts for line in t.splitlines() if _PROVIDER_STOP_TEXT.search(line)]
    if not stopped and not lines:
        return None
    details |= {m for t in texts if _PROVIDER_STOP_TEXT.search(t) for m in _PROVIDER_STOP_DETAIL.findall(t)}
    return {"stop_reason": "provider_refusal", "details": sorted(details),
            "message": lines[0] if lines else None}


class MultiTaskRunner:
    def __init__(self, *, runner_path: Path, work_dir: Path, timeout: int, tools: bool,
                 config: Optional[str], python_exe: str = sys.executable, live_capture: bool = True,
                 context_tokens: int = 200000, context_bytes: Optional[int] = None):
        self.runner_path = runner_path
        self.work_dir = work_dir
        self.timeout = timeout
        self.tools = tools
        self.config = config
        self.python_exe = python_exe
        self.live_capture = live_capture
        self.request_budgets = request_budgets(context_tokens, context_bytes)
        self.invocations: dict[str, dict] = {}

    def run(self, spec: str, system: str, prompt: str, tag: str) -> Optional[str]:
        return self._invoke(spec, system, prompt, tag)

    def run_reading(self, spec: str, system: str, prompt: str, tag: str, material_dir: Path) -> Optional[str]:
        """A comparator call that reads frozen lane material: only read-only file tools (Read, Glob, Grep),
        working directory = the frozen material directory, live capture so every read and its returned
        content is recorded."""
        return self._invoke(spec, system, prompt, tag, cwd=Path(material_dir), read_only_tools=True)

    def _invoke(self, spec: str, system: str, prompt: str, tag: str, *, cwd: Optional[Path] = None,
                read_only_tools: bool = False) -> Optional[str]:
        backend = family_of(spec)
        parent = self.work_dir / tag.replace("/", "__")
        parent.mkdir(parents=True, exist_ok=True)
        d = Path(tempfile.mkdtemp(prefix="invocation-", dir=parent))
        sysf, promptf, outf = d / "system.txt", d / "prompt.txt", d / "out.txt"
        outf.unlink(missing_ok=True)
        sysf.write_text(system, encoding="utf-8")
        promptf.write_text(prompt, encoding="utf-8")
        cmd = [
            self.python_exe, str(self.runner_path),
            "--out-dir", str(d), "--system", str(sysf), "--prompt", str(promptf),
            "--models", spec, "--backend-output", f"{backend}={outf}",
            "--output-prefix", "d", "--timeout-secs", str(self.timeout), "--max-attempts", "1", "--no-parallel",
            "--context-tokens", str(self.request_budgets["context_tokens"]),
        ]
        if self.live_capture and backend == "claude":
            cmd.append("--claude-live-capture")
        if self.config:
            cmd += ["--config", str(Path(self.config).resolve())]
        if read_only_tools:
            cmd += ["--backend-tool-mode", f"{backend}=review"]
        elif self.tools and backend in _TOOL_MODES:
            cmd += ["--backend-tool-mode", f"{backend}={_TOOL_MODES[backend]}"]
        # Hermetic run: the runner otherwise auto-discovers .nullius/review-swarm.json up the git
        # tree (exactly where this skill runs) and would bleed REVIEW config — flipping on the review
        # contract sanitizers + injecting tool modes — into the derivation pass. Disabling auto-config
        # makes the gate reproducible and config-independent; an explicit --config is still honored.
        env = {**os.environ, "REVIEW_SWARM_NO_AUTO_CONFIG": "1"}
        try:
            proc = subprocess.run(cmd, timeout=self.timeout if self.timeout else None,
                                  capture_output=True, text=True, check=False, env=env, cwd=cwd)
            self.invocations[tag] = {"exit_code": proc.returncode, "model": spec, "stdout": proc.stdout, "stderr": proc.stderr,
                                     "system": str(sysf), "prompt": str(promptf), "output": str(outf),
                                     "work_dir": str(d), "meta": str(d / "meta.json")}
            # Checked before the exit code: after a stop the CLI may continue once and exit 0.
            stop = provider_stop(attempts=Path(str(outf) + ".attempts"))
            if stop:
                self.invocations[tag]["provider_stop"] = stop
                return None
            if proc.returncode != 0:
                return None
        except (subprocess.TimeoutExpired, OSError):
            self.invocations[tag] = {"exit_code": None, "model": spec, "work_dir": str(d), "meta": str(d / "meta.json")}
            return None
        if not outf.exists():
            return None
        try:
            txt = outf.read_bytes().decode("utf-8")
        except (OSError, UnicodeError):
            return None
        return txt if txt.strip() else None


# --------------------------------------------------------------------------------------
# The gate (per claim) — cross-model derive -> adjudicate -> diversity-first tie-break to converge.
# --------------------------------------------------------------------------------------
def _aggregate_judges(verdicts: list, n_derivations: int, derivations: Optional[list[dict]] = None) -> tuple:
    """Meta-judge aggregation of a cross-family comparator PANEL into one verdict (SOTA: multiple judges
    surface single-judge anchoring/bias). Returns (cmp, n_ok). MUST be EQUAL-or-STRICTER than a single
    judge — never converge what no judge endorsed.

    Votes on the whole NORMALIZED CLUSTER SET (not marginal per-index): a claim's agreeing cluster is the
    index-set a STRICT MAJORITY of judges proposed *as a set*, and the veto must be JOINTLY attached to
    THAT cluster by a majority of its backers. (Per-index + per-veto marginal tallies were unsound — two
    independent reviewers showed they could synthesize a (cluster, veto) pair no judge ever jointly
    affirmed, making convergence EASIER than one judge; cross-model review caught this.) Single judge ->
    exact identity. Empty / no-majority-cluster -> SAFE_CMP (unconverged)."""
    from collections import Counter
    ok = [v for v in verdicts if v]
    if not ok:
        return dict(SAFE_CMP), 0
    if len(ok) == 1:
        return dict(ok[0]), 1  # exact single-judge identity (default behaviour unchanged)
    need = len(ok) // 2 + 1  # strict majority

    def norm(v):
        return tuple(sorted({i for i in (v.get("majority_indices") or [])
                             if isinstance(i, int) and 0 <= i < n_derivations}))

    cluster_votes = Counter(n for n in (norm(v) for v in ok) if n)  # ignore empty clusters
    cluster, votes = cluster_votes.most_common(1)[0] if cluster_votes else ((), 0)
    if votes < need:  # no cluster a strict majority of judges endorsed AS A SET -> do not converge
        return ({**dict(SAFE_CMP),
                 "majority_answer": Counter(v.get("majority_answer", "") for v in ok).most_common(1)[0][0],
                 "outliers": f"no strict-majority cluster across {len(ok)} judges",
                 "correct_answer_adjudicated": ok[0].get("correct_answer_adjudicated", "")}, len(ok))
    backers = [v for v in ok if norm(v) == cluster]
    # Vote on complete source-validated lane sets jointly with this cluster and
    # adjudication. Free-text reasons need not match; individual axes cannot be
    # assembled from different judges into an approval nobody gave.
    assessments, risk_assessments, joint_adjudication = [], [], ""
    if derivations is not None:
        complete_votes = []
        for v in backers:
            if v.get("adjudicated_matches_majority") is True:
                lanes = tuple(i for i in assessed_indices(derivations, v.get("independence_assessments", [])) if i in cluster)
                if len(lanes) >= 2:
                    complete_votes.append((lanes, v))
        counts = Counter(lanes for lanes, _ in complete_votes)
        lanes, approvals = counts.most_common(1)[0] if counts else ((), 0)
        if approvals >= need:
            lane_backers = [v for actual, v in complete_votes if actual == lanes]
            assessments = [a for a in lane_backers[0].get("independence_assessments", []) if a.get("index") in lanes]
            joint_adjudication = lane_backers[0].get("correct_answer_adjudicated", "")
            pair_votes = {}
            for v in lane_backers:
                seen_pairs = set()
                for r in v.get("method_risk_assessments", []) if isinstance(v.get("method_risk_assessments"), list) else []:
                    if method_risk_passes(derivations, list(lanes), [r]):
                        pair = tuple(sorted(r["indices"]))
                        if pair not in seen_pairs:
                            pair_votes.setdefault(pair, []).append(r)
                            seen_pairs.add(pair)
            risk_assessments = [records[0] for records in pair_votes.values() if len(records) >= need]
    cmp = {
        "majority_answer": Counter(v.get("majority_answer", "") for v in backers).most_common(1)[0][0],
        "majority_size": len(cluster),
        "independence_assessments": assessments,
        "method_risk_assessments": risk_assessments,
        "majority_indices": list(cluster),
        "all_equivalent": sum(1 for v in backers if v.get("all_equivalent")) >= need,
        # veto JOINTLY attached to THIS cluster by a strict majority (of all judges, not just backers)
        "adjudicated_matches_majority": sum(1 for v in backers if v.get("adjudicated_matches_majority")) >= need,
        "outliers": " || ".join(f"judge{j}: {v.get('outliers', '')}" for j, v in enumerate(ok)),
        "correct_answer_adjudicated": joint_adjudication,
    }
    return cmp, len(ok)


def _plan_requests(c, ctx, derivations, families, budgets, material_root):
    """Every comparator request of one comparison, decided before any comparator starts. When every lane fits
    one request, that single request holds every lane's complete material (clustering, recomputation, every
    assessment and any method risk in one context, as before). Otherwise there is a joint
    equivalence/adjudication request over the canonical answers, one assessment request per lane holding that
    lane's complete material, and, for an explicit method risk, one request per lane pair holding both complete
    materials. Such a request carries its material inline when it fits the window; otherwise the material is
    frozen to read-only part files (bytes + sha256) in a directory of that request's own, holding only its
    lanes. Length decides only how material is carried, never whether it is assessed."""
    from itertools import combinations
    combined = _combined_prompt(ctx, c, derivations, families)
    try:
        validate_request_bytes(_COMBINED_SYSTEM, combined, budgets)
        return [{"kind": "combined", "lanes": tuple(range(len(derivations))), "system": _COMBINED_SYSTEM,
                 "mode": "inline", "prompt": combined}]
    except ValueError:
        pass
    entries = [_lane_entry(d, families[i], i) for i, d in enumerate(derivations)]
    plans = [{"kind": "joint", "lanes": (), "system": _COMPARE_SYSTEM, "mode": "inline",
              "prompt": _joint_prompt(ctx, c, derivations, families)}]
    groups = [("lane", (i,)) for i in range(len(entries))]
    if c.get("requires_method_diversity") is True:
        groups += [("pair", pair) for pair in combinations(range(len(entries)), 2)]
    for kind, lanes in groups:
        chosen = [entries[i] for i in lanes]
        system = _ASSESS_SYSTEM if kind == "lane" else _RISK_SYSTEM
        build = (lambda f, chosen=chosen: _assess_prompt(ctx, c, chosen[0], f)) if kind == "lane" else (lambda f, chosen=chosen: _risk_prompt(ctx, c, chosen, f))
        prompt = build(None)
        try:
            validate_request_bytes(system, prompt, budgets)
            plans.append({"kind": kind, "lanes": lanes, "system": system, "mode": "inline", "prompt": prompt})
            continue
        except ValueError:
            pass
        plan = {"kind": kind, "lanes": lanes, "system": system, "mode": "files", "prompt": None}
        if material_root is not None:
            directory = material_root / ("-".join([kind] + [str(i) for i in lanes]))
            frozen = {i: freeze_material(_encoded(entries[i]), directory, f"lane-{i}") for i in lanes}
            plan.update(prompt=build(frozen), frozen=[f for i in lanes for f in frozen[i]], directory=directory.resolve())
        plans.append(plan)
    return plans


def _compare(c, ctx, derivations, families, comparators: list, run: RunFn, *, tag: str) -> tuple:
    """Run the comparator PANEL (>=1 model families) and meta-aggregate. When every lane fits one request, each
    judge makes that single request holding every lane, as before. Otherwise each judge makes one joint request
    (equivalence + independent recomputation over the canonical answers) and one assessment request per lane
    (plus one per lane pair for an explicit method risk), each holding the complete material it assesses; a
    lane assessment then counts only with span-backed answer support. A judge's verdict is assembled from its
    own requests only, then aggregated exactly as before. A judge counts in n_ok once its joint request gave a
    verdict, even when none of its lane requests did; that can only raise the panel's majority need."""
    if not derivations:
        return dict(SAFE_CMP), 0
    owner = getattr(run, "__self__", None)
    configured = getattr(run, "request_budgets", getattr(owner, "request_budgets", {}))
    budgets = request_budgets(configured.get("context_tokens", 200000), configured.get("context_bytes"))
    receipts = getattr(run, "invocations", getattr(owner, "invocations", None))
    reader = getattr(run, "run_reading", getattr(owner, "run_reading", None))
    work_dir = getattr(run, "work_dir", getattr(owner, "work_dir", None))
    material_root = None
    if reader is not None and receipts is not None and work_dir is not None:
        Path(work_dir).mkdir(parents=True, exist_ok=True)
        material_root = Path(tempfile.mkdtemp(prefix=tag.replace("/", "__") + ".material-", dir=work_dir)).resolve()
    plans = _plan_requests(c, ctx, derivations, families, budgets, material_root)
    if material_root is not None and not any(p["mode"] == "files" for p in plans):
        material_root.rmdir()
    evidence = [{"tag": f"{tag}_j{j}_{roster_family_of(spec)}", "model": spec, "requests": []} for j, spec in enumerate(comparators)]
    keys = {"combined": {"majority_size", "majority_answer"}, "joint": {"majority_size", "majority_answer"}, "lane": {"independence_assessments"}, "pair": {"method_risk_assessments"}}

    def _unreadable(spec, plan):
        """Why this judge cannot be shown a frozen-file request completely, decided before dispatch."""
        if plan["mode"] != "files":
            return None
        if plan["prompt"] is None or reader is None or receipts is None:
            return (NOT_READ + ": the lane material exceeds one request and this runner cannot show "
                    "the comparator's file reads; nothing is truncated")
        if family_of(spec) != "claude":
            return (NOT_READ + ": only a comparator whose capture records each file read and the content "
                    "returned to it (Claude CLI live capture) can read material larger than one request")
        return None

    # A judge that can assess fewer than two lanes completely cannot support any convergence: none of its
    # requests is sent, and each records why.
    hopeless = set() if plans[0]["kind"] == "combined" else {j for j, spec in enumerate(comparators)
                if sum(1 for p in plans if p["kind"] == "lane" and _unreadable(spec, p) is None) < 2}

    def _request(job):
        j, spec, k, plan = job
        call_tag = evidence[j]["tag"] + ("" if plan["kind"] in ("joint", "combined") else
                                         f"_lane{plan['lanes'][0]}" if plan["kind"] == "lane" else f"_pair{plan['lanes'][0]}-{plan['lanes'][1]}")
        record = {"kind": plan["kind"], "lanes": list(plan["lanes"]), "tag": call_tag, "carried": plan["mode"]}
        system, prompt = plan["system"], plan["prompt"]
        raw = None
        try:  # one request's failure must drop to None, not abort the panel (ex.map re-raises)
            reason = _unreadable(spec, plan)
            if reason is None and j in hopeless:
                reason = "unavailable: fewer than two lanes can be shown completely to this comparator; no request was sent"
            if reason is not None:
                raise ValueError(reason)
            if plan["mode"] == "files":
                validate_request_bytes(system, prompt, budgets)
                raw = reader(spec, system, prompt, call_tag, plan["directory"])
                # The CLI's stop message carries no JSON; a verdict may quote lane text that mentions it.
                if isinstance(raw, str) and "{" not in raw and provider_stop(raw):
                    raise ValueError("unavailable: provider safeguard stopped the comparator")
                invocation = receipts.get(call_tag, {})
                capacity = validate_request_capacity(system, prompt, invocation, budgets,
                    expected_working_directory=str(plan["directory"]), usage_per_call=True)
                if any(item["output_tokens"] > OUTPUT_RESERVE for item in capacity["observed_usage"]):
                    raise ValueError("unavailable: observed comparator output exceeds configured output budget")
                if not isinstance(raw, str) or Path(invocation["output"]).read_bytes().decode("utf-8") != raw:
                    raise ValueError("unavailable: comparator return differs from observed current report")
                if not capacity.get("capture_stream"):
                    raise ValueError(NOT_READ + ": no captured stream of the comparator's reads")
                coverage = read_coverage(Path(capacity["capture_stream"]).read_text(encoding="utf-8"), plan["frozen"], plan["directory"])
                record["read_coverage"] = {k: v for k, v in coverage.items() if k != "final_text"}
                if not coverage["complete"]:
                    raise ValueError(coverage["reason"])
                if extract_json(coverage["final_text"], prefer_keys=keys[plan["kind"]]) != extract_json(raw, prefer_keys=keys[plan["kind"]]):
                    raise ValueError(NOT_READ + ": the verdict was not given in a final message after the last read")
            else:
                bound = validate_request_bytes(system, prompt, budgets)
                # The injected host callable has no CLI capture/token protocol. Its
                # full input plus output reserve must fit conservatively before call.
                if receipts is None and bound + OUTPUT_RESERVE > budgets["context_tokens"]:
                    raise ValueError("unavailable: host comparator request exceeds conservative token window")
                working_directory = str(Path.cwd().resolve())
                raw = run(spec, system, prompt, call_tag)
                if isinstance(raw, str) and "{" not in raw and provider_stop(raw):
                    raise ValueError("unavailable: provider safeguard stopped the comparator")
                if receipts is not None:
                    invocation = receipts.get(call_tag, {})
                    capacity = validate_request_capacity(system, prompt, invocation, budgets,
                        expected_working_directory=working_directory)
                    if any(item["output_tokens"] > OUTPUT_RESERVE for item in capacity["observed_usage"]):
                        raise ValueError("unavailable: observed comparator output exceeds configured output budget")
                    if not isinstance(raw, str) or Path(invocation["output"]).read_bytes().decode("utf-8") != raw:
                        raise ValueError("unavailable: comparator return differs from observed current report")
                else:
                    if not isinstance(raw, str) or not raw.strip():
                        raise ValueError("unavailable: host comparator invocation returned no output")
                    emitted_bound = len(raw.encode("utf-8"))
                    if emitted_bound > OUTPUT_RESERVE or bound + emitted_bound > budgets["context_tokens"]:
                        raise ValueError("unavailable: host comparator output exceeds conservative output/window budget")
                    capacity = {**budgets, "conservative_input_bound": bound,
                        "conservative_output_bound": emitted_bound, "capacity_evidence": "conservative_host_bound",
                        "observed_usage": [], "compaction_witness": "unavailable", "capture_observation": "unavailable"}
            if plan["kind"] in ("joint", "combined"):
                parsed = parse_comparison(raw, len(derivations))
            elif plan["kind"] == "lane":
                parsed = [a for a in parse_lane_assessment(raw, plan["lanes"][0]) or []
                          if answer_supported(derivations[plan["lanes"][0]], a)] or None
            else:
                parsed = parse_pair_risk(raw, plan["lanes"])
            record.update(status="completed", capacity=capacity)
            return j, k, parsed
        except Exception as exc:
            receipts_now = getattr(run, "invocations", getattr(owner, "invocations", None))
            stop = (receipts_now.get(call_tag, {}).get("provider_stop") if isinstance(receipts_now, dict) else None) or (
                provider_stop(raw) if isinstance(raw, str) and "{" not in raw else None)
            record.update(status="provider_refusal", **stop) if stop else record.update(status="unavailable", reason=str(exc))
            return j, k, None
        finally:
            evidence[j]["requests"].append(record)

    jobs = [(j, spec, k, plan) for j, spec in enumerate(comparators) for k, plan in enumerate(plans)]
    with cf.ThreadPoolExecutor(max_workers=max(1, min(8, len(jobs)))) as ex:
        results = list(ex.map(_request, jobs))
    verdicts = []
    for j, judge in enumerate(evidence):
        order = [(p["kind"], list(p["lanes"])) for p in plans]
        judge["requests"].sort(key=lambda r: order.index((r["kind"], r["lanes"])))
        own = {k: parsed for jj, k, parsed in results if jj == j}
        joint = own.get(0)
        unavailable = [r["reason"] for r in judge["requests"] if r["status"] == "unavailable"]
        refused = [r for r in judge["requests"] if r["status"] == "provider_refusal"]
        judge.update(status="provider_refusal" if refused else "unavailable" if unavailable else "completed",
                     capacity=judge["requests"][0].get("capacity"))
        if refused:
            judge.update({k: v for k, v in refused[0].items() if k not in ("kind", "lanes", "tag", "carried", "status")})
        if unavailable:
            judge["reason"] = "; ".join(dict.fromkeys(unavailable))
        if not isinstance(joint, dict):
            verdicts.append(None)
            continue
        if plans[0]["kind"] == "combined":
            verdicts.append(joint)  # one request held every lane's complete material: its verdict as returned
            continue
        # The joint request holds no lane material: any assessment it volunteers is discarded, never merged.
        verdicts.append({**joint,
            "independence_assessments": [a for k, plan in enumerate(plans) if plan["kind"] == "lane" for a in (own.get(k) or [])],
            "method_risk_assessments": [r for k, plan in enumerate(plans) if plan["kind"] == "pair" for r in (own.get(k) or [])]})
    cmp, n_ok = _aggregate_judges(verdicts, len(derivations), derivations)
    cmp["assessment_input_sha256"] = hashlib.sha256(json.dumps(derivations, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    # comparison_form says whether one request held every lane, or lanes were assessed one per request; in
    # the latter no request reads two lanes' bodies except pair requests for an explicit method risk.
    cmp["request_capacity"] = {"configured": budgets, "judges": evidence,
                               "comparison_form": "single_request" if plans[0]["kind"] == "combined" else "per_lane",
                               "material": str(material_root) if material_root is not None and material_root.exists() else None}
    return cmp, n_ok


def _execute_derivation(run, spec, system, prompt, tag, refusals: Optional[list] = None):
    raw = run(spec, system, prompt, tag)
    owner = getattr(run, "__self__", None)
    invocations = getattr(run, "invocations", getattr(owner, "invocations", None))
    invocation = invocations.get(tag, {}) if isinstance(invocations, dict) else {}
    stop = invocation.get("provider_stop") or provider_stop(raw)
    if stop:
        # Recorded as a refusal of this lane; it never enters the derivations or their families.
        if refusals is not None:
            refusals.append({"execution_id": tag, "model": spec, "family": roster_family_of(spec), **stop})
        return None
    result = parse_derivation(raw)
    if not result:
        return None
    request = {"system": system, "prompt": prompt}
    # Real adapters must furnish their observed successful process receipt. An injected host RunFn
    # has the documented str=success / None=terminal-failure interface and is tested separately.
    exit_code = invocation.get("exit_code") if invocations is not None else 0
    artifacts = []
    captured = {}
    for key in ("system", "prompt", "output", "meta"):
        if invocation.get(key) and Path(invocation[key]).is_file():
            path = Path(invocation[key]); data = path.read_bytes()
            artifacts.append({"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
    if invocation.get("output"):
        for path in Path(invocation["output"] + ".attempts").glob("run.*/*"):
            if path.is_file():
                # One read per file: the reference and the captured text describe the same bytes.
                data = path.read_bytes()
                artifacts.append({"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
                if path.suffix in {".json", ".jsonl", ".log"}:
                    captured[str(path)] = data.decode("utf-8")
    result.update(execution_id=tag, transport={"execution_id": tag, "exit_code": exit_code,
        "request": request, "raw_output": raw, "request_sha256": hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
        "output_sha256": hashlib.sha256(raw.encode()).hexdigest(), "invocation": invocation, "captured_records": captured, "artifact_refs": artifacts})
    return observe_runtime_derivation(result)


def _method_risk_satisfied(c, derivations, cmp):
    return c.get("requires_method_diversity") is not True or method_risk_passes(
        derivations, cmp.get("accepted_indices", []), cmp.get("method_risk_assessments", []))


def verify_claim(c: dict, *, ctx: str, pool: list[str], comparators: list, max_iter: int, run: RunFn,
                 unavailable: Optional[Callable[[str], bool]] = None) -> dict:
    invalid = [key for key, expected in (("requires_method_diversity", bool), ("method_diversity_risk", str))
               if key in c and type(c[key]) is not expected]
    if invalid:
        return {"claim": c.get("id"), "status": "unavailable", "verification": "invalid_claim_controls",
                "converged": False, "independent_confirmations": 0, "cross_family_confirmations": 0,
                "judges": 0, "native_seeded": 0, "native_dropped": [], "families": [],
                "total_derivations": 0, "derivation_records": [], "provider_refusals": [], "iterate_rounds": 0,
                "agreed_answer": None, "adjudicated_correct": None, "adjudicated_matches_majority": False,
                "independence_evidence": {"accepted_evidence_indices": []},
                "failure_reason": "Invalid claim control types: " + ", ".join(invalid), "outliers": None}
    methods = [c.get("method0", ""), c.get("method1", "")]
    derivations: list[dict] = []
    families: list[str] = []
    used: list[str] = []
    refusals: list[dict] = []

    # External native records remain readable but cannot supply runtime-owned observation.
    # Unverifiable records are unavailable and do not suppress available CLI executions.
    #
    # With an agents file in force, a native derivation must land in a DECLARED family that is
    # not declared unavailable: an unattributable tag (e.g. the gateway alias "opencode") could
    # sit beside a roster-attributed CLI family and count one physical family twice, and a tag
    # claiming a family the file declares unavailable on this machine is most plausibly a
    # mislabel — both are dropped VISIBLY (native_dropped in the row), never silently absorbed.
    native_families: set = set()
    native_dropped: list = []
    native_unavailable: list = []
    roster_families = (_AGENTS_ROSTER.get("families") or {}) if _AGENTS_ROSTER is not None else None
    for raw in (c.get("native_derivations") or []):
        nat = parse_native_derivation(raw)
        if not nat:
            continue
        fam = nat.pop("family")
        if not valid_derivation_transport(nat):
            native_dropped.append(fam)
            native_unavailable.append({"family": fam, "reason": "External native seeds lack runtime-owned invocation observation; no validated external capture authority is supported."})
            continue
        if roster_families is not None:
            fam_decl = roster_families.get(fam)
            if not isinstance(fam_decl, dict) or fam_decl.get("available") is False:
                native_dropped.append(str((raw or {}).get("family", fam)))
                continue
        families.append(fam)
        derivations.append(nat)
        native_families.add(fam)
    native_seeded = len(derivations)
    # `unavailable` (from run_gate's per-backend failure tracker) drops derivers whose backend has
    # repeatedly failed at the infrastructure level (blank output / timeout / crash) so later claims
    # and tie-break rounds stop re-trying a dead CLI. Convergence rules are NOT relaxed: a shrunken
    # pool just means R1 (>=2 distinct families) fails honestly and the claim reports unconverged.
    is_down = unavailable or (lambda _spec: False)
    cli_pool = [s for s in pool if roster_family_of(s) not in native_families and not is_down(s)]

    # Round 0: seed enough DISTINCT new CLI families to reach >=2 total (native + CLI). With no natives
    # this is the original 2-distinct-family seed; with a native family it is one independent CLI engine
    # to corroborate it.
    need_cli = 2 if native_seeded == 0 else max(1, 2 - len(native_families))
    seed_specs: list[str] = []
    picked = set(native_families)
    for spec in cli_pool:
        if roster_family_of(spec) not in picked:
            seed_specs.append(spec)
            picked.add(roster_family_of(spec))
        if len(seed_specs) >= need_cli:
            break
    if native_seeded == 0 and len(seed_specs) < 2:  # pool lacks 2 families (degraded independence)
        seed_specs = (cli_pool * 2)[:2]

    # The comparator panel also avoids the host's own family — pick non-native judges when any exist, so
    # even the judge isn't a self-family CLI hop (falls back to the given panel if all are native-family).
    judges = [cm for cm in comparators if roster_family_of(cm) not in native_families] or comparators

    def _derive(idx_spec):
        i, spec = idx_spec
        tag = f"{c['id']}/derive{i}_{roster_family_of(spec)}"
        result = _execute_derivation(run, spec, _DERIVE_SYSTEM, _derive_prompt(ctx, c, methods[i % 2]), tag, refusals)
        if result:
            result.update(execution_id=tag, method=methods[i % 2] or "unspecified")
        return spec, result

    with cf.ThreadPoolExecutor(max_workers=max(1, len(seed_specs))) as ex:
        for spec, d in ex.map(_derive, list(enumerate(seed_specs))):
            used.append(spec)
            if d:
                derivations.append(d)
                families.append(roster_family_of(spec))

    cmp, n_judges = _compare(c, ctx, derivations, families, judges, run, tag=f"{c['id']}/compare0")
    converged, verification, cas_xfam = claim_status(cmp, derivations, families, native_seeded)
    converged = converged and _method_risk_satisfied(c, derivations, cmp)
    rounds = 0
    while not converged and rounds < max_iter:
        rounds += 1
        # Re-filter each round: a backend can cross the failure threshold mid-claim, and re-trying
        # it every tie-break round is exactly the waste the tracker exists to stop.
        spec = pick_next_spec([s for s in cli_pool if not is_down(s)], used)
        if spec is None:  # tie-break also never re-runs a host-native family
            break
        used.append(spec)
        method = methods[rounds % 2]
        d = _execute_derivation(run, spec, _DERIVE_SYSTEM,
                                 _tiebreak_prompt(ctx, c, method, derivations),
                                 tag=f"{c['id']}/tiebreak{rounds}_{roster_family_of(spec)}", refusals=refusals)
        if d:
            d.update(execution_id=f"{c['id']}/tiebreak{rounds}_{roster_family_of(spec)}", method=method or "unspecified")
            derivations.append(d)
            families.append(roster_family_of(spec))
        cmp, n_judges = _compare(c, ctx, derivations, families, judges, run, tag=f"{c['id']}/compare{rounds}")
        converged, verification, cas_xfam = claim_status(cmp, derivations, families, native_seeded)
        converged = converged and _method_risk_satisfied(c, derivations, cmp)

    risk_satisfied = _method_risk_satisfied(c, derivations, cmp)
    if not converged:
        cmp["accepted_indices"] = []
    # Published confirmations count accepted evidence only; rejected candidate
    # observations remain separately visible in independence_evidence.
    xfam = cas_xfam if verification == "cas" else cross_family_confirmations(cmp, families)
    if not converged:
        xfam = 0
    # Honest cluster size: indices the comparator enumerated (never exceeds derivations that ran).
    idx = cmp.get("majority_indices") or []
    independent_confirmations = len(cmp.get("accepted_indices", []))
    return {
        "claim": c["id"],
        "converged": converged,
        # CAS or comparator clustering establishes agreement; either path still
        # requires source eligibility, adjudication and declared method risks.
        "verification": verification,
        "independent_confirmations": independent_confirmations,
        "independence_evidence": independence_record(derivations, families, cmp.get("accepted_indices", []), cmp.get("independence_assessments", [])),
        "source_eligible_indices": [i for i in assessed_indices(derivations, cmp.get("independence_assessments", [])) if valid_derivation_transport(derivations[i])],
        "method_risk_satisfied": risk_satisfied,
        "method_risk_assessments": cmp.get("method_risk_assessments", []),
        "cross_family_confirmations": xfam,
        "judges": n_judges,  # comparator-panel size that returned a usable verdict (>=2 = de-biased)
        "native_seeded": native_seeded,  # host-provided derivations injected (no CLI hop)
        # native tags dropped because the agents file declares no such family (visible, never silent)
        "native_dropped": native_dropped,
        "native_unavailable": native_unavailable,
        "families": sorted(set(families)),
        # Lanes the provider refused: their families are absent from `families` unless another
        # lane of the same family produced a derivation.
        "provider_refusals": sorted(refusals, key=lambda r: r["execution_id"]),
        "total_derivations": len(derivations),
        "derivation_records": derivations,
        "iterate_rounds": rounds,
        "agreed_answer": cmp["majority_answer"] if converged else None,
        "adjudicated_correct": cmp["correct_answer_adjudicated"] if converged else None,
        "comparator_diagnostics": {"majority_answer": cmp["majority_answer"],
                                   "correct_answer_adjudicated": cmp["correct_answer_adjudicated"],
                                   "request_capacity": cmp.get("request_capacity")},
        "adjudicated_matches_majority": cmp["adjudicated_matches_majority"],
        "outliers": cmp["outliers"],
    }


def _summarize(rows: list[dict], n_claims: int, family_pool: list[str],
               unavailable_backends: Optional[list[dict]] = None) -> dict:
    unconverged = [r["claim"] for r in rows if not r["converged"]]
    participating = [fam for r in rows for fam in (r.get("families") or [])]
    return {
        "total_claims": len(rows),
        "converged": sum(1 for r in rows if r["converged"]),
        "unconverged": unconverged,
        "clean_first_pass": sum(1 for r in rows if r["converged"] and r["iterate_rounds"] == 0),
        "needed_iteration": [{"claim": r["claim"], "rounds": r["iterate_rounds"]} for r in rows if r["iterate_rounds"] > 0],
        "dropped_claims": n_claims - len(rows),
        # Available family diversity is reported separately from assessed independence.
        "family_pool": family_pool,
        # Which agents file was in force and which families actually produced usable
        # derivations, at which independence level. A gate run below the cross-family
        # minimum is allowed but must be visible as degraded, never silent.
        "agents_file": {"path": str(_AGENTS_PATH) if _AGENTS_PATH else None, "source": _AGENTS_SOURCE},
        "independence": independence_summary(participating),
        # Backends dropped from the deriver pool after repeated infrastructure-level failures
        # (blank output / timeout / crash). Recorded so a degraded run is legible as
        # "backend down", never mistaken for a mathematical disagreement.
        "unavailable_backends": unavailable_backends or [],
        # Provider safeguard refusals are listed apart from infrastructure failures and from
        # mathematical disagreement; a refused family did not take part in the comparison.
        "provider_refusals": [{"claim": r["claim"], **x} for r in rows for x in (r.get("provider_refusals") or [])],
        "matrix": rows,
    }


# Consecutive infrastructure-level failures (blank output / timeout / crash) after which a backend
# spec is dropped from the deriver pool for the rest of the gate. Any success resets its counter.
_BACKEND_DISABLE_AFTER = 2


def run_gate(spec: dict, *, pool: list[str], comparators: list, run: RunFn,
             max_iter_override: Optional[int] = None) -> dict:
    ctx = str(spec.get("context", ""))
    claims = spec.get("claims") or []
    mi = spec.get("max_iter")
    max_iter = max_iter_override if max_iter_override is not None else (mi if isinstance(mi, int) and mi >= 0 else 3)

    # Per-backend consecutive-failure tracker. `run` returning None means the backend itself failed
    # (timeout / blank output / crash) — parse failures on non-empty output do NOT go through here.
    # After _BACKEND_DISABLE_AFTER consecutive failures a spec stops being SELECTED as a deriver
    # (comparator panels keep their own None-tolerant fallback and are not filtered). The lock keeps
    # the counter exact under the ThreadPoolExecutor fan-outs (seed derivers, comparator panels).
    fail_streak: dict[str, int] = {}
    announced: set = set()
    streak_lock = threading.Lock()

    def tracked_run(model_spec: str, system: str, prompt: str, tag: str) -> Optional[str]:
        out = run(model_spec, system, prompt, tag)
        receipts = getattr(tracked_run, "invocations", None)
        refused = (isinstance(receipts, dict) and bool(receipts.get(tag, {}).get("provider_stop")))
        with streak_lock:
            if refused:
                pass  # a refusal of this request says nothing about whether the backend is up
            elif out is None:
                fail_streak[model_spec] = fail_streak.get(model_spec, 0) + 1
                if fail_streak[model_spec] == _BACKEND_DISABLE_AFTER and model_spec not in announced:
                    announced.add(model_spec)
                    print(f"warning: backend {model_spec} dropped from the deriver pool after "
                          f"{_BACKEND_DISABLE_AFTER} consecutive failures (timeout/blank/crash)",
                          file=sys.stderr)
            else:
                fail_streak[model_spec] = 0
        return out

    owner = getattr(run, "__self__", None)
    if hasattr(run, "invocations") or hasattr(owner, "invocations"):
        tracked_run.invocations = getattr(run, "invocations", getattr(owner, "invocations", {}))
    if hasattr(run, "request_budgets") or hasattr(owner, "request_budgets"):
        tracked_run.request_budgets = getattr(run, "request_budgets", getattr(owner, "request_budgets", {}))
    # Comparators reading frozen lane material keep the runner's file-reading call and record directory.
    for name in ("run_reading", "work_dir"):
        if hasattr(run, name) or hasattr(owner, name):
            setattr(tracked_run, name, getattr(run, name, getattr(owner, name, None)))

    def unavailable(model_spec: str) -> bool:
        return fail_streak.get(model_spec, 0) >= _BACKEND_DISABLE_AFTER

    rows: list[dict] = []
    for c in claims:
        if not isinstance(c, dict) or not c.get("id") or not c.get("statement"):
            continue
        try:
            rows.append(verify_claim(c, ctx=ctx, pool=pool, comparators=comparators, max_iter=max_iter,
                                     run=tracked_run, unavailable=unavailable))
        except Exception as exc:  # never let one claim crash the whole matrix
            rows.append({
                "claim": c.get("id", "?"), "converged": False, "verification": "error",
                "independent_confirmations": 0,
                "cross_family_confirmations": 0, "judges": 0, "native_seeded": 0,
                "native_dropped": [], "families": [], "provider_refusals": [],
                "total_derivations": 0,
                "iterate_rounds": 0, "agreed_answer": None, "adjudicated_correct": None,
                "failure_reason": str(exc),
                "adjudicated_matches_majority": False, "outliers": f"claim crashed: {exc}",
            })
    roster_families = (_AGENTS_ROSTER.get("families") or {}) if _AGENTS_ROSTER is not None else None

    def _native_admitted(fam: str) -> bool:
        if roster_families is None:
            return True
        fam_decl = roster_families.get(fam)
        return isinstance(fam_decl, dict) and fam_decl.get("available") is not False

    native_fams = {nat["family"]
                   for c in claims if isinstance(c, dict)
                   for nat in (parse_native_derivation(d) for d in (c.get("native_derivations") or []))
                   if nat and valid_derivation_transport(nat) and _native_admitted(nat["family"])}
    family_pool = sorted({roster_family_of(s) for s in pool} | native_fams)
    downed = sorted(
        ({"spec": s, "consecutive_failures": n} for s, n in fail_streak.items()
         if n >= _BACKEND_DISABLE_AFTER),
        key=lambda d: str(d["spec"]),
    )
    return _summarize(rows, len(claims), family_pool, unavailable_backends=downed)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="derivation-verify Executor 2 — cross-model convergence gate")
    ap.add_argument("--claims", required=True, type=Path, help="claims.json (context, max_iter?, claims[])")
    ap.add_argument("--backends", default=_DEFAULT_BACKENDS,
                    help=f"comma model-spec pool for derivers (default: {_DEFAULT_BACKENDS})")
    ap.add_argument("--comparator", default="", help="single comparator model spec (default: first backend)")
    ap.add_argument("--comparators", default="",
                    help="comma model-spec PANEL of cross-family judges; consensus de-biases any single "
                         "judge (overrides --comparator). Default: one judge (= --comparator).")
    ap.add_argument("--out", type=Path, default=None, help="write matrix JSON here (default: stdout)")
    ap.add_argument("--work-dir", type=Path, default=None, help="durable invocation records (default: beside --out, or beside --claims for stdout)")
    ap.add_argument("--timeout-secs", type=int, default=_DEFAULT_TIMEOUT,
                    help="per-backend hard deadline in seconds; 0 (default) means none — size an explicit cap from earlier runs")
    ap.add_argument("--context-tokens", type=int, default=200000, help="configured comparator context window including output reserve")
    ap.add_argument("--context-bytes", type=int, default=None, help="complete comparator request byte budget; oversized original input is refused")
    ap.add_argument("--max-iter", type=int, default=None, help="override claims.max_iter")
    ap.add_argument("--runner", type=Path, default=None,
                    help="path to review-swarm's run_multi_task.py (default: $DERIVATION_VERIFY_RUNNER, "
                         "else the review-swarm skill installed alongside this one)")
    ap.add_argument("--config", default=None, help="run_multi_task project config (optional)")
    ap.add_argument("--tools", action="store_true", help="enable best-effort backend tool/compute modes")
    ap.add_argument("--agents-file", default=None,
                    help="third-party agents file (family -> runner -> model mapping; see "
                         "docs/AGENTS_FILE.md). If omitted, auto-discovers .nullius/agents.json from "
                         "the git root, then ~/.nullius/agents.json; a missing file is the pure-native "
                         "configuration, never an error. DERIVATION_VERIFY_NO_AUTO_CONFIG=1 disables "
                         "the auto-discovery only.")
    args = ap.parse_args(argv)
    try:
        request_budgets(args.context_tokens, args.context_bytes)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if not args.claims.exists():
        print(f"claims file not found: {args.claims}", file=sys.stderr)
        return 2
    try:
        roster, roster_source, roster_path = load_agents_file(args.agents_file)
    except Exception as exc:
        print(f"agents file error: {exc}", file=sys.stderr)
        return 2
    set_agents_roster(roster, source=roster_source, path=roster_path)
    spec = json.loads(args.claims.read_text(encoding="utf-8"))
    has_natives = any(nat and valid_derivation_transport(nat)
                      for c in (spec.get("claims") or []) if isinstance(c, dict)
                      for nat in (parse_native_derivation(d) for d in (c.get("native_derivations") or [])))

    def _resolve_specs(raw: str, *, flag: str) -> Optional[list[str]]:
        out = []
        for s in (x.strip() for x in raw.split(",")):
            if not s:
                continue
            if s.startswith(_FAMILY_SPEC_PREFIX):
                try:
                    out.append(resolve_family_spec(s, roster))
                except Exception as exc:
                    print(f"{flag}: {exc}", file=sys.stderr)
                    return None
            else:
                out.append(s)
        return out

    pool = _resolve_specs(args.backends, flag="--backends")
    if pool is None:
        return 2
    if not pool:
        print("need >=1 backend spec", file=sys.stderr)
        return 2
    if len({roster_family_of(s) for s in pool}) < 2 and not has_natives:
        print("warning: backend pool has <2 distinct model families; independence is degraded", file=sys.stderr)
    comparators = _resolve_specs(args.comparators, flag="--comparators")
    if comparators is None:
        return 2
    if not comparators:
        single = _resolve_specs(args.comparator, flag="--comparator")
        if single is None:
            return 2
        comparators = single or [pool[0]]
    runner_path = _resolve_runner(args.runner)
    if runner_path is None:
        print(
            "Executor 2 needs review-swarm's run_multi_task.py and it was not found. The review-swarm "
            "skill is a declared dependency — install it alongside derivation-verify (e.g. "
            "`install_skill.py --package derivation-verify` pulls it in), set $DERIVATION_VERIFY_RUNNER, "
            f"or pass --runner. Looked for: {args.runner or _DEFAULT_RUNNER}",
            file=sys.stderr,
        )
        return 2

    work_dir = args.work_dir
    if work_dir is None:
        anchor = (args.out or args.claims).expanduser().resolve()
        work_dir = anchor.parent / (anchor.name + ".derivation-records")
    # Absolutize before anything is spawned: per-backend paths derived from work_dir are passed to
    # subprocess runners, and a relative work-dir has produced outputs written under nested paths
    # the gate never read back — a silently wasted cross-family round.
    work_dir = work_dir.expanduser().resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    runner = MultiTaskRunner(runner_path=runner_path, work_dir=work_dir, timeout=args.timeout_secs,
                             tools=args.tools, config=args.config,
                             context_tokens=args.context_tokens, context_bytes=args.context_bytes)
    result = run_gate(spec, pool=pool, comparators=comparators, run=runner.run,
                      max_iter_override=args.max_iter)

    text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.write_text(text, encoding="utf-8")
        print(f"[ok] {result['converged']}/{result['total_claims']} converged "
              f"(cross-family); wrote {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
