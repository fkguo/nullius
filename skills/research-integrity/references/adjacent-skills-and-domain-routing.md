Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Integration with adjacent skills

- `research-harness` is the project-state recovery and routing skill.
  It is where M7 (frame_lock) reset typically happens: re-read
  `research_contract.md` and `research_plan.md#Current Status` with
  fresh eyes. The `HARNESS_INVOCATION_REQUIRED` anchor gate enforced
  in every `*-mcp` dispatcher ensures tool calls cannot proceed without
  re-anchoring; this skill's M7 step is the human-facing complement.
- `research-team` enforces M5 and M6 mechanically via the
  Reproducibility Capsule contract in `research_contract.md`. Inside
  an active research-team cycle, M5 and M6 are partly covered by
  the cycle's convergence gate; this skill's job there is the
  M1–M4 and M7 angles.
- `markdown-hygiene` should run before any check that relies on
  Markdown math being rendered correctly, otherwise numeric
  quotations may be misread during the M3 check.
- `referee-review` runs the integrity check from the *reviewer* side
  with a strict verdict contract. If a draft is heading to
  `referee-review`, run M1–M7 first and confirm any applicable M8
  pre-computation checks so the reviewer's BLOCKING findings are not
  symptoms the author could have caught.
- `paper-reviser` is the right surface for acting on M2/M3/M4/M7
  findings that surface during late-stage drafting.
- `claim-grounding` is the active execution of the M2/M3 obligations.
  Where this skill mandates *that* citations and cited numbers be checked
  against their sources, `claim-grounding` is the generic, domain-routed
  way to *do* it: for each cited claim it first binds the displayed title,
  authors when present, identifier, and URL to hash-bound canonical metadata,
  then fetches the source and records a span-backed verdict in a
  `claim_grounding_report_v1` artifact. A citation-identity mismatch is a hard
  failure even when the quoted full text supports the prose claim; unavailable
  canonical metadata fails closed for load-bearing citations. A
  `substantiated` verdict that carries no verbatim source quote is mechanically
  downgraded. It also carries the transcription-fidelity
  dimension (does the note's quote / value / locator match the fetched
  source span, not merely "is the claim true") used by the
  [Extraction / transcription fidelity check](transcription-fidelity.md), owns attribution and
  priority claims (proposed versus proved; "first" needs an earlier-source
  check), and closes citation-heavy deliverables with an independent blind
  audit. It stays a generic skill
  plus a `@nullius/shared` contract — not a `hep-mcp` tool — consistent
  with the criterion below.

## HEP-specific augmentation (future, out of scope here)

This generic skill stays domain-neutral. Future machine checks may
belong inside `@nullius/hep-mcp` — but only when the check is
**genuinely HEP-bound by its core contract**, not merely because it
involves a tool whose name contains `hep`, `inspire`, or `pdg`.

**Criterion for whether a check is truly HEP-bound** (judge by what
the check *does*, not by the package it would live in):

- A PDG-drift check that compares a cited mass / branching fraction
  against the current PDG record and flags excess deviation **is**
  HEP-bound — PDG only tracks HEP particle properties, no equivalent
  exists in other disciplines.
- A FeynRules / FeynArts model consistency check **is** HEP-bound —
  the underlying QFT model formalism is HEP-specific.
- A lattice ensemble metadata check (action, $\beta$, $a$, $V$,
  sea-quark content) **is** HEP-bound — the ensemble metadata
  schema is lattice-QCD-specific.
- A generic "verify each cited number against its source table"
  check is **not** HEP-bound — every discipline has tables and
  numbers; this belongs in this skill (M3), not in `hep-mcp`.
- A generic "verify each cited paper resolves to a real record"
  check is **not** HEP-bound — `inspire_validate_bibliography`'s
  default mode already audits non-INSPIRE entries for locatability,
  and OpenAlex / arXiv resolvers are cross-domain by data. This
  belongs in this skill (M2), not as a new `hep-mcp` tool.

If a candidate future tool fails the criterion, it does not become
HEP-bound by being implemented inside `hep-mcp`; it stays a generic
discipline obligation, captured here as a mode rather than as a tool.

PDG-drift is the leading HEP-bound candidate tracked separately for
future work, not part of this skill's initial scope.
