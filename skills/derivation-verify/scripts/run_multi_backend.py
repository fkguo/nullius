#!/usr/bin/env python3
"""
derivation-verify — Executor 2 (CLI multi-backend) — cross-model convergence gate.

Satisfies the SAME backend-agnostic contract as the Claude/Workflow-native executor
(../workflows/derivation_verify.js; see ../references/contract.md), but runs the >=2 INDEPENDENT
blind re-derivations across SEPARATE model CLIs (Claude / Codex / Gemini / OpenCode) for TRUE
cross-model independence — the reliability ceiling per the SOTA on multi-agent verification.

Why cross-model (not same-model self-consistency): same-model "committees" demonstrably suffer
*representational collapse* (near-identical reasoning, low effective rank), so agreement among
prompt-variants of ONE model is weak evidence. Independent model FAMILIES decorrelate errors
(cf. ReConcile / Council Mode / diversity-aware-consensus literature). This executor therefore
enforces, beyond Executor 1's "majority_size >= 2":
  R1 cross-family diversity : a claim converges only on >=2 derivations from DISTINCT model
                              families that the comparator clusters as mathematically equivalent.
  R2 adjudicator veto       : the comparator independently RECOMPUTES the answer; if its recompute
                              does not match the agreeing cluster, the claim does NOT converge
                              (guards the "consensus trap" — a correlated wrong majority).
  R3 diversity-first tiebreak: each tie-break round pulls a NOT-YET-USED family first (maximize
                              decorrelation), bounded by max_iter (a fixed lower bound; adaptive
                              KS / Beta-Binomial stopping is a documented future enhancement).

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
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, Optional

_THIS = Path(__file__).resolve()
_SKILLS_ROOT = _THIS.parents[2]  # skills/derivation-verify/scripts/run_multi_backend.py -> skills/
_DEFAULT_RUNNER = _SKILLS_ROOT / "review-swarm" / "scripts" / "bin" / "run_multi_task.py"
_REVIEW_BIN = _DEFAULT_RUNNER.parent

# Reuse review-swarm's output sanitizers (strip Gemini CLI startup noise / markdown fences) — the
# ONLY review-swarm coupling, and it is generic text cleanup, not the review-specific contract.
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
_DEFAULT_TIMEOUT = 900
_CONFIDENCE = {"high", "medium", "low"}
_TOOL_MODES = {"claude": "review", "gemini": "review", "opencode": "workspace"}  # codex always execs


# --------------------------------------------------------------------------------------
# Pure helpers (no I/O, no subprocess) — unit-tested directly.
# --------------------------------------------------------------------------------------
def family_of(spec: str) -> str:
    """Model FAMILY (== review-swarm backend) of a model spec. Mirrors run_multi_task._classify_model."""
    m = (spec or "").strip()
    if not m or m == "default":
        return "opencode"
    for fam in ("claude", "codex", "gemini"):
        if m.startswith(fam + "/"):
            return fam
    return "opencode"


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
    return {
        "canonical_answer": ans.strip(),
        "derivation_summary": summ.strip() if isinstance(summ, str) else "",
        "confidence": conf if conf in _CONFIDENCE else "low",
        # optional strict-sympy rewrite of the answer for deterministic equivalence; "" if not a
        # closed-form/number (asymptotic bound, set, prose) -> CAS abstains, gate falls back to LLM.
        "checkable_form": form.strip() if isinstance(form, str) else "",
    }


def parse_comparison(text: Optional[str], n_derivations: int) -> Optional[dict]:
    """Validate the comparator JSON, incl. the Executor-2 extensions majority_indices + veto flag."""
    obj = extract_json(text, prefer_keys={"majority_size", "majority_answer"})
    if not isinstance(obj, dict):
        return None
    try:
        majority_size = int(obj.get("majority_size"))
    except (TypeError, ValueError):
        return None
    raw_idx = obj.get("majority_indices")
    indices = (
        sorted({i for i in raw_idx if isinstance(i, int) and 0 <= i < n_derivations})
        if isinstance(raw_idx, list) else []
    )
    return {
        "majority_answer": str(obj.get("majority_answer", "")).strip(),
        "majority_size": majority_size,
        "majority_indices": indices,
        "all_equivalent": bool(obj.get("all_equivalent", False)),
        "adjudicated_matches_majority": bool(obj.get("adjudicated_matches_majority", False)),
        "outliers": str(obj.get("outliers", "")).strip() or "none",
        "correct_answer_adjudicated": str(obj.get("correct_answer_adjudicated", "")).strip(),
    }


# A dead/garbled comparator must degrade THIS claim to unconverged, never crash the run (cf.
# contract.md: "transient executor failures must NOT count; report unconverged honestly").
SAFE_CMP = {
    "majority_answer": "(comparator unavailable)", "majority_size": 0, "majority_indices": [],
    "all_equivalent": False, "adjudicated_matches_majority": False,
    "outliers": "comparator backend produced no parseable verdict",
    "correct_answer_adjudicated": "(unadjudicated — comparator unavailable)",
}


def cross_family_confirmations(cmp: dict, families: list[str]) -> int:
    """# of DISTINCT model families inside the comparator's agreeing cluster (R1)."""
    fams = {families[i] for i in cmp.get("majority_indices", []) if 0 <= i < len(families)}
    return len(fams)


