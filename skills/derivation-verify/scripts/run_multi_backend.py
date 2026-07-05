#!/usr/bin/env python3
"""
derivation-verify — Executor 2 (CLI multi-backend) — cross-model convergence gate.

Satisfies the SAME backend-agnostic contract as the Claude/Workflow-native executor
(../workflows/derivation_verify.js; see ../references/contract.md), but runs the >=2 INDEPENDENT
blind re-derivations across SEPARATE model CLIs (Claude / Codex / Gemini / OpenCode / Kimi) for TRUE
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


def _resolve_runner(explicit):
    """Locate review-swarm's run_multi_task.py (Executor 2's per-backend launcher). Order, all
    host-neutral: explicit --runner > $DERIVATION_VERIFY_RUNNER > the review-swarm skill installed
    ALONGSIDE this one (the declared market dependency). Returns a Path or None."""
    for cand in (explicit, os.environ.get("DERIVATION_VERIFY_RUNNER"), _DEFAULT_RUNNER):
        if cand:
            p = Path(cand)
            if p.exists():
                return p
    return None

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
    for fam in ("claude", "codex", "gemini", "kimi"):
        if m.startswith(fam + "/"):
            return fam
    return "opencode"


def normalize_family(tag: str) -> str:
    """Canonicalize a host-declared native `family` tag into the SAME namespace as `family_of` so native
    and CLI families compare correctly (auto-exclusion + cross-family counting). Accepts a bare family
    name (`claude`/`Claude`), a full spec (`claude/default`), or any opencode-class provider; everything
    non-{claude,codex,gemini,kimi} folds to `opencode` exactly as `family_of` does for CLI specs."""
    t = (tag or "").strip().lower()
    if not t or t == "default":
        return "opencode"
    if "/" in t:
        return family_of(t)
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
    return {
        "canonical_answer": ans.strip(),
        "derivation_summary": summ.strip() if isinstance(summ, str) else "",
        "confidence": conf if conf in _CONFIDENCE else "low",
        # optional strict-sympy rewrite of the answer for deterministic equivalence; "" if not a
        # closed-form/number (asymptotic bound, set, prose) -> CAS abstains, gate falls back to LLM.
        "checkable_form": form.strip() if isinstance(form, str) else "",
    }


def parse_native_derivation(d) -> Optional[dict]:
    """Validate a HOST-PROVIDED native derivation — one the host already computed IN-PROCESS for its own
    model family (no CLI hop). Same verdict shape as a CLI deriver, plus a required `family` tag. Returns
    the verdict dict with `family` included (the caller pops it into the parallel families list); None if
    it lacks a non-empty canonical_answer or family."""
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
        "confidence": conf if conf in _CONFIDENCE else "high",  # host-native default: high
        "checkable_form": form.strip() if isinstance(form, str) else "",
        "family": normalize_family(fam),  # canonical namespace, so it dedups/excludes vs CLI families
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


def decide_converged(cmp: dict, families: list[str], native_count: int = 0) -> bool:
    """Converged iff >=2 DISTINCT families agree (R1) AND the adjudicator's recompute matches (R2) AND the
    agreeing cluster contains >=1 INDEPENDENT (non-native, i.e. CLI-derived) family — host-supplied native
    derivations (indices < native_count) cannot self-certify without an independent engine corroborating."""
    idx = [i for i in cmp.get("majority_indices", []) if 0 <= i < len(families)]
    has_independent = any(i >= native_count for i in idx)
    return (cross_family_confirmations(cmp, families) >= 2
            and has_independent
            and bool(cmp.get("adjudicated_matches_majority")))


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
    """Decide convergence capability-first. Returns (converged, verification, cross_family_count).
    CAS path (LLM-independent) when any answer pair is CAS-decidable; else the LLM clustering path.
    `native_count` host-seeded derivations occupy indices [0, native_count) and cannot, alone, converge a
    claim — both paths require >=1 independent (CLI) family in the agreeing cluster."""
    cas_xfam, decidable = verified_cross_family(
        [d.get("checkable_form", "") for d in derivations], families, native_count)
    if decidable:
        return cas_xfam >= 2, "cas", cas_xfam
    return decide_converged(cmp, families, native_count), "llm", cross_family_confirmations(cmp, families)


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
        # Hermetic run: the runner otherwise auto-discovers .nullius/review-swarm.json up the git
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
def _aggregate_judges(verdicts: list, n_derivations: int) -> tuple:
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
    cmp = {
        "majority_answer": Counter(v.get("majority_answer", "") for v in backers).most_common(1)[0][0],
        "majority_size": len(cluster),
        "majority_indices": list(cluster),
        "all_equivalent": sum(1 for v in backers if v.get("all_equivalent")) >= need,
        # veto JOINTLY attached to THIS cluster by a strict majority (of all judges, not just backers)
        "adjudicated_matches_majority": sum(1 for v in backers if v.get("adjudicated_matches_majority")) >= need,
        "outliers": " || ".join(f"judge{j}: {v.get('outliers', '')}" for j, v in enumerate(ok)),
        "correct_answer_adjudicated": ok[0].get("correct_answer_adjudicated", ""),
    }
    return cmp, len(ok)


def _compare(c, ctx, derivations, families, comparators: list, run: RunFn, *, tag: str) -> tuple:
    """Run the comparator PANEL (>=1 model families) in parallel and meta-aggregate. Each judge sees the
    same derivations and independently clusters + recomputes; the consensus de-biases any single judge."""
    if not derivations:
        return dict(SAFE_CMP), 0
    prompt = _compare_prompt(ctx, c, derivations, families)

    def _judge(idx_spec):
        j, spec = idx_spec
        try:  # one judge's failure must drop to None, not abort the whole panel (ex.map re-raises)
            return parse_comparison(run(spec, _COMPARE_SYSTEM, prompt, f"{tag}_j{j}_{family_of(spec)}"), len(derivations))
        except Exception:
            return None

    with cf.ThreadPoolExecutor(max_workers=max(1, len(comparators))) as ex:
        verdicts = list(ex.map(_judge, list(enumerate(comparators))))
    return _aggregate_judges(verdicts, len(derivations))


def verify_claim(c: dict, *, ctx: str, pool: list[str], comparators: list, max_iter: int, run: RunFn) -> dict:
    methods = [c.get("method0", ""), c.get("method1", "")]
    derivations: list[dict] = []
    families: list[str] = []
    used: list[str] = []

    # Seed HOST-PROVIDED native derivations first (computed in-host for the host's own family — no CLI
    # hop). Their families are AUTO-EXCLUDED from the CLI pool below, so we never shell out to a family
    # the host already ran natively, even if the caller left it in --backends. They participate in the
    # cross-family gate (CAS + comparator) exactly like CLI derivations.
    native_families: set = set()
    for raw in (c.get("native_derivations") or []):
        nat = parse_native_derivation(raw)
        if nat:
            families.append(nat.pop("family"))
            derivations.append(nat)
            native_families.add(families[-1])
    native_seeded = len(derivations)
    cli_pool = [s for s in pool if family_of(s) not in native_families]

    # Round 0: seed enough DISTINCT new CLI families to reach >=2 total (native + CLI). With no natives
    # this is the original 2-distinct-family seed; with a native family it is one independent CLI engine
    # to corroborate it.
    need_cli = 2 if native_seeded == 0 else max(1, 2 - len(native_families))
    seed_specs: list[str] = []
    picked = set(native_families)
    for spec in cli_pool:
        if family_of(spec) not in picked:
            seed_specs.append(spec)
            picked.add(family_of(spec))
        if len(seed_specs) >= need_cli:
            break
    if native_seeded == 0 and len(seed_specs) < 2:  # pool lacks 2 families (degraded independence)
        seed_specs = cli_pool[:2]

    # The comparator panel also avoids the host's own family — pick non-native judges when any exist, so
    # even the judge isn't a self-family CLI hop (falls back to the given panel if all are native-family).
    judges = [cm for cm in comparators if family_of(cm) not in native_families] or comparators

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

    cmp, n_judges = _compare(c, ctx, derivations, families, judges, run, tag=f"{c['id']}/compare0")
    converged, verification, cas_xfam = claim_status(cmp, derivations, families, native_seeded)
    rounds = 0
    while not converged and rounds < max_iter:
        rounds += 1
        spec = pick_next_spec(cli_pool, used)  # tie-break also never re-runs a host-native family
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
        cmp, n_judges = _compare(c, ctx, derivations, families, judges, run, tag=f"{c['id']}/compare{rounds}")
        converged, verification, cas_xfam = claim_status(cmp, derivations, families, native_seeded)

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
        "judges": n_judges,  # comparator-panel size that returned a usable verdict (>=2 = de-biased)
        "native_seeded": native_seeded,  # host-provided derivations injected (no CLI hop)
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


def run_gate(spec: dict, *, pool: list[str], comparators: list, run: RunFn,
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
            rows.append(verify_claim(c, ctx=ctx, pool=pool, comparators=comparators, max_iter=max_iter, run=run))
        except Exception as exc:  # never let one claim crash the whole matrix
            rows.append({
                "claim": c.get("id", "?"), "converged": False, "verification": "error",
                "independent_confirmations": 0,
                "cross_family_confirmations": 0, "judges": 0, "native_seeded": 0, "families": [],
                "total_derivations": 0,
                "iterate_rounds": 0, "agreed_answer": "", "adjudicated_correct": f"(error: {exc})",
                "adjudicated_matches_majority": False, "outliers": f"claim crashed: {exc}",
            })
    native_fams = {nat["family"]
                   for c in claims if isinstance(c, dict)
                   for nat in (parse_native_derivation(d) for d in (c.get("native_derivations") or []))
                   if nat}
    family_pool = sorted({family_of(s) for s in pool} | native_fams)
    return _summarize(rows, len(claims), family_pool)


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
    ap.add_argument("--work-dir", type=Path, default=None, help="scratch dir (default: a temp dir)")
    ap.add_argument("--timeout-secs", type=int, default=_DEFAULT_TIMEOUT, help="per-backend timeout")
    ap.add_argument("--max-iter", type=int, default=None, help="override claims.max_iter")
    ap.add_argument("--runner", type=Path, default=None,
                    help="path to review-swarm's run_multi_task.py (default: $DERIVATION_VERIFY_RUNNER, "
                         "else the review-swarm skill installed alongside this one)")
    ap.add_argument("--config", default=None, help="run_multi_task project config (optional)")
    ap.add_argument("--tools", action="store_true", help="enable best-effort backend tool/compute modes")
    args = ap.parse_args(argv)

    if not args.claims.exists():
        print(f"claims file not found: {args.claims}", file=sys.stderr)
        return 2
    spec = json.loads(args.claims.read_text(encoding="utf-8"))
    has_natives = any(parse_native_derivation(d)
                      for c in (spec.get("claims") or []) if isinstance(c, dict)
                      for d in (c.get("native_derivations") or []))
    pool = [s.strip() for s in args.backends.split(",") if s.strip()]
    if not pool:
        print("need >=1 backend spec", file=sys.stderr)
        return 2
    if len(pool) < 2 and not has_natives:
        print("need >=2 backend specs for cross-model independence "
              "(or supply native_derivations + >=1 backend to remove the host's own CLI hop)", file=sys.stderr)
        return 2
    if len({family_of(s) for s in pool}) < 2 and not has_natives:
        print("warning: backend pool has <2 distinct model families; independence is degraded", file=sys.stderr)
    comparators = [s.strip() for s in args.comparators.split(",") if s.strip()] or \
        ([args.comparator.strip()] if args.comparator.strip() else [pool[0]])
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

    tmp = None
    work_dir = args.work_dir
    if work_dir is None:
        tmp = tempfile.TemporaryDirectory(prefix="derivverify2_")
        work_dir = Path(tmp.name)
    work_dir.mkdir(parents=True, exist_ok=True)
    runner = MultiTaskRunner(runner_path=runner_path, work_dir=work_dir, timeout=args.timeout_secs,
                             tools=args.tools, config=args.config)
    try:
        result = run_gate(spec, pool=pool, comparators=comparators, run=runner.run,
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
