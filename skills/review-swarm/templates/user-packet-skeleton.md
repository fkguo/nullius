# User-packet skeleton (review packet layout)

This is the packet shape `scripts/bin/review_one.py` assembles automatically.
Use it as the starting point when hand-writing a packet for a multi-reviewer
`run_multi_task.py` run: reviewers may have no file access, so the packet must
EMBED everything they are expected to judge — never reference paths and hope.

```markdown
single-family review — advisory; final verdicts require cross-family review

=== REVIEW TASK ===

<one short paragraph: what the artifact is, what decision this review feeds,
and what "ready" means for it. State scope limits explicitly.>

SOURCE_TEXT_ORIGIN: <direct-original-text or visually-verified-transcription>

=== SOURCE PROVENANCE EVIDENCE: <path or title> ===

<for a visual transcription: original document/page/crop locators and hashes,
the visual comparison, and whether verifier and transcriber were distinct>

=== END SOURCE PROVENANCE EVIDENCE ===

=== PRIMARY SOURCE: <path or title> ===

<exact persisted primary-source text plus file hash>

=== END PRIMARY SOURCE ===

=== CORRECTION SOURCE: <path or title> ===

<exact persisted correction text plus file hash, when applicable>

=== END CORRECTION SOURCE ===

=== CORRECTION SEARCH EVIDENCE: <path or title> ===

<indexes/identifiers searched and the recorded result>

=== END CORRECTION SEARCH EVIDENCE ===

=== NEUTRAL EXTRACTION REQUEST: <path or title> ===

<neutral locators/questions; use only for source-extraction packets>

=== END NEUTRAL EXTRACTION REQUEST ===

=== ARTIFACT UNDER REVIEW: <path or title> ===

<full artifact text, embedded verbatim — repeat this block per artifact>

=== END ARTIFACT UNDER REVIEW ===

=== DIFF (<base>..<head>) — output of `git diff <base>..<head>` ===

<full diff text, embedded verbatim — use instead of, or alongside, artifacts
when the review target is a change>

=== END DIFF ===

=== ADDITIONAL CONTEXT: <path or title> ===

<optional acceptance criteria or prior review findings being re-checked>

=== END CONTEXT ===
```

Notes:

- Keep the first advisory line ONLY for single-reviewer packets; a cross-family
  multi-reviewer packet drops it.
- For a source-fidelity review, keep primary sources, correction sources,
  source-provenance evidence, correction-search evidence, candidate artifacts,
  and additional context in separately labeled sections. Do not put the primary
  source or its provenance record in generic context.
- For a candidate-withheld source extraction, omit artifact/diff/context blocks
  and include only sources, correction/search records, and a neutral extraction
  request. Prefer `review_one.py --role source-extraction`, which enforces that
  packet shape.
- Mind prompt size: pass `--max-prompt-bytes`/`--max-prompt-chars` so an
  oversized packet is refused instead of silently degrading reviewer quality.