def decide_converged(cmp: dict, families: list[str]) -> bool:
    """Converged iff >=2 DISTINCT families agree (R1) AND the adjudicator's recompute matches (R2)."""
    return cross_family_confirmations(cmp, families) >= 2 and bool(cmp.get("adjudicated_matches_majority"))


def pick_next_spec(pool: list[str], used: list[str]) -> Optional[str]:
    """Diversity-first tie-break (R3): a spec whose FAMILY is unused; else least-used family; else None."""
    used_fams = [family_of(s) for s in used]
    for spec in pool:
        if family_of(spec) not in used_fams:
            return spec
    # all families already used at least once -> reuse the least-used family's spec (still adds a derivation)
    if pool:
        counts = {spec: used_fams.count(family_of(spec)) for spec in pool}
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
    # Restricted eval namespace for parse_expr: sympy names ONLY, builtins stripped — a malicious
    # checkable_form cannot reach __import__/open/exec/eval during parsing (parse_expr eval()s input).
    _SYMPY_NS = {k: getattr(_sp, k) for k in dir(_sp) if not k.startswith("_")}
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


def verified_cross_family(forms: list[str], families: list[str]) -> tuple[int, bool]:
    """Max # of DISTINCT families in any CAS-verified-equal cluster, and whether ANY pair was CAS-decided.
    decidable=False => CAS abstained entirely (caller should fall back to the LLM clustering path)."""
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
    groups: dict[int, set] = {}
    for i in range(n):
        groups.setdefault(find(i), set()).add(families[i])
    xfam = max((len(f) for f in groups.values()), default=0)
    return xfam, decidable


def claim_status(cmp: dict, derivations: list[dict], families: list[str]) -> tuple[bool, str, int]:
    """Decide convergence capability-first. Returns (converged, verification, cross_family_count).
    CAS path (LLM-independent) when any answer pair is CAS-decidable; else the LLM clustering path."""
    cas_xfam, decidable = verified_cross_family([d.get("checkable_form", "") for d in derivations], families)
    if decidable:
        return cas_xfam >= 2, "cas", cas_xfam
    return decide_converged(cmp, families), "llm", cross_family_confirmations(cmp, families)


