# Single-reviewer invocation

Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

`scripts/bin/review_one.py` is the one-command way to get a single independent
reviewer with zero hand-written files. It builds the system prompt from a role
template, embeds your artifacts (or a git diff) into an auto-assembled packet,
then delegates to `run_multi_task.py` (same directory), inheriting runner
discovery, per-backend read-only tool modes, the process-group timeout,
`trace.jsonl`/`meta.json` artifacts and contract checking. Its delegated run
also opts in to one orchestrator-level empty-output retry except for the notebook
role, which always uses zero retries (`--retry-empty-output 0`). The launcher
default is `0`; other review_one roles use `1`.

```bash
python3 scripts/bin/review_one.py \
  --model gemini/default \
  --artifact /path/to/extraction_note.md \
  --source /path/to/exact_source_excerpt.tex \
  --source-text-origin direct-original-text \
  --correction-status checked-corrections-included \
  --correction-source /path/to/exact_erratum_excerpt.tex \
  --correction-search-evidence /path/to/correction_search_record.md \
  --role source-fidelity \
  --out-dir /tmp/one_review
```

For the candidate-withheld pass that must precede comparison of a load-bearing
source item, use the separate role. Its packet structure accepts a neutral
request but rejects candidate artifacts, diffs, and additional context:

```bash
python3 scripts/bin/review_one.py \
  --model gemini/default \
  --extraction-request /path/to/neutral_questions.md \
  --source /path/to/visually_transcribed_source.txt \
  --source-text-origin visually-verified-transcription \
  --source-provenance-evidence /path/to/page_crop_check.md \
  --correction-status checked-none-found \
  --correction-search-evidence /path/to/correction_search_record.md \
  --role source-extraction \
  --out-dir /tmp/source_extraction
```

Read [`references/review-one-flags.md`](review-one-flags.md) when choosing or checking a `review_one.py` flag (packet inputs, source-role declarations, candidate-commit binding, confirmation-round deltas, output and budget options) (the `Flags:` list, moved there verbatim).

The assembled packet's first line is a single-reviewer advisory caveat. One route or alias does
not establish a named model family; family and other independence evidence must be checked separately. When the reviewer returns,
the launcher recomputes every manifest hash, writes `post_review_freshness.json`,
records the status in `meta.json`, and prints `acceptance_status` with the model
verdict, `contract_ok`, and the output/packet/meta/trace paths. A successful model
verdict with stale or unverifiable inputs exits with the dedicated status `86`; the
model verdict remains historical evidence, not a verdict on the changed artifact.
This immediate `FRESH` status means only that the inputs did not change while that
review ran. Durable closeout still requires rerunning the standalone checker immediately
before the verdict is folded into a conclusion.

Read [`references/backend-overrides-and-tool-modes.md`](backend-overrides-and-tool-modes.md) when overriding a backend's prompt, system prompt, output, tool mode or deadline, or granting a reviewer tool access (the `Backend overrides` and `Reviewer Tool Modes` sections, moved there verbatim).
