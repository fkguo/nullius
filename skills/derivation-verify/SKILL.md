---
name: derivation-verify
description: "Convergence-gate harness for DERIVATION-heavy results in ANY field (closed forms, integrals/sums, algebraic/operator/logical identities, probabilities/estimators, asymptotic/complexity bounds, sign/branch/boundary choices — domain carried only by the caller's context). For each atomic claim it runs >=2 INDEPENDENT blind re-derivations, an adversarial comparator that clusters them by MATHEMATICAL equivalence, and a tie-break loop that adds fresh independent derivations until >=2 agree — emitting an auditable verification matrix. Backend-agnostic contract with TWO executors: a Claude/Workflow-native one (same-model, fast) and a CLI multi-backend one (Claude/Codex/Gemini/OpenCode) that enforces cross-model-FAMILY agreement + an adjudicator veto for the strongest verification. Sibling to `review-swarm` (which REVIEWS an artifact); this one RE-DERIVES the answer.\n"
---

# Derivation Verify

A reusable convergence gate for the question *"is this derived result actually correct, independently?"*
It enforces the standing rule: **every derivation needs >=2 independent verifications; iterate every
disagreement to convergence; the leader never self-declares convergence.**

## When to use

Use when you have a **derivation result** in **any field** to certify and you want independent
confirmation + disagreement iteration. The skill is domain-neutral — only the caller-supplied `context`
and `statement` carry the domain. Example claim types (illustrative, not a fixed list):
- a closed form / integral / sum (e.g. a loop integral `A(q)=arctan(q/2m)/2q`, or a combinatorial sum),
- an algebraic / operator / logical identity; a sign, branch, or boundary-case choice,
- a probability or estimator (e.g. an MLE / variance), an asymptotic or complexity bound (e.g. `Θ(n log n)`),
- a transform, a limiting value, or a numeric anchor.

Each is phrased as an **atomic claim**: a thing to **DERIVE BLIND** (the answer is NOT given to the
deriver) and report in a fixed canonical format.

## When NOT to use (use a sibling instead)

- **Reviewing an existing artifact** (a diff, a draft, a manuscript) against a contract → use
  [`review-swarm`](../review-swarm/SKILL.md) (clean-room reviewers, review-contract, Jaccard convergence).
  *Different verb:* review-swarm **critiques an artifact**; derivation-verify **re-derives the answer N
  ways and reconciles by mathematical equivalence** (not text similarity).
- **A full milestone research cycle** with drafts/gates → use [`research-team`](../research-team/SKILL.md).

## The contract (backend-agnostic)

Independent of the executor. Inputs:

```
context : string         # shared ground-truth equations / conventions, given to every deriver
max_iter: int  (def 3)   # tie-break rounds before giving up on a claim
claims  : [ {
  id            : string
  statement     : string # what to DERIVE BLIND (do NOT reveal the answer)
  report_format : string # exact canonical format for the answer (so results are comparable)
  method0       : string # method hint for independent deriver #0 (a distinct route)
  method1       : string # method hint for independent deriver #1 (a different distinct route)
} ]
```

Per claim the gate: (1) spawns derivers #0/#1 **blind** and method-diverse; (2) an impartial
**comparator** clusters the derivations by *mathematical* equivalence (not string equality) and names
the majority + outliers-with-their-error; (3) if `< 2` agree, adds independent tie-break derivers up to
`max_iter` until `>= 2` mathematically-equivalent derivations agree. A claim is **converged** iff
`independent_confirmations >= 2`.

Output — a verification matrix:

```
{ total_claims, converged, unconverged:[ids], clean_first_pass, needed_iteration:[{claim,rounds}],
  matrix:[ { claim, converged, independent_confirmations, total_derivations, iterate_rounds,
             agreed_answer, adjudicated_correct, outliers } ] }
```

See [`references/contract.md`](references/contract.md) for the full schema (any executor must satisfy it).

## Executor 1 — Claude / Workflow-native (available now)

