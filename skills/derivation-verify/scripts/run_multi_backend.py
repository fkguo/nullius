#!/usr/bin/env python3
"""
derivation-verify — Executor 2 (CLI multi-backend) — STUB / planned.

Satisfies the SAME backend-agnostic contract as the Claude/Workflow-native executor
(../workflows/derivation_verify.js; see ../references/contract.md), but runs the >=2 INDEPENDENT
blind re-derivations across SEPARATE model CLIs (Claude / Codex / Gemini / OpenCode) for TRUE
cross-model independence — the reliability ceiling.

Design (not yet implemented):
  - Reuse review-swarm's multi-backend runner `skills/review-swarm/scripts/bin/run_multi_task.py`
    to launch, per claim, >=2 derivers on DIFFERENT backends with the blind prompt
    (context + statement + method_i; the answer is NOT revealed).
  - Each deriver emits {canonical_answer, derivation_summary, confidence} (JSON contract).
  - A comparator pass (any one backend) clusters by MATHEMATICAL equivalence and names outliers+error.
  - Tie-break loop adds fresh independent derivers (new backend/seed) until >=2 agree or max_iter.
  - Emit the verification matrix (identical schema to Executor 1).

Why a stub: Executor 1 (Claude/Workflow-native) is shipped and sufficient for "Claude works now";
Executor 2 is the cross-model upgrade. Keeping this seam explicit so adding it later is drop-in
(the input/output contract does not change — only the derivation backend does).

Usage (planned):
    python3 run_multi_backend.py --claims claims.json --backends claude,codex,gemini --out matrix.json
"""
import sys


def main(argv=None):
    raise NotImplementedError(
        "derivation-verify Executor 2 (CLI multi-backend) is a planned stub. "
        "Use Executor 1 now: Workflow({scriptPath: '.../workflows/derivation_verify.js', args: {...}}). "
        "Executor 2 will reuse skills/review-swarm/scripts/bin/run_multi_task.py for cross-model derivers "
        "under the same contract (see ../references/contract.md)."
    )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
