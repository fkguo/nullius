---
name: referee-review
description: Generate a clean-room, offline (no network) referee-review report with Markdown + strict JSON output (generic profile).
---

# Referee Review (generic, offline)

This skill defines a **generic** (non-venue-specific) peer-review output contract that is designed to be ingested by an orchestrator as artifacts.

## Output contract (must)

- `review.md`: first line must be exactly `VERDICT: READY|NOT_READY`
- `review.json`: must validate against `schemas/review.schema.json` (fail-fast)

## Author pre-flight (run before submitting a packet here)

The author agent should walk the M1-M7 pre-approval ritual from
`skills/research-integrity/` *before* posting a draft to this reviewer.
Findings the author could have caught (hallucinated citation, hallucinated
measurement, methodology-not-in-artifacts, frame-lock, etc.) should not be
the reviewer's BLOCKING items; this reviewer is for adjudication against
the packet, not for catching omissions the author skipped.

**Recording the pre-flight depends on whether a gate is open.** When an
A1-A5 approval gate is open for this work, run `autoresearch integrity-record`
against that gate's `approval_id`; the receipt is then the canonical
machine record of the pre-flight and is fail-closed-enforced by
`autoresearch approve`. When no gate is open (an ad-hoc draft submission),
the M1-M7 walk should still happen, but recording it via
`autoresearch integrity-record` is **advisory only**:
`scripts/run_referee_review.py` does not read
`.autoresearch/integrity_log.jsonl`, so the receipt for an ad-hoc draft is
an audit trail for the next agent, not a gate this reviewer enforces.

This reviewer remains generic and non-venue-specific; the pre-flight is
the author-side discipline, not a venue requirement.

## No-network / role separation

- Reviewer must not fetch new evidence (no INSPIRE/arXiv/DOI/GitHub/web).
- If additional evidence is needed, populate `evidence_requests` with structured queries (to be executed by an external stage), and keep `verdict=NOT_READY` when blocking.

## CLI (deterministic, offline)

```bash
python3 scripts/run_referee_review.py --profile generic --packet fixtures/packet.md --out-dir /tmp/review_out
```

This writes:
- `/tmp/review_out/review.md`
- `/tmp/review_out/review.json`

## Packet format (minimal)

The packet is a Markdown file. Recommended sections:
- `## Paper diff`
- `## References` (short bibliography or notes)
- `## Artifact pointers` (one per line, e.g. `- hep://...`)