`workflows/derivation_verify.js` is a Claude Code **Workflow** script (in-process Claude subagents via
the Workflow tool's `agent()`/`parallel()`/`phase()` primitives). Fast, cheap, tightly integrated;
**Claude-only by construction** (the Workflow tool exists only in Claude Code). Invoke:

```
Workflow({ scriptPath: ".../skills/derivation-verify/workflows/derivation_verify.js", args: {
  context: "shared ground-truth + conventions",
  max_iter: 3,
  claims: [ { id, statement, report_format, method0, method1 }, ... ]
}})
```

`args` may be passed as a JSON object OR a JSON string — the script accepts both (the Workflow tool
serializes complex args to a string in some environments). Smoke-test fixture:
[`tests/smoke_args.json`](tests/smoke_args.json) (2 trivial claims → expect 2/2 converged).

> Note: ">=2 independent" here means >=2 independent **Claude** derivations (same model, different
> prompts/seeds/methods) — a strong, fast lower bound. The quality ceiling is cross-MODEL independence
> (Executor 2).

## Executor 2 — CLI multi-backend (available; cross-model independence)

`scripts/run_multi_backend.py` satisfies the SAME contract using separate model CLIs, reusing
[`review-swarm`](../review-swarm/SKILL.md)'s `scripts/bin/run_multi_task.py` as the per-backend
launcher (each deriver/comparator = one runner invocation pinned to one model spec), with the
comparator/iteration logic on top. This gives **true cross-model independence** — different engines
catch different errors — at higher cost. The input contract is unchanged, so a caller's claims port
verbatim from Executor 1.

```
python3 scripts/run_multi_backend.py --claims claims.json \
  --backends claude/default,codex/default,gemini/default,opencode/default \
  --comparator codex/default --out matrix.json   # --tools = best-effort tool modes;
                                                   # --comparators a,b,c = cross-family judge panel
```

> **Requires the [`review-swarm`](../review-swarm/SKILL.md) skill installed alongside this one** —
> Executor 2 reuses its `scripts/bin/run_multi_task.py` as the per-backend launcher. It is a declared
> market dependency (so installers pull it in automatically); for a non-standard layout, set
> `$DERIVATION_VERIFY_RUNNER` or pass `--runner /path/to/run_multi_task.py`. Without it, Executor 2
> exits with an actionable error (Executor 1, the Workflow path, has no such dependency).

> `--tools` grants each backend the strongest tool mode `run_multi_task.py` exposes, but for most
> backends that is **read-only** (claude/gemini `review`; codex default sandbox) — only `opencode`
> `workspace` can execute code, and even then a CAS is not guaranteed. So derivations are
> reasoning-first; the deriver prompt asks the model to use a CAS only *if* its CLI actually exposes
> one, else derive analytically. Treat real code-execution as opportunistic, not assured.

Because same-model agreement is weak evidence (same-model committees exhibit *representational
collapse*), Executor 2 enforces these SOTA-grounded rules ON TOP of "majority_size >= 2":

- **R1 cross-family diversity** — a claim converges only on **>=2 derivations from DISTINCT model
  families** judged equivalent (two answers from the same backend do not count as independent).
- **CAS grounding + blind/de-anchored adjudication (capability-first)** — each deriver emits an optional
  `checkable_form` (its answer as a strict sympy expression). When **>=2 cross-family forms are
  CAS-verified equal** (symbolic + deterministic random-point identity test), convergence is decided
  **without the comparator at all** — an LLM-INDEPENDENT verdict (`verification: "cas"`). This is the
  blind adjudication: the (anchored) comparator that has *seen* the candidate answers is not in the gate
  path, and a CAS refutation **overrides** a hallucinated LLM consensus (consensus-trap guard). The
  engine **abstains** on anything not safely checkable (asymptotic notation, sets, prose, undefined
  functions) — abstaining falls back to the LLM path, never a wrong CAS verdict.
- **R2 adjudicator veto (LLM fallback)** — when no answer is CAS-checkable (`verification: "llm"`), the
  comparator clusters + independently recomputes; mismatch ⇒ not converged. Pass `--comparators a,b,c`
  for a **cross-family judge panel**: each judge clusters/recomputes independently and the gate takes the
  STRICT-MAJORITY consensus (an index must be agreed by a majority of judges; the veto needs a majority)
  — this de-biases any single anchored judge (SOTA: multiple judges surface judge bias). `judges` in each
  row reports how many returned a usable verdict; default is one judge (unchanged behaviour).
- **R3 diversity-first tie-break** — each tie-break round pulls a not-yet-used family first, bounded
  by `max_iter` (adaptive KS/Beta-Binomial stopping is a documented future enhancement).

The output matrix is a SUPERSET of Executor 1's: each row adds `verification` (`cas` | `llm` | `error`),
`cross_family_confirmations`, `families`, `judges` (comparator-panel size that returned a verdict), and
`adjudicated_matches_majority`; the summary adds `dropped_claims` and `family_pool`. Offline unit tests (mock runner + local CAS, no real backends) live
in `tests/test_run_multi_backend.py`.

> **Residual limit (honest):** for `verification: "cas"`, CAS proves the cross-family AGREEMENT is real,
> not that the agreed answer is CORRECT — a wrong result still slips through only if >=2 independent
> families AND (for `llm`) the adjudicator share the *same* error (irreducible correlated-error floor of
> any LLM gate). CAS makes that floor the binding constraint by removing mis-clustering and judge
> anchoring; it cannot remove shared misconceptions or a mis-stated problem. Non-checkable claims stay
> fully LLM-bounded. The CAS check also assumes **no domain restrictions** (complex domain, principal
> branches): domain-specific identities like `log(x*y) = log x + log y` (true only for `x,y>0`) are
> *refuted* by CAS and correctly fall through to the LLM path rather than being force-confirmed.

## Why two executors

- **Executor 1 (Claude/Workflow-native)** — same-model, in-process, fast and cheap; a strong lower
  bound usable immediately inside Claude Code.
- **Executor 2 (CLI multi-backend)** — cross-model-family, the reliability ceiling; the right choice
  for results you must certify rigorously. It costs more (multiple CLI engines, slower) but decorrelates
  errors in a way no single model can.

The backend-agnostic contract means claims written for one executor run on the other unchanged.

## Host-aware execution (run your own family natively; quality first)

These executors are consumed by a host agent (Claude Code, Codex, OpenCode, Claude Desktop, …) whose
capabilities VARY — gate on what your host actually exposes. Route by **model family**, correctness first:

- **Your own family → keep it in-host, never via that family's CLI.** Shelling out to reach a model you
  are already running as only adds latency, a separate auth/session, and context loss. If your host
  exposes a native child-agent / sub-agent primitive (Claude Code's Agent/Task tool — Executor 1's
  `agent()`; OpenCode subagents) use it for parallel same-family derivations; if it does NOT (e.g. plain
  Claude Desktop, the Gemini CLI), run that family's derivation INLINE in your own loop. Either way don't
  `claude exec` / `codex exec` your own family. For same-model rigor in Claude Code this is just Executor 1.
- **Cross-family certification → all backends go through the runner (honest caveat).** Executor 2's
  cross-family convergence (like review-swarm's swarm) launches every deriver in ONE process and
  aggregates over THEIR outputs. A natively-run Executor 1 result is therefore a SEPARATE same-family
  result — it is NOT in Executor 2's matrix and does NOT count toward `cross_family_confirmations`. So to
  get one unified cross-model verdict the Claude deriver does run through the `claude` CLI inside
  Executor 2; that hop is the price of in-process aggregation, not waste. Use Executor 2 only when you
  need cross-MODEL certification; for same-model checks stay on Executor 1. (A future Executor 2 input
  that ingests a host-provided native derivation would remove even that hop.)
- **Reasoning effort scales with claim difficulty — quality first.** A hard loop integral, a subtle
  sign/branch choice, or a contested closed form warrants your MAXIMUM thinking (extended thinking /
  high–xhigh reasoning effort / a stronger model spec); a trivial anchor does not. Never trade a wrong
  verdict for cheaper tokens. On the native path you control this directly; on the CLI path pick a capable
  model spec (e.g. a strong codex/gemini model at high effort) for the hard claims and comparator.
- **Prefer a steerable background task when the host supports it.** A long/expensive verification (many
  claims, several tie-break rounds, cross-model) is often better spawned as a background task **chip**
  (e.g. Claude Code's spawn-task) the user can inspect and adjust mid-run, rather than one blocking call.
  If the host has no such primitive, run inline and checkpoint. Capability varies by host — degrade
  gracefully.

## Provenance

Extracted from the LatticeEFT.jl N²LO chiral-force verification (run `wf_c3e78019-8e9`: 11 atomic
claims, 11/11 converged; the blind round caught a real `W~_S` +2/3 vs -1/3 split, resolved to +2/3).
The args-as-string parsing was fixed after a smoke-test found it silently dropped claims.
