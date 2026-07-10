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

=== ARTIFACT: <path or title> ===

<full artifact text, embedded verbatim — repeat this block per artifact>

=== END ARTIFACT ===

=== DIFF (<base>..<head>) — output of `git diff <base>..<head>` ===

<full diff text, embedded verbatim — use instead of, or alongside, artifacts
when the review target is a change>

=== END DIFF ===

=== ADDITIONAL CONTEXT: <path or title> ===

<optional supporting material: the primary source for a fidelity review, the
acceptance criteria, prior review findings being re-checked>

=== END CONTEXT ===
```

Notes:

- Keep the first advisory line ONLY for single-reviewer packets; a cross-family
  multi-reviewer packet drops it.
- For a source-fidelity review the primary source belongs in the packet (as
  context) — the exact bytes that were transcribed, not a citation to them.
- Mind prompt size: pass `--max-prompt-bytes`/`--max-prompt-chars` so an
  oversized packet is refused instead of silently degrading reviewer quality.
