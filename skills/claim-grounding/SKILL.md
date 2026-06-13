---
name: claim-grounding
description: Active statement-support grounding for cited claims. For each claim that leans on a citation, fetch the cited source and verify its CONTENT actually substantiates the claim — recording a span-backed verdict in a claim_grounding_report_v1 artifact. Generic across domains; routes HEP claims through INSPIRE and everything else through arXiv/OpenAlex. Run before promoting an idea, folding claims into durable artifacts, or requesting final conclusions.
---

# Claim Grounding (statement-support verification)

This skill answers the one citation question that existing tooling does **not**:
**does the cited source's content actually substantiate this specific claim?**

The provider tools already cover the other levels:

- **(E) existence** — does the cited paper resolve? (`inspire_validate_bibliography`, resolvers, `arxiv_paper_source`, `openalex_content`)
- **(S) stance** — does the citing context support/refute the cited work? (`inspire_grade_evidence`, citation graphs)
- **(M) metadata** — bibliography format, citekeys, dedup.

What is missing is **(G) statement-support grounding**: fetching the cited source and
checking that *its text* backs the *author's assertion*. Today that is only the manual
`research-integrity` M3 step ("open the table and quote the value"). This skill makes it
an active, repeatable check that emits a structured, independently re-checkable artifact.

It is the active companion to `research-integrity` (M2 existence / M3 measurement) and the
active replacement for the static `folklore_risk_score` presence-heuristic.

## When to use

Run a grounding pass before any of:

- Promoting an idea card / folding claims into `research_contract.md` or `research_plan.md`.
- Requesting `autoresearch final-conclusions` (A5) on a run.
- Handing a claim set to `research-writer` / `referee-review`.

You may ground a subset early (e.g. during a literature pull) and a fuller pass at the
boundary. The boundary pass is the one that matters.

## Scope — which claims

Ground claims whose support rests on a citation:

- `support_type` ∈ {`literature`, `data`, `expert_consensus`} **with** `evidence_uris` → in scope.
- `calculation` → not here; numerical reproduction is the `research-harness` / numerical-grounding path.
- `llm_inference`, `assumption` → not a citation; these need their `verification_plan` executed, not a source fetched.

## Procedure (per in-scope claim)

1. **Route by domain.** HEP sources (`inspirehep.net`, `hep-ph/ex/th/lat`, INSPIRE recids)
   resolve through INSPIRE; everything else through arXiv/OpenAlex. (The shared helper
   `classifyEvidenceDomain(uri)` gives the same hint; override per-claim when you know better.)
2. **Confirm existence.** Resolve each `evidence_uri`. If a source cannot be resolved, the
   verdict for that claim is `source_unavailable` — stop, do not guess.
3. **Fetch the relevant source content** (not just the abstract when the claim is specific):

   | Domain | Fetch the cited source with |
   | --- | --- |
   | HEP | `inspire_paper_source` / `arxiv_paper_source` (+ `pdf_parse` for PDF-only); `pdg_get_measurements` / `hepdata_get_table` when the claim cites a measurement |
   | general | `openalex_content` / `arxiv_paper_source` (+ `pdf_parse` for PDF-only) |

4. **Judge support against the fetched text.** Locate the passage (section / equation /
   table / figure) that bears on the claim and decide whether it substantiates the claim.
5. **Record a verdict** from: `substantiated`, `partial`, `not_substantiated`, `conflicting`,
   `source_unavailable`.

## The non-negotiable rule: quote the span

**A `substantiated` or `partial` verdict MUST carry at least one verbatim span quoted from
the fetched source** (with a locator — section/equation/table/figure/page). If you cannot
quote the source text that grounds the claim, the claim is **not** grounded: record
`not_substantiated`.

This is enforced mechanically. `assembleClaimGroundingReport` (in `@autoresearch/shared`,
`packages/shared/src/claim-grounding.ts`) **downgrades any span-less substantiated/partial
verdict to `not_substantiated`**, and the report parser rejects it otherwise. So a verdict
of "substantiated" with no quote is impossible to ship — by design. Quote the line, the
equation, or the exact value+uncertainty; do not paraphrase a vibe.

## Output — `claim_grounding_report_v1`

Emit one `claim_grounding_report_v1.json` for the claim set, conforming to the
`ClaimGroundingReportV1` contract in `@autoresearch/shared`
(`packages/shared/src/claim-grounding.ts` — the single source of truth for the shape).
One entry per claim:

```json
{
  "version": 1,
  "generated_at": "<ISO-8601 UTC>",
  "source_ref": "<where the claims came from>",
  "claims": [
    {
      "claim_index": 0,
      "claim_text": "...",
      "support_type": "literature",
      "evidence_uris": ["https://inspirehep.net/literature/123"],
      "domain": "hep",
      "method": "text_entailment",
      "verdict": "substantiated",
      "supporting_spans": [
        { "evidence_uri": "https://inspirehep.net/literature/123", "quote": "We measure BR = (1.2 ± 0.1)e-3.", "locator": "Table 3" }
      ],
      "notes": "value and uncertainty match the cited table"
    }
  ],
  "summary": { "total": 1, "by_verdict": { "...": 0 }, "grounding_risk_score": 0.0 }
}
```

- **Do not set `verification_status` yourself.** It is derived from the verdict by the
  contract (`substantiated`→`verified`, `conflicting`→`falsified`, everything else→`unverified`).
  A failed-to-support citation is `unverified`, not `falsified` — only an active source
  contradiction (`conflicting`) falsifies a claim.
- `grounding_risk_score` (0..1, higher = riskier) is computed from the verdicts; surface it
  next to the boundary-crossing action.

## Writing back into the claims

`verification_status` and `verification_notes` are schema-allowed idea-card claim fields.
The pure helper `applyGroundingToClaims(claims, report)` returns an updated claims array with
those two fields set from the report (matched by `claim_index`), leaving every other field
untouched. **Default to writing a grounded copy** (e.g. `*_grounded.json`); only overwrite the
original idea-card when the owner asks — staged handoff artifacts are otherwise treated as
immutable.

## HEP numeric claims

For a measurement claim, the v1 check is still text-level: fetch the cited table/figure and
quote the exact value + uncertainty as the span (`method: "text_entailment"`). Exact
structured value matching against PDG/HEPData (`method: "numeric_match"`) is the planned
fast-follow; until then, the quoted value IS the grounding.

## What this skill is NOT

- Not a re-implementation of any provider tool. The tool names above point at existing
  `inspire_*` / `openalex_*` / `arxiv_*` / `pdg_*` / `hepdata_*` / `pdf_*` capabilities;
  this skill decides which to call per claim and turns their output into a grounded verdict.
- Not a replacement for the A5 / final-conclusions gate or for `research-integrity`. It makes
  M2/M3 active and produces the artifact those disciplines otherwise record by hand.
- Not a way to mark a claim grounded without a source quote — see the span rule.
