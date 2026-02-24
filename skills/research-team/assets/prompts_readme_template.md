# prompts/README.md

This folder contains prompt files used by the `research-team` workflow.

Note:
- Files prefixed with `_` are scaffolded defaults used by scripts.
- Customize them per project (they are meant to be edited).

Team cycle (theory+computation cross-check):
- `_team_packet.txt`: optional packet template (if you build packets manually)
- `_system_member_a.txt`: Member A system prompt (Claude runner)
- `_system_member_b.txt`: Member B system prompt (Gemini runner)
- `_system_member_c_numerics.txt`: optional numerics sidecar (non-blocking)

Draft cycle (LaTeX-source-first):
- `_system_draft_member_a.txt`: correctness audit (derivations/methods/results consistency)
- `_system_draft_member_b.txt`: literature positioning + substance-first writing audit
- `_system_draft_member_c_leader.txt`: team-leader style audit (equation-by-equation physics/math recomputation; strict correctness-blocking)
  - Evidence gate (anti-hallucination): any concrete claim about data provenance/sampling/uncertainties/weighting must be backed by an explicit packet anchor; otherwise treat as a blocking evidence gap and request the minimal missing excerpt.