# --------------------------------------------------------------------------------------
# Prompts (mirror Executor 1's vPrompt/cmpPrompt/tiePrompt; comparator schema extended for R1/R2).
# --------------------------------------------------------------------------------------
_DERIVE_SYSTEM = (
    "You are a careful domain expert doing an INDEPENDENT blind re-derivation (the field is whatever the "
    "task implies — math, physics, statistics, CS, economics, ...). Derive the requested result FROM "
    "SCRATCH; do not assume any answer. Be rigorous about every step — signs, factors, edge/boundary "
    "cases, and any convention or branch choice. Output ONLY a single fenced ```json block with EXACTLY these keys: "
    '"canonical_answer" (the result in the exact requested format), "derivation_summary" (2-6 sentences '
    "of the actual steps, incl. any computation you ran and its output), \"confidence\" (high|medium|low), "
    'and "checkable_form" (your canonical_answer rewritten as a STRICT sympy-parseable expression — sympy '
    "function names like atan/asin/exp/log/sqrt, explicit * for multiplication, ** for powers; set it to "
    '"" if the answer is NOT a closed-form/number, e.g. an asymptotic bound, a set, or prose). '
    "No prose outside the json block."
)
_COMPARE_SYSTEM = (
    "You are an impartial comparator+adjudicator. You are given several INDEPENDENT derivations of one "
    "claim. Decide which are MATHEMATICALLY EQUIVALENT (not string-equal; e.g. -pi/(4mu) == -(1/4)pi/mu). "
    "Then INDEPENDENTLY RECOMPUTE the answer yourself. Output ONLY a single fenced ```json block with "
    'EXACTLY these keys: "majority_answer" (canonical answer of the largest equivalent cluster), '
    '"majority_size" (int), "majority_indices" (array of the 0-based input indices in that cluster), '
    '"all_equivalent" (bool), "outliers" (each non-majority index + its specific error, or "none"), '
    '"correct_answer_adjudicated" (the answer YOU recompute as correct + one-line reason), '
    '"adjudicated_matches_majority" (bool: does YOUR recomputed answer equal majority_answer?). '
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
    listing = "  ;  ".join(f'"{d["canonical_answer"]}"' for d in prior)
    return (
        f"{ctx}\n\nINDEPENDENT TIE-BREAK derivation. Prior attempts disagreed: {listing}. IGNORE them; "
        f"derive the claim yourself from scratch.\n{c['statement']}\n\n"
        f"Suggested route: {method or '(choose any rigorous route)'}\n\n"
        f"Report canonical_answer in EXACTLY this format: {c['report_format']}\n"
        "Show any computation you run in derivation_summary."
    )


def _compare_prompt(ctx: str, c: dict, derivations: list[dict], families: list[str]) -> str:
    listing = "\n".join(
        f'[#{i}] (family={families[i]}) canonical_answer="{d["canonical_answer"]}" | {d["derivation_summary"]}'
        for i, d in enumerate(derivations)
    )
    return (
        f"{ctx}\n\nClaim:\n{c['statement']}\nExpected canonical format: {c['report_format']}\n\n"
        f"{len(derivations)} independent derivations (different model families):\n{listing}\n\n"
        "Cluster by mathematical equivalence, recompute the correct answer yourself, and fill the json."
    )


# --------------------------------------------------------------------------------------
# Backend runner adapter — invokes review-swarm's run_multi_task.py once per (spec, prompt).
# Injectable: the gate takes any callable run(spec, system, prompt, tag) -> str|None.
# --------------------------------------------------------------------------------------
RunFn = Callable[[str, str, str, str], Optional[str]]


class MultiTaskRunner:
    def __init__(self, *, runner_path: Path, work_dir: Path, timeout: int, tools: bool,
                 config: Optional[str], python_exe: str = sys.executable):
        self.runner_path = runner_path
        self.work_dir = work_dir
        self.timeout = timeout
        self.tools = tools
        self.config = config
        self.python_exe = python_exe

    def run(self, spec: str, system: str, prompt: str, tag: str) -> Optional[str]:
        backend = family_of(spec)
        d = self.work_dir / tag.replace("/", "__")
        d.mkdir(parents=True, exist_ok=True)
        sysf, promptf, outf = d / "system.txt", d / "prompt.txt", d / "out.txt"
        sysf.write_text(system, encoding="utf-8")
        promptf.write_text(prompt, encoding="utf-8")
        cmd = [
            self.python_exe, str(self.runner_path),
            "--out-dir", str(d), "--system", str(sysf), "--prompt", str(promptf),
            "--models", spec, "--backend-output", f"{backend}={outf}",
            "--output-prefix", "d", "--timeout-secs", str(self.timeout), "--no-parallel",
        ]
        if self.config:
            cmd += ["--config", self.config]
        if self.tools and backend in _TOOL_MODES:
            cmd += ["--backend-tool-mode", f"{backend}={_TOOL_MODES[backend]}"]
        # Hermetic run: the runner otherwise auto-discovers .autoresearch/review-swarm.json up the git
        # tree (exactly where this skill runs) and would bleed REVIEW config — flipping on the review
        # contract sanitizers + injecting tool modes — into the derivation pass. Disabling auto-config
        # makes the gate reproducible and config-independent; an explicit --config is still honored.
        env = {**os.environ, "REVIEW_SWARM_NO_AUTO_CONFIG": "1"}
        try:
            subprocess.run(cmd, timeout=(self.timeout + 60) if self.timeout else None,
                           capture_output=True, text=True, check=False, env=env)
        except (subprocess.TimeoutExpired, OSError):
            return None
        if not outf.exists():
            return None
        try:
            txt = outf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None
        return txt if txt.strip() else None


# --------------------------------------------------------------------------------------
# The gate (per claim) — cross-model derive -> adjudicate -> diversity-first tie-break to converge.
# --------------------------------------------------------------------------------------
def _compare(c, ctx, derivations, families, comparator, run: RunFn, *, tag: str) -> dict:
    if not derivations:
        return dict(SAFE_CMP)
    raw = run(comparator, _COMPARE_SYSTEM, _compare_prompt(ctx, c, derivations, families), tag)
    return parse_comparison(raw, len(derivations)) or dict(SAFE_CMP)


def verify_claim(c: dict, *, ctx: str, pool: list[str], comparator: str, max_iter: int, run: RunFn) -> dict:
    methods = [c.get("method0", ""), c.get("method1", "")]
    derivations: list[dict] = []
    families: list[str] = []
    used: list[str] = []

    # Round 0: >=2 independent blind derivers on DISTINCT families, in parallel.
    seed_specs: list[str] = []
    for spec in pool:
        if family_of(spec) not in [family_of(s) for s in seed_specs]:
            seed_specs.append(spec)
        if len(seed_specs) >= 2:
            break
    if len(seed_specs) < 2:  # pool lacks 2 families: fall back to first 2 specs (independence degraded)
        seed_specs = pool[:2]

    def _derive(idx_spec):
        i, spec = idx_spec
        tag = f"{c['id']}/derive{i}_{family_of(spec)}"
        return spec, parse_derivation(run(spec, _DERIVE_SYSTEM, _derive_prompt(ctx, c, methods[i % 2]), tag))

    with cf.ThreadPoolExecutor(max_workers=max(1, len(seed_specs))) as ex:
        for spec, d in ex.map(_derive, list(enumerate(seed_specs))):
            used.append(spec)
            if d:
                derivations.append(d)
                families.append(family_of(spec))

    cmp = _compare(c, ctx, derivations, families, comparator, run, tag=f"{c['id']}/compare0")
    converged, verification, cas_xfam = claim_status(cmp, derivations, families)
    rounds = 0
    while not converged and rounds < max_iter:
        rounds += 1
        spec = pick_next_spec(pool, used)
        if spec is None:
            break
        used.append(spec)
        method = methods[rounds % 2]
        d = parse_derivation(run(spec, _DERIVE_SYSTEM,
                                 _tiebreak_prompt(ctx, c, method, derivations),
                                 tag=f"{c['id']}/tiebreak{rounds}_{family_of(spec)}"))
        if d:
            derivations.append(d)
            families.append(family_of(spec))
        cmp = _compare(c, ctx, derivations, families, comparator, run, tag=f"{c['id']}/compare{rounds}")
        converged, verification, cas_xfam = claim_status(cmp, derivations, families)

    # cross_family_confirmations: CAS-verified count when the CAS path decided; else the comparator's.
    xfam = cas_xfam if verification == "cas" else cross_family_confirmations(cmp, families)
    # Honest cluster size: indices the comparator enumerated (never exceeds derivations that ran).
    idx = cmp.get("majority_indices") or []
    independent_confirmations = len(idx) if idx else min(int(cmp.get("majority_size", 0) or 0), len(derivations))
    return {
        "claim": c["id"],
        "converged": converged,
        # how convergence was decided: "cas" = LLM-independent (deterministic equivalence, de-anchored
        # from the comparator); "llm" = comparator clustering + adjudicator veto (LLM-bounded).
        "verification": verification,
        "independent_confirmations": independent_confirmations,
        "cross_family_confirmations": xfam,
        "families": sorted(set(families)),
        "total_derivations": len(derivations),
        "iterate_rounds": rounds,
        "agreed_answer": cmp["majority_answer"],
        "adjudicated_correct": cmp["correct_answer_adjudicated"],
        "adjudicated_matches_majority": cmp["adjudicated_matches_majority"],
        "outliers": cmp["outliers"],
    }


def _summarize(rows: list[dict], n_claims: int, family_pool: list[str]) -> dict:
    unconverged = [r["claim"] for r in rows if not r["converged"]]
    return {
        "total_claims": len(rows),
        "converged": sum(1 for r in rows if r["converged"]),
        "unconverged": unconverged,
        "clean_first_pass": sum(1 for r in rows if r["converged"] and r["iterate_rounds"] == 0),
        "needed_iteration": [{"claim": r["claim"], "rounds": r["iterate_rounds"]} for r in rows if r["iterate_rounds"] > 0],
        "dropped_claims": n_claims - len(rows),
        # Distinct families available to derivers; <2 means R1 (cross-family) is structurally
        # unsatisfiable and EVERY claim will report converged:false by design — surfaced here so the
        # matrix is self-explanatory rather than silently all-unconverged.
        "family_pool": family_pool,
        "matrix": rows,
    }


def run_gate(spec: dict, *, pool: list[str], comparator: str, run: RunFn,
             max_iter_override: Optional[int] = None) -> dict:
    ctx = str(spec.get("context", ""))
    claims = spec.get("claims") or []
    mi = spec.get("max_iter")
    max_iter = max_iter_override if max_iter_override is not None else (mi if isinstance(mi, int) and mi >= 0 else 3)
    rows: list[dict] = []
    for c in claims:
        if not isinstance(c, dict) or not c.get("id") or not c.get("statement"):
            continue
        try:
            rows.append(verify_claim(c, ctx=ctx, pool=pool, comparator=comparator, max_iter=max_iter, run=run))
        except Exception as exc:  # never let one claim crash the whole matrix
            rows.append({
                "claim": c.get("id", "?"), "converged": False, "verification": "error",
                "independent_confirmations": 0,
                "cross_family_confirmations": 0, "families": [], "total_derivations": 0,
                "iterate_rounds": 0, "agreed_answer": "", "adjudicated_correct": f"(error: {exc})",
                "adjudicated_matches_majority": False, "outliers": f"claim crashed: {exc}",
            })
    return _summarize(rows, len(claims), sorted({family_of(s) for s in pool}))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="derivation-verify Executor 2 — cross-model convergence gate")
    ap.add_argument("--claims", required=True, type=Path, help="claims.json (context, max_iter?, claims[])")
    ap.add_argument("--backends", default=_DEFAULT_BACKENDS,
                    help=f"comma model-spec pool for derivers (default: {_DEFAULT_BACKENDS})")
    ap.add_argument("--comparator", default="", help="model spec for the comparator (default: first backend)")
    ap.add_argument("--out", type=Path, default=None, help="write matrix JSON here (default: stdout)")
    ap.add_argument("--work-dir", type=Path, default=None, help="scratch dir (default: a temp dir)")
    ap.add_argument("--timeout-secs", type=int, default=_DEFAULT_TIMEOUT, help="per-backend timeout")
    ap.add_argument("--max-iter", type=int, default=None, help="override claims.max_iter")
    ap.add_argument("--runner", type=Path, default=_DEFAULT_RUNNER, help="path to run_multi_task.py")
    ap.add_argument("--config", default=None, help="run_multi_task project config (optional)")
    ap.add_argument("--tools", action="store_true", help="enable best-effort backend tool/compute modes")
    args = ap.parse_args(argv)

    if not args.claims.exists():
        print(f"claims file not found: {args.claims}", file=sys.stderr)
        return 2
    spec = json.loads(args.claims.read_text(encoding="utf-8"))
    pool = [s.strip() for s in args.backends.split(",") if s.strip()]
    if len(pool) < 2:
        print("need >=2 backend specs for cross-model independence", file=sys.stderr)
        return 2
    if len({family_of(s) for s in pool}) < 2:
        print("warning: backend pool has <2 distinct model families; independence is degraded", file=sys.stderr)
    comparator = args.comparator.strip() or pool[0]
    if not args.runner.exists():
        print(f"run_multi_task.py runner not found: {args.runner} (pass --runner)", file=sys.stderr)
        return 2

    tmp = None
    work_dir = args.work_dir
    if work_dir is None:
        tmp = tempfile.TemporaryDirectory(prefix="derivverify2_")
        work_dir = Path(tmp.name)
    work_dir.mkdir(parents=True, exist_ok=True)
    runner = MultiTaskRunner(runner_path=args.runner, work_dir=work_dir, timeout=args.timeout_secs,
                             tools=args.tools, config=args.config)
    try:
        result = run_gate(spec, pool=pool, comparator=comparator, run=runner.run,
                          max_iter_override=args.max_iter)
    finally:
        if tmp is not None:
            tmp.cleanup()

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
