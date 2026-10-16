# Research integrity: extraction and transcription fidelity

## Extraction / transcription fidelity (gate it; not a gate-exempt "reading task")

A **source-extraction / transcription note** — a deep-read / knowledge-base note
that transcribes equations, numeric values, source locators (line / section /
equation / table / figure / page pointers), and term-by-term mappings onto a
consuming artifact (code or data) from a primary source — is a **gateable
artifact**, not a gate-exempt "reading task." Its primary observable is **fidelity
to the source**: every quoted equation, value, locator, and claimed mapping must
match the primary source. Relying on such a note for a central claim, or folding it
into a durable artifact, without gating its fidelity is the failure this guards.

This is **not** a new receipt mode. It is a **cross-cutting fidelity check that
augments M2 and M3**; record it under the modes it touches — typically **M2**
(equation / locator / mapping / inference fidelity) and **M3** (numeric value +
factor fidelity) — so the machine receipt modes stay within `M1`–`M7`, with no new
mode introduced.

**The transcription / extraction failure checklist.** Walk every item against the
source, not against the note:

- **(a) equation misquote** — a sign, coefficient or factor, operator, index or
  subscript, relation operator or interval endpoint, numerator/denominator
  placement, exponent, prime, function argument, or integration limit has drifted
  from the source equation.
- **(b) wrong numeric value** — a transposed digit, the wrong table row / column, or
  the wrong reported uncertainty.
- **(c) wrong / stale locator** — a pointer (line / section / equation / page) that
  does not point to the claimed content.
- **(d) stale / wrong mapping to the consuming artifact** — the note cites a symbol,
  function, file, or type in the consuming code / data that is wrong or no longer
  exists.
- **(e) false "verbatim"** — a quote labeled verbatim when whitespace, markup,
  primes, dummy-variable names, or notation were silently normalized. A
  mathematically harmless rename still belongs in the normalized layer, not the
  literal layer, because it can make a faithful source formula look defective.
- **(f) inference-as-source** — a cross-source or derived inference presented as a
  direct statement of the cited source.
- **(g) silent factor drop** — notation using a reduced / normalized / unit argument
  where the full object is meant, dropping a magnitude or degree factor.
- **(h) correlated-input agreement** — several reviewers agree because they were all
  given the same faulty extraction, prior verdict, expected classification, or proposed
  correction. A search/evidence record that already contains the desired adjudication
  is also answer-bearing input, even when its filename says "evidence." Cross-model
  agreement does not remove this shared-input dependence.
- **(i) bibliographic-relation conflation** — two works with similar authors, year,
  title, or part numbering are treated as the same series, predecessor, erratum, or
  companion without checking the primary paper's own preamble/references and independent
  catalog identities. Correct metadata for each paper does not by itself prove the
  relationship asserted between them.
- **(j) stale pre-correction source** — a formula or claim is transcribed faithfully
  from the main publication but a later erratum, corrigendum, revised version,
  retraction, expression of concern, or explicit author correction is not searched
  or applied. Literal agreement with superseded text is not fidelity to the corrected
  scientific record.
- **(k) context-stripped extraction** — a formula is copied without the neighboring
  domain, boundary-value, branch, sheet, convention, or definition statements needed
  to decide what it means. Reviewers then import a familiar default condition and can
  agree on a derivation of a different analytic object. A source packet is not closed
  merely because it contains every displayed equation named in the question.
- **(l) source-layer contamination** — a manually prepared file presented as primary
  source text already contains the transcriber's abbreviation, dummy-variable rewrite,
  interpretation, inferred integration range, or expected answer. Candidate withholding
  then hides the note but not the answer-bearing source preparation. Record whether the
  bytes are direct original text or a visual transcription; for the latter, require a
  separate page/crop provenance record and an independently documented visual comparison.
  A file hash proves which contaminated bytes were reviewed, not that they match the page.
- **(m) coverage overclaim** — selected load-bearing equations were checked, but the
  note or verdict claims that every formula in a paper or section was verified. An
  exhaustive claim requires a locator inventory of every displayed equation and every
  adjacent formula-like condition in the declared scope, each with an explicit status.
  Unlisted auxiliary formulas, intermediate definitions, and prose inequalities remain
  unchecked even when the central derivation passes.
- **(n) stale review verdict** — a reviewer returned a clean verdict for one set of
  bytes, but the candidate, source, correction record, context, or assembled packet was
  edited afterward and the old verdict was applied to the new version. A filename and a
  prior READY/PASS are not provenance. Bind every accepted verdict to the exact reviewed
  SHA-256 set; any mismatch makes it `STALE` until the complete current artifact or the
  complete delta from the reviewed hash is independently re-reviewed.
- **(o) source-error laundering** — a printed source item appears wrong, but the note
  silently substitutes a mathematically preferred expression and presents it as literal
  source text; or the note faithfully transcribes the source and then treats that fidelity
  as proof that the printed item is scientifically correct. `checked-none-found` means no
  published correction was located, not that the source was certified error-free.

**Minimum disconfirming check.** Run a **line-by-line comparison of the note against
the primary source with "do not trust the note"** — a falsification gate, not a
confirmation read. Separate each checked item into: (1) literal source text, (2)
normalized transcription, (3) symbol dictionary, and (4) derived mapping/inference.
Verify them in that order and localize the first divergent token or mapping step.
Before accepting the literal layer, verify and record the source's correction status.
If a correction exists, compare both the printed item and the correction, identify the
affected items exactly, and carry the corrected form into normalization and derivation.
Before deriving, enumerate the source-side conditions the derivation needs and verify
that their exact neighboring text is present. If a domain, boundary-value prescription,
branch, sheet, convention, or definition is absent, mark the step uncheckable rather
than filling it from a standard but possibly inapplicable convention.

