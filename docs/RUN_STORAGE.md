# Research output storage

Source, frozen inputs, essential raw results, final results and provenance belong in version control when their preservation requires it. Reproducible arrays and intermediates belong in a content store; disposable caches and verbose machine logs may stay local. File size and extension do not establish scientific value. Declare exact file or directory paths with reasons in `.nullius/storage_policy.json`; the longest matching path wins:

```json
{
  "schema": "storage_policy_v1",
  "path_rules": [
    {"path": "artifacts/runs/example/inputs", "disposition": "git", "reason": "unique frozen inputs"},
    {"path": "artifacts/runs/example/results.json", "disposition": "git", "reason": "essential small results"},
    {"path": "artifacts/runs/example/intermediates", "disposition": "store", "reason": "regenerable arrays"},
    {"path": "artifacts/runs/example/raw_logs", "disposition": "local", "reason": "disposable machine output", "retention_days": 30}
  ],
  "admission_max_bytes": 67108864,
  "admission_max_files": 2000
}
```

Commit the policy. Rules use literal project-relative paths, not globs or extension classifiers. `git` preserves declared evidence irrespective of size. `store` selects outputs even below the default 5 MiB threshold. `local` refuses newly staged or dirty tracked bytes but does not ignore, move or delete files; add reviewed ignore rules yourself. Without a rule, the existing 5 MiB threshold applies under `run_roots` (default `artifacts/runs`). Unclassified smaller files remain eligible for Git. No rule automatically proves reproducibility or scientific acceptance.

Run these commands with the installed `research-harness` skill's `scripts/run_storage.py`, from the project checkout (or pass `--project-root`):

```bash
python3 <skill>/scripts/run_storage.py inventory --json
python3 <skill>/scripts/run_storage.py stow artifacts/runs/example
python3 <skill>/scripts/run_storage.py verify artifacts/runs/example
git add artifacts/runs/example/bulk_manifest.json artifacts/runs/example/.gitignore
python3 <skill>/scripts/run_storage.py check --staged --strict
```

Stop writers before stowing. The tracked manifest records SHA-256, size and path; independent stored copies deduplicate identical bytes across runs and worktrees. `verify` checks actual bytes and stored copies; `materialize` restores missing files without replacing occupied paths. The default store is `<git common dir>/nullius/store`. It survives checkout cleanup but is local to this repository: a clone or push does not transfer it. Back it up separately and validate recovery before retiring the only byte copy. No automatic store pruning is provided.

Origin capture (including creation through `nullius run`, manual `trace stamp`, identity probes and retries) now requires Python 3 and invokes the same checker with `check --snapshot --strict` before refreshing the index or creating stash objects. It examines changed index bytes and changed tracked working bytes. Declared `store`/`local` files and unclassified bulk outputs are refused: `trace stamp`, identity probes and retries stop with an error, while a first `nullius run` launch proceeds unstamped and reports the failure in `origin_stamp` (relaunching an already stamped run is refused). A Git bundle's content header also refuses a backup archive anywhere in the checkout unless explicitly declared as unique Git evidence. Other archives require semantic path rules; a compressed source input cannot be judged from its suffix. Unchanged historical bulk remains readable, and existing refs are never rewritten.

Admission also refuses more than **64 MiB or 2,000 files** in one changed run-output set by default. These are configurable review thresholds, not scientific tolerances or disk quotas. They count path occurrences (the larger index or working size per path), excluding explicitly declared Git evidence and validated stow manifests/managed ignore blocks. A reserved filename alone grants no exemption; an exact local/store rule for a record is enforced. Use classifications and stowing to resolve findings; raise a limit only after reviewing the contents. This guards a batch of small outputs as well as a single large file. It does not measure total history or cumulative growth across separate commits. Admission observes a stable single-owner tree; concurrent edits after the check are outside its guarantee. At ordinary commit time the checker is still opt-in: call `check --staged --strict` from the project's own pre-commit hook. No global hooks are installed; direct Git and host-created snapshots remain outside Nullius authority.

`inventory` is read-only: it reports current-index file counts, per-run groups, duplicate Git blob identities, filesystem counts under run roots and explicitly declared local paths, ref namespaces and declared local files older than their rule's `retention_days`. Repeated path bytes are logical duplication, not extra Git object bytes or disk space that can be reclaimed. The inventory does not infer scientific obsolescence, source-link coverage, historical/store reachability or deletion safety. Retention ages use filesystem mtime, which checkout and copying can change; every candidate needs owner review, especially tracked files. There is no default expiry for source, inputs, results, failure evidence or recovery records. Existing `check` reads also avoid filesystem case probes.

Use one run per immutable experiment or coherent research task; group execution, inputs, necessary results and review evidence within it. Prefer a single frozen source/input identity with links from retries and reviews to repeated directory copies. Keep corrected results in a new run and record supersession through the existing validity/result registries. A short researcher-facing index should link current results and their evidence, with older material visibly superseded or unresolved. Historical evidence can retain its original layout; reorganizing or deleting it is a separate project-owner decision. Git refs protect objects from garbage collection, including tree refs created by a host; removing a working file does not retire that history. History rewriting, reflog expiration and automatic data deletion are never part of these commands.

Existing projects are not migrated by a template or skill update. Merge the storage guidance and policy explicitly, configure the project hook if wanted, and inspect the current inventory before deciding how to handle old outputs.
