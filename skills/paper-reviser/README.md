# paper-reviser (agent skill)

Content-first revision for LaTeX papers: a human-like read-through → line edit →
clean + `latexdiff` + tracked-delivery contract → audit + verification requests.
Delivery is fail-closed — if `latexdiff` is missing or compile verification did not
run, the run records `not_ready` rather than emitting a fake tracked document.

Designed to be driven by a tool-using agent; the commands below are what the agent
runs, and you can run them yourself for reproducibility and debugging.

## Requirements

- `bash`, `python3`
- `latexdiff` + a TeX toolchain — for tracked-change delivery and compile verification
- Writer/auditor model CLIs (e.g. `claude`, `gemini`) only for `--run-models`; the
  smoke path uses `--stub-models` and needs no model access

## Quick start

Resolve the skills directory, then smoke-test with no model calls:

```bash
SKILLS_DIR="${SKILLS_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills" ] && echo "$r/skills" && break; done || true)}"
python3 "$SKILLS_DIR/paper-reviser/scripts/bin/paper_reviser_edit.py" \
  --in /path/to/draft.tex \
  --out-dir /tmp/paper_reviser_out \
  --stub-models
```

A real revision run drives a writer + auditor backend (see `SKILL.md` for the full flag set):

```bash
python3 "$SKILLS_DIR/paper-reviser/scripts/bin/paper_reviser_edit.py" \
  --in /path/to/draft.tex --out-dir /tmp/paper_reviser_out --run-models \
  --writer-backend claude --writer-model opus \
  --auditor-backend gemini --auditor-model <GEMINI_MODEL>
```

Then read `verification_requests.md` and the `audit.md` verdict.

## Docs

- `SKILL.md` — full workflow, full-document vs fragment input modes, the verification
  loop, the tracked-delivery contract, and safety/scope notes.

## Repository layout

- `scripts/bin/paper_reviser_edit.py` — main revision entrypoint
- `scripts/bin/build_verification_plan.py` — verification-plan builder
- `scripts/tests/` — unit tests
- `scripts/dev/run_smoke_tests.sh` — local smoke tests
