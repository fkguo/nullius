# review-swarm (agent skill)

Runs clean-room, multi-backend review loops across Claude / Gemini / Codex /
OpenCode / Kimi with strict review-contract checks, a fallback policy, and
convergence gates. Choose reviewers with evidenced model-family diversity and
separately verify method and input independence. Same-family reviews normally
run natively in-host; the launcher aggregates only the reviewers it executes
(see the host-aware execution notes in `SKILL.md`).

Designed to be driven by a tool-using agent; the commands below are what the agent
runs, and you can run them yourself for reproducibility and debugging.

## Requirements

- `python3` — the launcher; Claude and Kimi process supervision requires Python 3.10 or newer
- Runner skills for whichever backends you use, with their CLIs on `PATH`:
  - `claude-cli-runner` (for `claude/...` models)
  - `gemini-cli-runner` (for `gemini/...` models)
  - `codex-cli-runner` (for `codex/...` models)
  - `kimi-cli-runner` (for `kimi/...` models)
  - `opencode-cli-runner` (for the OpenCode backend)

## Quick start

Single reviewer, one command — no hand-written prompt files. Its verdict is
advisory, and its model family remains unknown until supported by identity
evidence. Cross-family review is preferred, not required: a result-bearing /
public-surface / irreversible artifact wants a second seat, from another
model family when the machine has one, otherwise same-family — a
candidate-withheld route (source-extraction, derivation-verify, independent
reproduction) where the claim admits one, else a fresh reader without the
first seat's report, any prior verdict or the author's framing beyond the
artifact, its input axis recorded as candidate-visible — with the round
recorded as single-family, a degraded round, never relabeled (scoping in
SKILL.md; internal implementation variants close single-family either way):

```bash
python3 scripts/bin/review_one.py \
  --model codex/default \
  --artifact /path/to/notes.md \
  --role correctness
```

For source-fidelity work, supply the primary source and explicitly declare the
correction-chain status. If a correction exists, include its exact text as a
separate input:

```bash
python3 scripts/bin/review_one.py \
  --model codex/default \
  --artifact /path/to/extraction_note.md \
  --source /path/to/primary_source.tex \
  --source-text-origin direct-original-text \
  --correction-status checked-corrections-included \
  --correction-source /path/to/erratum.tex \
  --correction-search-evidence /path/to/correction_search_record.md \
  --role source-fidelity
```

Before that candidate-visible comparison, create a structurally
candidate-withheld extraction:

```bash
python3 scripts/bin/review_one.py \
  --model codex/default \
  --extraction-request /path/to/neutral_questions.md \
  --source /path/to/visually_transcribed_source.txt \
  --source-text-origin visually-verified-transcription \
  --source-provenance-evidence /path/to/page_crop_check.md \
  --correction-status checked-none-found \
  --correction-search-evidence /path/to/correction_search_record.md \
  --role source-extraction
```

`source-extraction` rejects candidate artifacts, diffs, and additional context.
The reviewer must still reject a request that itself leaks an expected answer.
Both source roles also require `--source-text-origin`. A visual transcription of
a PDF or scan requires a separate `--source-provenance-evidence` record; its
presence and hash are enforced, while its scientific accuracy remains a reviewer
responsibility.

Review with contract checking — choose the intended reviewer models explicitly
and provide an agents file with exact model mappings when family attribution is
required. These route examples alone cannot establish cross-family quorum:

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/cross_family_review \
  --system /path/to/reviewer_system.md \
  --prompt /path/to/packet.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --agents-file /path/to/agents.json \
  --check-review-contract
```

Per-reviewer outputs, the convergence check, and contract status land under `--out-dir`.

There is no implicit hard review deadline. `--expected-secs` is a soft estimate;
`--timeout-secs` retains its explicit hard-cap meaning across phases/retries/fallback.
`--claude-live-capture` enables durable Claude events and partial text. Inactivity
termination is opt-in, requires observable advancing content plus a further grace
check, and cannot be inferred from silent buffered output. Partial text never supplies
a completed review seat.

Model route, requested/resolved arguments and reported identity are separate.
Unmatched family evidence stays unknown. Completed contract-valid eligible families
supply quorum; roster availability does not. Method and input independence require
separate evidence even when model-family evidence is present.

## Docs

- `SKILL.md` — canonical entrypoint, host-aware execution, the single-reviewer
  entry, backend/model selection, fallback + convergence gates, and the opt-in
  two-phase review protocol.

## Repository layout

- `scripts/bin/run_multi_task.py` — canonical multi-reviewer entrypoint
- `scripts/bin/review_one.py` — one-command single-reviewer entry (advisory)
- `templates/` — reviewer role system prompts + the user-packet skeleton
- `scripts/bin/review_contract.py`, `scripts/bin/check_review_output_contract.py` — review-contract checks
- `scripts/bin/smoke_run_multi_task_real.py` — real-backend smoke runner
- `tests/` — runner and contract tests
