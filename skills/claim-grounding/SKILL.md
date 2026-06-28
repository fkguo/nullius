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

For literature-graph artifacts, treat the following as claim-like objects when they carry
interpretive content:

- edge explanations, such as "paper A extends method B" or "result X contrasts with result Y";
- figure-candidate relevance statements, such as "this extracted figure shows the effect summarized in the note";
- connected-literature sidebar summaries that assert lineage, contrast, application, or source support.

The grounding target is the statement behind the graph element, not the visual element itself.
If the edge or figure has no source locator or evidence URI, record it as ungrounded rather
than inferring support from graph proximity.

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

For graph figure candidates, do not use a title page, abstract, or filename as evidence that
the image is relevant. The supporting span must identify the actual result, table, figure,
equation, or discussion that the rendered asset is meant to carry.

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

## Match claims: "reproduces / matches a published value" is grounded by computing, not quoting

A claim whose assertion is that **[a result] reproduces / matches / agrees with [a published
numeric value]** is a special case the span rule does **not** discharge. Quoting the published
number from its source confirms only that the *source* carries that value — it does **not**
establish that *your* result matches it. A match claim is grounded **only by computing the
claimed observable on a comparable state / regime / configuration and comparing it to the
published value numerically**; this routes to the numerical-reproduction path
(`numerical-reliability-gate` **G8**, the active compute-and-compare gate), not to a
text-entailment span. So:

- A "reproduces / matches a published value" claim whose *only* support is a span quoting the
  published number is **`not_substantiated`** — the quote grounds the source's value, not the
  agreement. A purely qualitative "same order of magnitude / same sign / right scale" claim with
  no computed comparison is likewise ungrounded.
- When the comparison **is** computed: a value agreeing within the stated tolerance on the
  comparable regime is `substantiated`; an **order-of-magnitude same-direction discrepancy, or a
  sign reversal**, is `conflicting` (the computed result actively contradicts the asserted match),
  not `substantiated`. A value that disagrees **beyond the stated tolerance but short of an
  order-of-magnitude or sign gap** is `partial` (the form agrees but the number is outside
  tolerance) — or `not_substantiated` if the claim asserted a strict match. Record the computed
  value, the comparable regime, the acceptance tolerance, and the ratio / signed difference in
  `notes`.

This is the citation-side companion of the `Scope` rule above (a bare `calculation` claim is the
`research-harness` / numerical path): a match claim wears citation clothing — it carries
`evidence_uris` to the published source — yet its support is a **computation**, so quoting the
source is necessary context but never sufficient grounding.

## Transcription fidelity (when the claim was transcribed into a note)

When the claim you are grounding was itself **transcribed into a deep-read / extraction note**
— it carries a quoted equation, a numeric value + uncertainty, or a source locator copied from
the cited source — grounding has a second dimension beyond "does the source support the claim":
**does the note's quoted span / value / locator match the fetched source span?** A claim can be
*true* yet mis-transcribed (a flipped sign, a transposed digit, a dropped magnitude factor, a
stale locator, or a quote labeled "verbatim" after silent normalization). Compare the note's
quote/value/locator against the span you fetched in step 3:

- If the fetched span does **not** match what the note transcribed, the verdict is
  `not_substantiated` (the source does not ground the note as written), or `conflicting` if the
  source actively contradicts it — record the **fetched** span verbatim in `supporting_spans`
  so the drift is auditable, and name the mismatch in `notes`.
- A `substantiated` / `partial` verdict therefore certifies *both* that the source supports the
  claim *and* that the note transcribed it faithfully — the quoted span is the same object for
  both checks.

This is the active execution of the `research-integrity` *Extraction / transcription fidelity*
checklist (items (a)–(g)); `deep-literature-review` produces the notes this dimension grounds.

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
