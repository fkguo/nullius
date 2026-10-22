Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### Source-fidelity reviewer (mandatory for transcription / source-extraction artifacts)

A **source-extraction / transcription note** — a deep-read / knowledge-base note that transcribes
equations, numeric values, source locators, and term-by-term mappings onto a consuming artifact from a
primary source — is a **valid gate target**, not a gate-exempt "reading task." Its primary observable is
**fidelity to the source**, so the review is a different shape from a code/design review: at least **one
reviewer must do a LITERAL, line-by-line comparison of the note against the primary source with "do not
trust the note."** Loose semantic agreement is insufficient — transcription drift (a flipped sign, a
dropped magnitude factor, a transposed digit, a stale locator, or a stale mapping to the consuming
artifact) reads as plausible and is caught only by literal comparison. Draw that reviewer from another
model family when the machine has one (preferred: two families rarely share a transcription habit, and a
same-family looser read tends to pass exactly the defects it is meant to catch); when it has only one, the
literal comparison is done by a fresh same-family reader after a candidate-withheld extraction, and the
gate is recorded as single-family — a degraded gate, never relabeled.

Give that reviewer the **persisted primary source** (the exact text that was transcribed), not the note
alone, plus the transcription/extraction failure checklist (`research-integrity` → *Extraction /
transcription fidelity*). Declare whether those bytes are direct original text or a visual transcription;
the latter also requires separate source-provenance evidence. With `review_one.py`, first run
`source-extraction` with repeatable `--source`, an exact `--extraction-request`, explicit
`--source-text-origin`, explicit `--correction-status`, and the required correction-search
evidence. This role rejects candidate artifacts, diffs, and additional context and writes
`inputs/source_extraction_manifest.json`. Then run the candidate-visible `source-fidelity` comparison,
passing the candidate via `--artifact`/`--diff`, the same source separately through repeatable `--source`,
and each applicable correction through repeatable `--correction-source`. The launcher writes
`inputs/source_fidelity_manifest.json` with primary/correction/search-evidence and target hashes, diff range
when applicable, ordered additional-context paths and hashes, correction status, and candidate visibility. Context content is
explicitly marked as not machine-classified because the launcher cannot know whether it contains a prior
verdict or proposed answer. Both roles fail closed before model launch if required source, correction,
or correction-search evidence is absent or invalid. Both manifests mark source dependency closure as
`not_machine_verified`, and the extraction manifest marks request neutrality `not_machine_verified` (the
fidelity manifest records it as `not_applicable`, since that pass carries no neutral request); the reviewer,
not the packet assembler, must decide whether the question leaks an answer and whether all required
domain/branch/convention premises are present.
The extraction input manifest certifies only that a candidate-withheld packet was constructed; it does not
claim the extraction was completed. Completion belongs to the reviewer output and `meta.json` verdict.

The source set must include the applicable correction chain. For a load-bearing paper,
record whether an erratum, corrigendum, expression of concern, retraction, revised
version, or later explicit author correction was searched and found. If a correction
supersedes a formula or statement, give the reviewer both the printed source and the
correction, and require the artifact to distinguish the pre-correction and corrected
forms. A literal match to the original but superseded text is not a fidelity pass.

The reverse case needs equal care: a search that found no erratum does not certify the
printed source as scientifically correct. If an equation or statement appears internally
inconsistent, preserve the exact printed form and open a separate suspected-source-error
record. Keep `PRINTED_FORM`/`SOURCE_FIDELITY_STATUS` distinct from
`SCIENTIFIC_STATUS`/`PROPOSED_CORRECTION`/`EVIDENCE_AND_COUNTERCHECKS`/
`DOWNSTREAM_POLICY`. Source-fidelity checks the first track only. For a re-derivable item,
the second track needs candidate-withheld independent re-derivation through
`derivation-verify`, with every premise checked to exclude downstream consequences of the
disputed item. For an empirical or reported numerical item, it needs independent
reproduction from the underlying data, calculation, or measurement; downstream sources
that merely repeat the claim are not independent. For a non-derivable convention, label,
or prose statement, require independent primary records, internal definitional closure,
or author clarification; repetition and citation count are not votes. Agreement with a
conjectured repair does not turn it into source text, a published correction, or an
author-confirmed correction. If the repair is not unique, retain
`unresolved_source_error` and block silent downstream selection.

The manifest distinguishes each original file's SHA-256 from the SHA-256 of the UTF-8 text embedded in the
packet. Primary-source text is strict UTF-8 and is inserted without trimming, so those two hashes agree;
artifact/context decoding may use replacement characters and therefore records both hashes explicitly.
Diff targets likewise record raw and embedded-text hash fields for schema symmetry; because `git diff`
is decoded and embedded as the same UTF-8 text, those two values currently agree.
Each entry also records whether one delimiter newline was added after a payload that lacked a terminal
newline; that delimiter is packet framing and is not part of the embedded-text hash.

Keep four layers separate in both the packet and the verdict: **literal source**, **normalized
transcription**, **symbol dictionary**, and **derived mapping/inference**. A correct derivation from a
wrongly transcribed formula does not certify the transcription. Require the reviewer to localize the first
divergent source token or mapping step rather than only compare final formulas.

Conflicting visual transcriptions do not become source truth by vote. Reinspect the original page or a
lossless crop; if the surviving pixels still do not distinguish the disputed glyph, keep the inventory item
`AMBIGUOUS` and require the candidate artifact to preserve that uncertainty. Do not collapse it to the
mathematically expected sign, exponent, relation operator, or endpoint convention.

An exhaustive source-fidelity claim needs an exhaustive comparison surface. If the verdict says that all
formulas in a paper or section were checked, persist a locator inventory of every displayed equation and
every adjacent formula-like condition in that scope, with an item-level status. A selected-item pass cannot
be promoted to complete coverage. In either scope, explicitly sweep signs, coefficients or factors,
operators, indices or subscripts, relation operators or interval endpoints, numerator/denominator
placement, exponents, primes, function arguments, and integration limits; algebraic or dimensional
consistency is a separate check.

Model-family independence, method independence, and input/framing independence are different axes. A
cross-family reviewer that sees the same faulty note, prior verdict, or proposed correction is not an
input-independent extraction. For a load-bearing source item, first obtain at least one
**candidate-withheld extraction** with the `source-extraction` role; only then show the candidate note for
the literal `source-fidelity` comparison. The extraction manifest records
`candidate_visibility=withheld_by_packet_structure`, while also stating that request neutrality is not
machine-verified. Feedback iterations state a discrepancy and source locator as a hypothesis; they must
not feed the desired corrected formula back as an assumption.

Record whether a literal cross-family source comparison was performed; a swarm that only read the note,
stayed within one model family, or shared one candidate-anchored input without a candidate-withheld pass is
**not** a full fidelity pass and must be labeled as such.

For PDF or scanned sources, a text-only packet cannot establish source fidelity by itself. The gate also
requires a PDF/image-capable reader to compare the original rendered page (or a lossless page crop) with
the persisted excerpt. Record both the original file/page hash and crop hash. OCR or `pdftotext` output is
a discovery aid only; agreement between the note and OCR cannot certify a formula that OCR misread.
