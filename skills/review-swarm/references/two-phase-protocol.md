# Review swarm: two-phase review protocol

## Two-phase review protocol (opt-in)

Default reviews are single-phase: each reviewer sees the full packet (diff included) in one
call. `--two-phase` adds an opt-in commit-then-review protocol for formal reviews where two
documented multi-agent failure modes matter: a reviewer improvising its evaluation standard
only after seeing the diff, and persuasive phase-2 prose substituting for the standard it
would have committed to up front. **Single-phase behavior is completely unchanged when the
flag is absent.**

When to use: formal review of high-risk or irreversible public-surface changes —
cross-package contract changes, default-entry behavior, anything where the project already
requires independent formal review. Routine incremental diffs do not need it.

How it works:

1. **Phase 1 — criteria commitment.** Each reviewer receives a scope packet only — change
   title, intent, and the changed-file list, with the diff deliberately withheld
   (`--scope-prompt` file, prepared by the caller). The reviewer must declare the review
   criteria it commits to: exactly one block wrapped in `<review_criteria>` /
   `</review_criteria>` sentinel lines, containing a JSON object with a non-empty
   `categories` array (each entry: a `name` plus a one-sentence `blocking_criteria`) and a
   `severity_scale` sentence. The `severity_scale` sentence binds the reviewer's categories
   to the canonical BLOCKING/HIGH/LOW ladder defined in the gate-loop discipline section —
   it maps categories onto that shared scale, it does not invent a private one.
2. **Phase 2 — review per committed criteria.** The same reviewer is called again with the
   full diff packet (the normal `--prompt` / per-backend override) plus its own phase-1
   criteria block, verbatim. Every BLOCKING finding must carry a declared category:
   a `[<category>]` bullet prefix under `## Blockers` in Markdown output, or a `category`
   field / `[<category>]` string prefix on `blocking_issues` entries in JSON output.
3. **Criteria revision.** If the diff reveals a problem class outside the declared
   categories, the reviewer may add a category only with an explicit revision declaration:
   a `CRITERIA_REVISION: <category>: <one-line reason>` line in Markdown output, or a
   `criteria_revisions` array entry (`category` + `reason`) in JSON output. The machine
   check verifies the declaration exists and is well-formed; judging whether the reason is
   any good stays with the synthesis agent.

Conformance is machine-checked after phase 2 (same code path as
`check_review_output_contract.py --two-phase PHASE1_FILE PHASE2_FILE`): a BLOCKING finding
whose category is neither declared nor covered by a revision declaration is a conformance
failure. **Conformance failures are purely informational** — recorded per agent in
`meta.json` under `two_phase` (`conformance_ok`, `conformance_errors`), never a fallback
trigger, and (deliberately, unlike single-phase contract failures) never withheld from
convergence/credit aggregation: judging whether a criteria revision was legitimate is the
synthesis agent's job, not a mechanical exclusion. Phase-1 failures are different: if the
phase-1 call fails or returns no parseable criteria block, phase 2 is skipped and the agent
is marked failed (`phase1_command_failed`, `phase1_empty_output`, or
`phase1_criteria_invalid`); rerun that reviewer same-model. A phase-1 empty output is
classified as an infrastructure failure but is NOT auto-retried by `--retry-empty-output`,
and two-phase rejects fallback — recovery is that manual same-model rerun.

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/formal_review \
  --system /path/to/reviewer_system.md \
  --scope-prompt /path/to/scope_packet.md \
  --prompt /path/to/diff_packet.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --two-phase \
  --check-review-contract
```

Notes:
- The scope packet must not contain the diff; keeping it to the change title, intent, and
  changed-file list is the caller's responsibility.
- `--scope-prompt` is global (no per-backend override); per-backend `--backend-prompt`
  overrides apply to the phase-2 diff packet as usual.
- `--two-phase` rejects `--fallback-mode ask|auto`: silently substituting a different
  backend mid-protocol would break the commitment chain. Use a same-model rerun instead.
- Two-phase is a per-invocation CLI opt-in only; it is deliberately not settable from the
  project config file, so a config can never silently flip a default run into two-phase.
- In Markdown phase-2 output, findings under `## Blockers` must be bullets. Untagged
  indented lines are continuations of the bullet above; an indented bullet that itself
  carries a `[<category>]` tag counts as a finding (nesting is not an evasion channel);
  column-0 prose other than a no-blocker placeholder is flagged as unstructured content.
- Phase transcripts stay auditable: composite prompts live under `{out-dir}/two_phase/`,
  phase-1 outputs sit next to the final outputs with a `.phase1` suffix (both paths are
  cleared of stale files from previous runs at the start of a two-phase run).
