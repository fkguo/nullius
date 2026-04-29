# research_contract.md

Project: <PROJECT_NAME>
Last updated: <YYYY-MM-DD>

This file is the machine-facing contract for restart, evidence, artifacts, and final conclusions.
Keep narrative reasoning, interpretation, and human-readable notes in [research_notebook.md](research_notebook.md).

<!-- RESEARCH_NOTEBOOK_SYNC_START -->
- Source notebook: [research_notebook.md](research_notebook.md)
- Notebook sha256: `(refresh to populate)`

### Notebook sections

- (refresh to populate)

### Notebook references

- (refresh to populate)
<!-- RESEARCH_NOTEBOOK_SYNC_END -->

## Restart And Status Rule

- If `.autoresearch/` exists, run `autoresearch status --json` before continuing after a new session, reconnect, interruption, context reset, or handoff.
- If `autoresearch` is unavailable on `PATH`, run `.autoresearch/bin/autoresearch status --json` instead.
- Treat that status output as the authoritative recovery briefing.
- Then re-read `project_index.md`, `AGENTS.md`, `project_charter.md`, `research_plan.md`, and this file before resuming.
- Read [research_notebook.md](research_notebook.md) when it already contains substantive content.
- Optional host/provider/support surfaces are used only when this project explicitly creates them; this contract and `.autoresearch/` state remain the durable restart truth.

## Skepticism And Verification Rule

- Treat sources, generated outputs, and prior notes as hypotheses until checked.
- Every claim that affects the project direction needs an evidence pointer, a verification status, and a clear owner or next check.
- Mark unverified assumptions explicitly and record what observation, reproduction, or review would change the conclusion.
- Do not present a decisive conclusion unless the evidence and verification status below support it.

## Artifact And Provenance Rule

- Store meaningful run outputs under `artifacts/runs/<TAG>/`.
- Each completed milestone should include enough provenance for a future reader to identify inputs, commands, source versions, outputs, and checks.
- Prefer machine-readable manifests for structured outputs, with Markdown pointers for human review.
- When an artifact supports a claim, cite the project-relative path and the relevant field, row, section, or checksum.

<!-- REPRO_CAPSULE_START -->
## Reproducibility Capsule

Fill this section for each milestone or tag that is claimed as complete.

- Milestone/tag:
- Purpose:
- Date:
- Inputs:
- Assumptions:
- One-command reproduction:

```bash
<COMMAND THAT REPRODUCES OR CHECKS THE MILESTONE>
```

- Expected outputs:
  - `artifacts/runs/<TAG>/manifest.json`
  - `artifacts/runs/<TAG>/summary.json`
- Provenance pointers:
  - Source files or commits:
  - Input data or references:
  - Environment or tool versions:
- Verification checks:
  - Check ID:
  - Command or review method:
  - Result:
  - Tolerance or acceptance rule:
<!-- REPRO_CAPSULE_END -->

## Claims And Results

Use stable IDs so claims can be reviewed and revised.

| ID | Claim or result | Evidence pointer | Verification status | Notes |
|---|---|---|---|---|
| C1 |  | `artifacts/runs/<TAG>/summary.json#...` | candidate / checked / blocked / rejected |  |

## Final Conclusion Gate

Before declaring the milestone or project complete:

- All headline claims have evidence pointers.
- The relevant artifacts have provenance.
- Verification checks are recorded with pass/fail status.
- Known limitations and unresolved assumptions are listed.
- No final conclusion is stronger than the evidence supports.

## References

Add stable source links, project-local notes, or artifact references here when they are used.
