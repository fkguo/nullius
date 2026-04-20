# Research-Quality Proof Harness

This harness is a minimal quality gate, not a general eval platform.

As of April 20, 2026, recent agent-eval guidance has moved further toward:

- fixed fixtures and explicit rubrics instead of broad proxy scores
- trace-level grading and state inspection instead of outcome-only scoring
- contamination-aware interpretation of benchmark wins
- explicit treatment of randomness and non-determinism as part of the eval contract

This harness adopts only the smallest subset needed for the current lane:

- fixed fixtures
- four repo-level judgment dimensions only
- single-run canonical trace lock on each case
- explicit proof-vs-proxy metadata per case
- explicit low-risk contamination posture
- bounded semantic contract cases rather than open-ended semantic capability claims

What this harness proves:

- weak evidence can force abstention
- missing semantic authority fails closed
- sufficient provenance yields a stable verdict and reason code
- single-run verdict, reason code, and proof-bearing normalized state are locked as a canonical trace artifact

What this harness does not prove:

- retrieval coverage
- taxonomy quality
- benchmark breadth
- end-to-end research excellence across all tasks
- robustness under model drift or broader stochasticity regimes
- variance bounds under stochastic sampling
- open-ended semantic correctness beyond the bounded sampled-contract cases in this harness

Why this remains intentionally small:

- expanding to broader productized eval coverage would dilute the signal for this lane
- adding capability-oriented cases would risk turning local success into false quality proof
- contamination analysis is handled here as a boundary note, not as a new subsystem

SOTA directions adopted here:

- trace-first evaluation rather than final-answer-only scoring
- explicit per-case rubric and proof-vs-proxy metadata
- contamination-aware interpretation of benchmark claims
- canonical trace locking on fixed fixtures as a narrow regression gate
- proof-bearing fields only in the locked canonical trace

SOTA directions intentionally not implemented in this lane:

- judge-model calibration loops
- repeated stochastic sampling / variance analysis
- continuously refreshed benchmark sets
- broader productized evaluation infrastructure

Reference directions:

- OpenAI trace grading and agent eval guidance
- OpenAI grader guidance and evaluation best practices
- `openai/model_spec_evals` as a structural reference for rubric-based policy evals
- `LiveBench` as a structural reference for contamination-aware benchmark design
