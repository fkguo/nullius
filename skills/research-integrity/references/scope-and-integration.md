Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## What this skill is NOT

- Not a substitute for the citation and reference graph verification
  that provider MCP tools perform (`inspire_*`, `openalex_*`,
  `arxiv_*`, `pdg_*`, `hepdata_*`). Those are the **evidence** tools;
  this is the **discipline** that decides which evidence calls are
  required per boundary crossing and verifies they were made.
- Not a re-implementation of any provider tool. When a [mode](../SKILL.md#boundary-walk-and-focused-reading)
  lists tool names under "Required evidence calls", those names point
  at existing MCP capabilities; the skill does not duplicate their
  logic, it only mandates when to call them.
- Not a structured artifact. There is no `integrity_report.json` schema.
  The check result is recorded inline in the response or notebook entry
  next to the boundary-crossing action. When the boundary itself was a
  human go-ahead given in conversation, record that decision with
  `nullius decision record "<what was decided>"` so it survives the
  conversation (see the [pre-approval ritual](boundary-recording.md#pre-approval-ritual) for the engine's
  approval-flow counterpart).
- Not domain-specific. Each mode is genuinely domain-neutral. Resolver
  and graph tools are routed **by discipline of the cited work**, not
  by which MCP package they live in. The package name is not a domain
  label — for example, `inspire_validate_bibliography` lives in
  `hep-mcp` but its default mode audits *non-INSPIRE* entries, and
  `inspire_resolve_citekey` takes an INSPIRE `recid` (not a citekey
  string) and only resolves entries already in INSPIRE-HEP. Always
  consult the tool's actual schema and handler before reasoning about
  its scope.
- Not a replacement for human review. It is a stricter version of the
  agent's own self-review that biases toward finding the failure mode
  rather than confirming the work is fine.
