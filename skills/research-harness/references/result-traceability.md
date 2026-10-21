# Result Traceability: Which Runs Still Count, From Which Code

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

## Result Traceability: Which Runs Still Count, From Which Code

The acceptance question this surface answers, as prose from one command
(`nullius current`): what the current best result is, which exact code
revision produced it, where the current manuscript is, which notebook
sections are current versus stale, and which runs are still valid versus
superseded or voided — with honestly-unanswerable clauses where the record
cannot support an answer. The version object is the git commit; runs bind to
commits via origin stamps; validity lives in an append-only ledger; result
selection lives in the results registry in `project_index.md`.

Daily discipline (each covered in its own section or in `research-team`):
stamp runs at creation, supersede or void on the ledger when a result is
replaced or found wrong, register headline results at milestone convergence,
stamp rewritten memo sections.

**Adopting this in an existing project** (one that already has runs but no
stamps) is explicit — templates and launchers do not migrate anything by
themselves:

1. `nullius init --runtime-only` from the project root refreshes the
   launcher so the `trace`, `current`, and `result` commands are available.
2. `nullius trace backfill` writes retroactive origin stamps for legacy
   runs by aligning run-directory timestamps against the commit timeline —
   explicitly labeled as heuristic alignment (`aligned_heuristic`), never
   presented as exact, and honestly `unbound` with a reason where no
   alignment is defensible. Validity is never backfilled.
3. `nullius trace propose-chains` derives same-topic round chains
   (r1 → r2 → r3 within one milestone) as a supersession *proposal file*;
   a human reviews and edits it, then `nullius trace confirm-chains`
   records only what the reviewed file says. The machine never decides by
   itself that a run was superseded.
4. The results registry block is pasted into `project_index.md` by hand
   once, copying the Current results section from the scaffold template —
   existing generated projects do not gain it through refresh: scaffold
   refresh does not migrate the user-owned results registry, and the CLI
   does not insert missing managed blocks. `nullius result set-current`
   refuses with exactly this instruction until the block exists.
