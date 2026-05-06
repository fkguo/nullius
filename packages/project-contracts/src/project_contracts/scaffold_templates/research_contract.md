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
- Treat `autoresearch` as the guaranteed root entrypoint for this scaffold.
- Treat that status output as the authoritative recovery briefing.
- When the host exposes orchestration or MCP control-plane commands such as `orch_*`, those host-local surfaces may be used as optional control planes; do not assume a literal `orch_*` command exists in every scaffolded project.
- Provider/domain MCP tools are capability sources, not root authority; do not treat provider MCPs such as `hep-mcp` as the generic root authority.
- If any A1-A5 approval is pending, stop there. Silence is never approval.
- If evidence is incomplete, mark the state `uncertain`, `abstained`, `unavailable`, or as a reading gap instead of writing a stronger conclusion.
- Then re-read [project_index.md](project_index.md), [AGENTS.md](AGENTS.md), [project_charter.md](project_charter.md), [research_plan.md](research_plan.md), and this file before resuming.
- Read [research_notebook.md](research_notebook.md) when it already contains substantive content.
- Optional host/provider/support surfaces are used only when this project explicitly creates them; this contract and `.autoresearch/` state remain the durable restart truth.

## Skepticism And Verification Rule

- Treat sources, generated outputs, and prior notes as hypotheses until checked.
- Every claim that affects the project direction needs an evidence pointer, a verification status, and a clear owner or next check.
- Mark unverified assumptions explicitly and record what observation, reproduction, or review would change the conclusion.
- Do not present a decisive conclusion unless the evidence and verification status below support it.

## Literature Note Quality Rule

- Important or directly related papers require full-text reading before they support central claims; prefer arXiv LaTeX source when available.
- Record source form read as `latex_source`, `full_text_pdf`, `available_full_text`, `abstract_only`, or `unavailable`.
- For important sources, record sections/pages/equations/figures actually read, central equations and assumptions, what was not read and why, project relevance, limitations, and remaining gaps.
- `abstract_only` and `unavailable` mark reading gaps, not completed evidence for central claims.
- Literature notes record scientific content only. Put tool-use logs, metadata checks, download attempts, and API/MCP call details in [research_plan.md](research_plan.md) progress entries or `artifacts/runs/<run_id>/`.
- Use clickable Markdown links for source references, and write scientific notation as LaTeX math instead of inline-code backticks.

## Artifact And Provenance Rule

- Store meaningful run outputs under `artifacts/runs/<run_id>/`.
- Choose `run_id` as a project-local research identity, not as an opaque machine
  identity. Prefer `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN`, for
  example `20260502T023000Z-m3-branch-scan-r1`.
- A valid human-facing `run_id` uses only letters, digits, `.`, `_`, and `-`;
  it must not contain path separators, `..`, whitespace, bare UUIDs,
  `run_<uuid>`, or other low-information generated names.
- If a provider records its own UUID or `run_<uuid>` identifier, keep that value
  as provider provenance inside the manifest; do not promote it to the
  project-local artifact root name.
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
  - `artifacts/runs/<run_id>/manifest.json`
  - `artifacts/runs/<run_id>/summary.json`
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
| C1 |  | `artifacts/runs/<run_id>/summary.json#...` | candidate / checked / blocked / rejected |  |

## Final Conclusion Gate

Before declaring the milestone or project complete:

- All headline claims have evidence pointers.
- The relevant artifacts have provenance.
- Verification checks are recorded with pass/fail status.
- Known limitations and unresolved assumptions are listed.
- No final conclusion is stronger than the evidence supports.

## References

Add stable source links, project-local notes, or artifact references here when they are used.
