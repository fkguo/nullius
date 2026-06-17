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


def extract_json(text: Optional[str]) -> Optional[dict]:
    """Best-effort: pull the JSON object a CLI model emitted (fenced block, or last balanced {...})."""
    if not text:
        return None
    cleaned = normalize_newlines(text)
    for candidate in (strip_markdown_fences(cleaned), cleaned):
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except (json.JSONDecodeError, ValueError):
            pass
    # Fallback: scan for a balanced top-level {...} and try to parse it (last one wins).
    found: Optional[dict] = None
    for start in (i for i, ch in enumerate(cleaned) if ch == "{"):
        depth = 0
        for j in range(start, len(cleaned)):
            if cleaned[j] == "{":
                depth += 1
            elif cleaned[j] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(cleaned[start:j + 1])
                        if isinstance(obj, dict):
                            found = obj
                    except (json.JSONDecodeError, ValueError):
                        pass
                    break
    return found


def parse_derivation(text: Optional[str]) -> Optional[dict]:
    """Validate a deriver's JSON verdict {canonical_answer, derivation_summary, confidence}."""
    obj = extract_json(text)
    if not isinstance(obj, dict):
        return None
    ans = obj.get("canonical_answer")
    summ = obj.get("derivation_summary")
    conf = str(obj.get("confidence", "")).strip().lower()
    if not isinstance(ans, str) or not ans.strip():
        return None
    return {
        "canonical_answer": ans.strip(),
        "derivation_summary": summ.strip() if isinstance(summ, str) else "",
        "confidence": conf if conf in _CONFIDENCE else "low",
    }


def parse_comparison(text: Optional[str], n_derivations: int) -> Optional[dict]:
    """Validate the comparator JSON, incl. the Executor-2 extensions majority_indices + veto flag."""
    obj = extract_json(text)
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
# Prompts (mirror Executor 1's vPrompt/cmpPrompt/tiePrompt; comparator schema extended for R1/R2).
# --------------------------------------------------------------------------------------
_DERIVE_SYSTEM = (
    "You are an expert mathematician/physicist doing an INDEPENDENT blind re-derivation. "
    "Derive the requested quantity FROM SCRATCH; do not assume any answer. Be rigorous about signs, "
    "factors, and branch choices. Output ONLY a single fenced ```json block with EXACTLY these keys: "
    '"canonical_answer" (the result in the exact requested format), "derivation_summary" (2-6 sentences '
    "of the actual steps, incl. any computation you ran and its output), \"confidence\" (high|medium|low). "
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
        "You MAY run python (sympy/mpmath) / julia to verify integrals/algebra/numerics; if you do, "
        "show the output in derivation_summary."
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
        try:
            subprocess.run(cmd, timeout=(self.timeout + 60) if self.timeout else None,
                           capture_output=True, text=True, check=False)
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
    rounds = 0
    while not decide_converged(cmp, families) and rounds < max_iter:
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

    converged = decide_converged(cmp, families)
    return {
        "claim": c["id"],
        "converged": converged,
        "independent_confirmations": cmp["majority_size"],
        "cross_family_confirmations": cross_family_confirmations(cmp, families),
        "families": sorted(set(families)),
        "total_derivations": len(derivations),
        "iterate_rounds": rounds,
        "agreed_answer": cmp["majority_answer"],
        "adjudicated_correct": cmp["correct_answer_adjudicated"],
        "adjudicated_matches_majority": cmp["adjudicated_matches_majority"],
        "outliers": cmp["outliers"],
    }


def _summarize(rows: list[dict], n_claims: int) -> dict:
    unconverged = [r["claim"] for r in rows if not r["converged"]]
    return {
        "total_claims": len(rows),
        "converged": sum(1 for r in rows if r["converged"]),
        "unconverged": unconverged,
        "clean_first_pass": sum(1 for r in rows if r["converged"] and r["iterate_rounds"] == 0),
        "needed_iteration": [{"claim": r["claim"], "rounds": r["iterate_rounds"]} for r in rows if r["iterate_rounds"] > 0],
        "dropped_claims": n_claims - len(rows),
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
                "claim": c.get("id", "?"), "converged": False, "independent_confirmations": 0,
                "cross_family_confirmations": 0, "families": [], "total_derivations": 0,
                "iterate_rounds": 0, "agreed_answer": "", "adjudicated_correct": f"(error: {exc})",
                "adjudicated_matches_majority": False, "outliers": f"claim crashed: {exc}",
            })
    return _summarize(rows, len(claims))


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
