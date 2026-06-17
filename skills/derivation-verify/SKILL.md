---
name: derivation-verify
description: >
  Convergence-gate harness for DERIVATION-heavy results (loop integrals, spectral densities,
  algebraic/operator identities, closed forms, sign/branch choices). For each atomic claim it runs
  >=2 INDEPENDENT blind re-derivations, an adversarial comparator that clusters them by MATHEMATICAL
  equivalence, and a tie-break loop that adds fresh independent derivations until >=2 agree — emitting
  an auditable verification matrix. Backend-agnostic contract with TWO executors: a Claude/Workflow-native
  one (same-model, fast) and a CLI multi-backend one (Claude/Codex/Gemini/OpenCode) that enforces
  cross-model-FAMILY agreement + an adjudicator veto for the strongest verification. Sibling to
  `review-swarm` (which REVIEWS an artifact); this one RE-DERIVES the answer.
---

# Derivation Verify

A reusable convergence gate for the question *"is this derived result actually correct, independently?"*
It enforces the standing rule: **every derivation needs >=2 independent verifications; iterate every
disagreement to convergence; the leader never self-declares convergence.**

## When to use

Use when you have a **derivation result** to certify and you want independent confirmation + disagreement
iteration — e.g.:
- a loop function / loop integral (e.g. `A(q)=arctan(q/2m)/2q` from a Feynman-parameter loop),
- a spectral density (`rho = -Im X(i mu)`), a coordinate-space transform, a closed form,
- an operator/algebraic identity, a sign or branch choice, a numeric anchor.

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
  --comparator codex/default --out matrix.json   # add --tools for best-effort CAS/compute modes
```

Because same-model agreement is weak evidence (same-model committees exhibit *representational
collapse*), Executor 2 enforces three SOTA-grounded rules ON TOP of "majority_size >= 2":

- **R1 cross-family diversity** — a claim converges only on **>=2 derivations from DISTINCT model
  families** that the comparator clusters as mathematically equivalent (two answers from the same
  backend do not count as independent).
- **R2 adjudicator veto** — the comparator INDEPENDENTLY recomputes the answer; if its recompute does
  not match the agreeing cluster, the claim does **not** converge (guards a correlated wrong majority,
  the "consensus trap").
- **R3 diversity-first tie-break** — each tie-break round pulls a not-yet-used family first, bounded
  by `max_iter` (adaptive KS/Beta-Binomial stopping is a documented future enhancement).

The output matrix is a SUPERSET of Executor 1's: each row adds `cross_family_confirmations`, `families`,
and `adjudicated_matches_majority`; the summary adds `dropped_claims`. `converged` reflects R1+R2.
Offline unit tests (mock runner, no real backends) live in `tests/test_run_multi_backend.py`.

## Why two executors

- **Executor 1 (Claude/Workflow-native)** — same-model, in-process, fast and cheap; a strong lower
  bound usable immediately inside Claude Code.
- **Executor 2 (CLI multi-backend)** — cross-model-family, the reliability ceiling; the right choice
  for results you must certify rigorously. It costs more (multiple CLI engines, slower) but decorrelates
  errors in a way no single model can.

The backend-agnostic contract means claims written for one executor run on the other unchanged.

## Provenance

Extracted from the LatticeEFT.jl N²LO chiral-force verification (run `wf_c3e78019-8e9`: 11 atomic
claims, 11/11 converged; the blind round caught a real `W~_S` +2/3 vs -1/3 split, resolved to +2/3).
The args-as-string parsing was fixed after a smoke-test found it silently dropped claims.
