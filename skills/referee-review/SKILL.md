---
name: referee-review
description: Generate a clean-room, offline (no network) referee-review report with Markdown + strict JSON output (generic profile).
---

# Referee Review (generic, offline)

This skill defines a **generic** (non-venue-specific) peer-review output contract that is designed to be ingested by an orchestrator as artifacts.

## Output contract (must)

- `review.md`: first line must be exactly `VERDICT: READY|NOT_READY`
- `review.json`: must validate against `schemas/review.schema.json` (fail-fast)

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
