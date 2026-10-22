# Independent Reproduction Check (Opt-in)

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

## Independent Reproduction Check (Opt-in)

A result that only reproduces inside the working directory that produced it — uncommitted edits, leftover artifacts, stale caches — is not reproducible yet; the 2026 reproduction evaluations (PaperBench, NatureBench, ReplicationBench) all made *fresh-state reruns* the hard criterion. This protocol is that rerun, run locally and **opt-in: it changes no default workflow and wires no mandatory gate**. Adopt it per project when a headline number is worth a clean-state rerun — before an approval gate, a handoff, or an export is a natural moment.

The project declares a reproduction manifest (JSON, domain-neutral), recommended at `artifacts/runs/<run_id>/reproduction_manifest.json` and committed like any other run evidence. Worktree mode enforces this: an untracked manifest, or one carrying uncommitted edits, fails the check — the claim under test (entry command, expected values, tolerances) must itself be part of the committed state.

```json
{
  "manifest_version": 1,
  "entry_command": "python3 scripts/reproduce_headline.py",
  "working_inputs": ["scripts", "data/inputs.csv"],
  "timeout_seconds": 900,
  "environment_note": "python3 + packages from the committed lockfile; no network",
  "expected": [
    {"id": "fit_quality", "artifact_path": "out/result.json", "json_path": "fit.quality",
     "value": 1.23, "tolerance": {"kind": "absolute", "value": 0.01}},
    {"id": "lowest_eigenvalue", "stdout_pattern": "lowest eigenvalue = ([-+0-9.eE]+)",
     "value": -2.502, "tolerance": {"kind": "relative", "value": 1e-4}, "unit_note": "model units"}
  ]
}
```

- `entry_command` runs via the shell from the isolated project root; everything it needs must be committed (or listed in `working_inputs` for the copy fallback).
- Each `expected` entry declares exactly one deterministic extraction mechanism — a produced JSON artifact (`artifact_path` plus dotted `json_path`; digit segments index lists) or a `stdout_pattern` regex with exactly one capture group (last match wins) — a declared value, and an **explicit** `tolerance` (`absolute` or `relative`; relative requires a nonzero declared value). There is no default tolerance and no order-of-magnitude pass.
- `working_inputs` is a whitelist of project-root-relative paths, used only by the copy fallback.

Run the bundled checker:

```bash
python3 scripts/independent_reproduction_check.py \
    --manifest artifacts/runs/<run_id>/reproduction_manifest.json
```

Read [`references/reproduction-check.md`](reproduction-check.md) when interpreting a reproduction verdict or the isolation, environment-scrub and limits behaviour (the fail-closed semantics bullets, moved there verbatim).

This is the execution arm of the [`numerical-reliability-gate`](../../numerical-reliability-gate/SKILL.md) reproduction discipline: its G8 demands that a claimed match to a reference number be *computed, not asserted* — the fresh-checkout rerun is that computation in its strongest form — and its G7 production-setting rule applies to the manifest itself: declare the entry and configuration that produce the recorded values at their production setting, not a cheaper stand-in.