For each literal formula, perform a token-class sweep over signs, coefficients or
factors, operators, indices or subscripts, relation operators or interval endpoints,
numerator/denominator placement, exponents, primes, function arguments, and integration
limits. Compare prose conditions and displayed domains as separate source items. If the
conclusion claims complete-paper or complete-section coverage, require the
formula-and-condition inventory described in failure mode (m); otherwise state that the
pass was selective.

When two independent visual reads disagree, return to the original page pixels. If a
lossless crop still cannot decide the token, record `AMBIGUOUS` rather than choosing by
majority, typographic expectation, algebraic convenience, or the formula's anticipated
meaning. Mathematical consistency may motivate a separate derived interpretation, but
it cannot upgrade an unresolved literal glyph.

When a printed item is suspected to be wrong without a published correction, maintain two
explicit tracks. The literal track records `PRINTED_FORM` and its source-fidelity verdict.
The scientific track records `SCIENTIFIC_STATUS`, any `PROPOSED_CORRECTION`, the independent
evidence and counterchecks, and the downstream policy. Never overwrite the literal track.
Before using a proposed correction, run at least two blind independent derivations from
the definitions, conventions, domain, and neighboring premises while withholding both the
printed disputed expression and the proposed replacement. Compare those outputs with the
printed and proposed forms only afterward. Audit premise provenance and exclude every later
equation, summary, numerical target, or constraint that depends on the disputed item; using
its downstream consequence as an input is circular confirmation. Agreement can justify
`independently_supported_correction`; it cannot justify `published_correction` or
`author_confirmed_correction` without those distinct records. If the correction is not
unique or the premises are insufficient, retain `unresolved_source_error` and block silent
downstream choice. For an empirical or reported numerical item that cannot be derived,
replace the derivation lanes by independent reproduction from the underlying data,
calculation, or measurement. A later source that simply repeats the printed item does not
count as an independent reproduction. For a non-derivable convention, label, or prose
statement, seek independent primary records, internal definitional closure, subsequent
author clarification, or direct author confirmation. If those records do not decide the
issue uniquely, retain `unresolved_source_error`; repetition or citation count is not a
vote on correctness.

When the note will carry a central claim — a claim downstream conclusions rest on —
obtain at least one **candidate-withheld extraction**: a fresh reader receives the persisted
source plus only a neutral locator/question list, not the candidate note, prior verdict,
or proposed answer. (A note without a central claim needs only the candidate-visible
literal comparison; the two-pass machinery is for load-bearing transcriptions.) A note
whose claim later becomes one a conclusion rests on owes the candidate-withheld
extraction at that promotion moment, before the conclusion is folded — centrality is
re-judged when the note's role changes, not only when the note is written. Use the `review-swarm` `source-extraction` role so candidate artifacts,
diffs, and additional context are rejected by packet construction; separately inspect the
request for answer anchoring because neutrality is not machine-decidable. Then run the
candidate-visible literal comparison. Record method diversity, model-family diversity, execution independence and candidate/prior-verdict visibility separately. Same-family independent construction may count; family diversity alone does not establish input/framing independence.

Run the comparison through the gate harness (`review-swarm`'s source-fidelity reviewer),
**re-reviewing after every fix** because a correction can introduce a fresh defect. The
confirmation round may review the exact delta from the previously reviewed hashes (the
option the freshness discipline below already grants) when the fix is localized; escalate
to the full artifact when the fix reaches surface the panel never reviewed. In
feedback rounds, provide the suspected discrepancy and source locator as a hypothesis;
do not supply the desired corrected expression as a premise. Declare convergence only
when the source-localized checks agree — never by majority vote or self-pronouncement.
(`derivation-verify` re-derives whether a re-derivable result is mathematically
correct — a *separate* axis that does not check fidelity to the source; use it in
addition to, never instead of, the literal comparison.)

Immediately before folding a verdict into a durable conclusion, recompute the hashes of
the target and every answer-bearing review input. For `review_one.py` runs, execute
`<nullius-root>/skills/review-swarm/scripts/bin/verify_review_freshness.py` with
`--review-dir <out-dir>` and require `status: FRESH`; the `review_one.py` entry also
performs this check when its reviewer returns. Direct `run_multi_task.py` runs do not
acquire this manifest merely by using `review-swarm`; they need an equivalent externally
recorded hash check before closeout.
`STALE`, missing, unreadable, or invalid inputs are fail-closed states. Preserve the
historical model verdict, but do not count it toward current convergence. Any edit after
the final freshness check invalidates that check and requires another exact-delta or
full-artifact review.

For PDF or scanned primary sources, include a direct visual comparison with the
rendered source page or a lossless page crop. OCR and `pdftotext` are discovery
aids, not formula-fidelity evidence. A text-only reviewer may certify note-to-excerpt
agreement only after a PDF/image-capable reader has certified excerpt-to-page
agreement and recorded the original-page and crop hashes.

For a publication correction-chain claim, persist the indexes/identifiers searched and
their result. The source-review entry must reject `checked-none-found` or
`checked-corrections-included` unless `--correction-search-evidence` is supplied; a bare
status flag is not evidence that the publication record was checked.

**Tools that help.** `claim-grounding` is the active execution of this check for the
quote / value / locator items — it fetches the cited source and records a span-backed
verdict, downgrading any "substantiated" verdict that carries no verbatim source span.
`deep-literature-review` is the producer discipline that fills the note from the
source and runs this gate before handoff; persist the fetched primary source to a
stable, auditable location so the reviewer reads exactly the bytes that were
transcribed. `review-swarm` is the cross-family literal-comparison harness.
