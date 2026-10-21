Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Pre-approval ritual

Walk the modes most relevant to the gate before invoking
`nullius approve <approval_id>`. The check is owed to the next
agent who will read the durable record, not to the current task's
deadline.

| Gate | Scope | Modes that bite most often |
| --- | --- | --- |
| A1 | mass_search (literature pool definition) | M2, M4 |
| A2 | code_changes (implementation diff) | M1, M5 |
| A3 | compute_runs (numerical result acceptance) | M3, M5, M6 |
| A4 | paper_edits (manuscript text) | M2, M3, M4, M7 |
| A5 | final_conclusions (project closeout) | M1–M7; confirm applicable M8 checks were run before computation |

Walk depth scales with the diff's blast radius: an interface-level or
result-bearing diff gets the full listed walk, while a micro-patch inside
an already-walked boundary needs only the affected-mode re-walk described
under "Recovery from a caught failure" — not a fresh full pass per patch.

For A5 specifically, run the full M1–M7 pass, confirm that M8 was run
before every computation to which it applied, and record both checks
inline in the conclusion artifact rather than as a separate file.
If the conclusion is promoted as the main research report, also require the
project's `nullius report-validate` gate to pass. That structural result does
not discharge M1–M7 or the independent scientific sufficiency judgment.

In projects that do not use the engine's approval flow (declared
`execution_mode: file`, or any moment where the go-ahead arrives in
conversation instead of through `nullius approve`), the same ritual
runs at the boundary moments listed under "When to use", and the
human's decision is recorded with
`nullius decision record "<what was decided>" --by <who>` — the
engine-visible counterpart of the approval receipt. Open questions
awaiting the project owner go in
`nullius decision pending "<question>"` and stay counted in every
status receipt (the oldest ten itemized; the rest via
`nullius decision list`) until a later
`nullius decision record "<answer>" --resolves <id>` closes them —
recording an unrelated decision leaves the pending entry open.

## Recording the check

For the *narrative* record — read by the next agent or human — record
the check inline in the response or notebook entry, in the order:

1. Which modes you checked, by `Mx` number.
2. For each checked mode: the specific disconfirming check you ran
   and what it returned. Quote tool calls and their results where the
   check is provider-graph-backed.
3. Modes you explicitly judged not applicable, with a one-sentence
   reason. Structurally inapplicable modes may share **one consolidated
   line** ("M2/M4/M6 not applicable: no citations, no literature claims,
   no methodology narrative in this boundary") — a per-mode paragraph
   restating the obvious informs nobody and taxes every round that
   carries it. The consolidation covers wording only: the judgment that
   a mode is inapplicable is still made per mode, per boundary.

For the *machine* record that gates `nullius approve` (see below),
run `nullius integrity-record` after the narrative is written:

The current v1 machine receipt accepts M1–M7 only. Record M8 in the
narrative at its pre-computation trigger; do not pass M8 to `--modes`
or `--skip` until the receipt schema explicitly supports it.

```bash
nullius integrity-record \
  --approval-id <approval_id> \
  --modes M3,M5,M6 \
  --notes "<terse summary of what was checked and the headline finding>" \
  --skip M1:no\ code\ change,M2:no\ new\ citations
```

`--modes` is the comma-separated list of `Mx` you actually walked.
`--skip` is an optional comma-separated list of `Mx:reason` for modes
you judged not applicable. `--notes` is short prose (max 500 chars) —
durable detail still belongs in the narrative record above; the
receipt is just the boundary-time machine artifact.

The receipt is appended to `.nullius/integrity_log.jsonl` and
checked by `nullius approve <approval_id>` (and the `orch_run_approve`
MCP tool) before granting. Without a matching receipt the approval
fails closed with `INTEGRITY_RECEIPT_REQUIRED`. This is the same
fail-closed pattern as the `HARNESS_INVOCATION_REQUIRED` anchor gate —
the *existence* of the receipt is machine-enforced, the *content* of
your check is your judgment.

Skip semantics for environments that need to bypass the gate (e.g.
historical project replay): `NULLIUS_INTEGRITY_VERIFY=skip`.
`NODE_ENV=test` skips by default to keep existing test suites green.

## Recovery from a caught failure

If a check surfaces a failure, do not cross the boundary. Fix it,
then re-walk the affected modes only. Re-run `nullius
integrity-record` for the same `approval_id` — the latest receipt
wins, the prior entry stays in the JSONL for audit. The fix gets a
brief note in the narrative record so the next reader can see what
was caught and what was changed.

The integrity check is owed to the next agent who will read your
work — including future-you in a new conversation — not to the
current task's deadline.
