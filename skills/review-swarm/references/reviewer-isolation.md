Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### Reviewer context isolation and sealed-first-phase discipline

Input-framing independence dies through the environment, not just the packet. Two rules, both learned
from real contamination events that voided otherwise-clean review rounds:

- **Strip ambient work-state from the reviewer's context.** A reviewer must not receive agent
  rosters, task listings, other workstreams' status lines, or any environment surface that can carry
  another lane's conclusions — one leaked status line about a sibling result is enough to anchor the
  reviewer and void the round. The dispatch assembles a context containing the packet and nothing
  else, and records in `meta.json` which surfaces the reviewer could see. Contamination is about
  receiving **conclusions**, not about reading **source**: a source-grounded review lane is required
  to read the real code, and read-only repository access never forfeits its independence credit.
  Failed, partial and contract-invalid deliveries cannot supply completed seats. Three additional lane
  classes lose comparison credit: lanes running a *writable* workspace tool mode
  (discovery-grade — the reviewer read-only rule cannot be attested for them), lanes whose ambient
  context carried another workstream's conclusions, and fallback lanes with no recorded execution
  model (reason `model_unattributed`: a backend-default recovery leaves the executed family
  unattested, and on a multi-family provider that would let an unknown family pair into a false
  cross-family claim — explicit fallback-model flags exist for the codex and claude backends;
  other backends' default recoveries stay unattributed, which is the conservative direction). Sealed
  derivation/recomputation lanes obey the stricter frozen-inputs-only contract of their own
  protocols (the sealed-derivation rule below and the [independent-recomputation role](result-and-artifact-roles.md)):
  launch those ONLY on backends whose modeled tool mode is explicitly a no-repo-access mode. The
  per-result `execution_tool_mode` field in `meta.json` records the launcher-modeled mode of the
  resolved execution backend — `null` means the backend is unmodeled and **attests nothing**, and
  a backend whose runner is inherently repository-readable (a read-only sandbox, recorded as
  `review`) is a browsing lane: fine for source-grounded review, never for a sealed derivation.
  When ambient listings reached the reviewer anyway, the
  round's disposition is `AMBIENT_CONTEXT_CONTAMINATED`: it earns **zero** independence,
  comparison, acceptance, or convergence credit, and its output is retained for diagnosis only.
  (This disposition is distinct from the legitimate *candidate-visible* second pass of the
  source-fidelity protocol — a contaminated round never becomes a valid candidate-visible
  comparison by relabeling.) Machine support: `run_multi_task.py` decides credit per lane from the
  **resolved post-fallback** execution backend — a lane recovered onto another backend is judged by
  where it actually ran, and a failed lane never earns a seat or convergence input. Excluded lanes
  (reason `tool_mode:workspace` or `model_unattributed` automatically, or reason
  `AMBIENT_CONTEXT_CONTAMINATED` via the repeatable `--contaminated <selector>` flag, matching the
  model spec as given, the resolved spec, the backend, the family name, or `backend/model`) appear
  with their lane index under `independence.non_independent_lanes`, never count toward the
  cross-family level, are filtered out of the convergence similarity set
  (`convergence.excluded_non_independent` names them), and never occupy a dual-review comparison
  seat. A `--contaminated` selector that matches no lane aborts the run before execution — a
  declared contamination must never silently fail to bind.
- **Keep the operator's own context out of the lane.** Input-framing independence also means the lane
  carries no operator memory: no user-level instruction files, no project instruction files of the
  operator's checkout (`CLAUDE.md`, `AGENTS.md` and the like), and no auto memory of earlier sessions.
  Those files routinely record the conclusion under test or the author's initial judgment, and their
  style rules change the lane's language. Anything a lane legitimately needs belongs in its own request.
  The Claude runner enforces this by default (`--safe-mode`; `claude-cli-runner` SKILL.md, **Context
  sources**) and records the allowed sources per invocation in `context_sources.json` of the attempt
  directory (`OUT.attempts/run.*/` unless a trace directory is given), plus the observed init-event check
  under live capture; a rejected lane has `runner_failure_reason: not_hermetic`, class `configuration`,
  and is not counted as a backend outage (it still triggers fallback; a lane recovered on another backend
  carries no hermetic record). The project-local Claude runner copy that the research-team
  workflow installs (`scripts/run_claude.sh`) applies the same exclusion but does not write the record;
  a copy made before the exclusion existed is replaced by the shared runner for the run (with a warning)
  until it is refreshed (research-team RUNBOOK, **Refreshing the Claude runner copy**). Other backends'
  runners do not yet exclude or record this; their lanes carry no such attestation.
- **Seal the independent phase from the first round (sealed-derivation protocol).** Whenever a
  review both (i) derives or recomputes a target quantity and (ii) will afterwards read the
  candidate, run the sealed-derivation protocol from round one: the reviewer receives only the
  frozen problem statement and raw inputs, derives, persists that derivation (content hash
  recorded) and **terminates**; only then does a comparison pass open the candidate. This is NOT
  the [`--two-phase` protocol](two-phase-protocol.md) — that protocol commits *review criteria* before revealing the
  packet and never seals a derivation; invoking it does not satisfy this rule. Retrofitting the
  sealed order only after a contamination event pays for the same round twice; opening the
  candidate before the sealed derivation exists voids the independence claim regardless of intent.
