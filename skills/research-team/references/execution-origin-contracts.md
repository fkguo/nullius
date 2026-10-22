# Execution and origin contracts

Command, script and asset paths in this reference are relative to the `research-team` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

- **Prior-art binding (mandatory when a delegation brief names prior art)**: when the dispatch brief for the work under review named prior art — an upstream toolkit routine, a sibling project's implementation of the same end-to-end problem, a published method — the reviewer verifies that, for each named asset, the implementation's call sites or the approved pre-implementation deviation record exist **before** assessing results (see [*Reuse-or-deviate gate*](reuse-or-deviate.md)); an implementation carrying neither does not converge.
- **Pointer lint (mandatory)**: code pointers in the notebook must be resolvable under the configured `pointer_lint.strategy`.
- **No unrecorded retries — but two distinct retry regimes**: when a gate fails, stop, apply the minimal fix, and record the retry. Which regime applies depends on what failed:
  - **Development iteration stays inside one run.** Deterministic-gate failures, build errors, and diagnostic runs are fixed and re-tried within the same run/tag (`--preflight-only` reruns deterministic gates at zero reviewer cost; log the attempts in the run dir). Minting a fresh tag, contract, and packet for every such fix is the recorded anti-pattern that multiplies run directories without adding verification.
  - **A new cycle tag (`M2-r2`, `M2-r3`, ...) marks re-entry into the reviewed convergence cycle** — a new candidate going back to the members — not each intermediate fix that produced it. Batch every known blocking fix into the next candidate rather than cycling one finding at a time.
  - **Bounded rounds**: cap reviewed rounds per tag family (config `bounded_rounds.max_per_tag_family`, default 5; machine-enforced at preflight). Hitting the cap forces the narrowing rule — narrow the candidate's scope, reduce the claim's strength, explicitly classify as `SCOPE`/`MATCHING`, or take the blocking question to the project owner — instead of another full round; a narrowed candidate continues under a new base tag.
- **Run artifact identity**: the canonical project artifact root for
  lifecycle and compute runs is `artifacts/runs/<run_id>/`. Use a safe,
  sortable, readable `run_id`, preferably
  `<YYYYMMDD>-<milestone>-r<NNN>-<slug>[-rK]` (date + milestone + a
  milestone-global ordinal + a short topic slug; the optional trailing `-rK`
  is the reviewed-round suffix). The exact time of day does not belong in the
  directory name — machine truth (precise timestamp, commit, dirty state)
  lives in the run's origin stamp, and sub-day precision in names measured as
  unreliable in practice. The older
  `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN` shape stays valid for
  existing runs. Team and draft payloads live in `artifacts/runs/<tag>/research_team/`;
  the tag is the same parent run identity. Packets, checkpoints, reports and
  logs are executor evidence; the parent run holds the origin stamp.
- **Stamp the run at creation (mandatory where the project has a nullius
  launcher)**: immediately after creating `artifacts/runs/<run_id>/`, run
  `nullius trace stamp artifacts/runs/<run_id>` from the project root. The stamp binds the
  run to the exact code state that will produce its results (commit, snapshot
  of uncommitted tracked edits, untracked-file caveats) — recorded at run
  time, when the binding is exact, instead of reconstructed later, when it
  can only be a heuristic alignment. A run created without a stamp stays
  usable but its origin degrades to timeline guesswork; treat a missing
  stamp on a result-bearing run as a review finding.
- **Tag relation**: with `--auto-tag`, pass a meaningful base tag such as
  `20260502T023000Z-m3-branch-scan`; the resolved `<base>-rN` is the
  research-team cycle tag and may be used as the control-plane `run_id` for
  that reviewed cycle. Do not use bare UUIDs or `run_<uuid>` as human-facing
  research tags.

For member construction in `full_access`, use the audited `files_written` request channel with `path`, complete UTF-8 `content` and `purpose`, followed by literal commands to execute the member’s program. Writes are restricted to that member’s `independent/` prefix and bound through `original_transport.construction_refs` to the raw original model output, complete source bytes, SHA-256 and byte size. Identical bytes may be reused with `created=false`; differing originals are never overwritten. Every own-prefix code source must match a whole original model-emitted source string, including nested JSON or a complete fenced body. A generic I/O carrier may preserve that origin; preseeded code, substring matches and examiner booleans cannot substitute for it. Shared legitimate libraries outside the construction prefix remain assessment inputs. See [member invocation evidence](member_transport.md).

Select neutral reproduction input with the team-cycle `--reproduction-packet` option or `independent_reproduction.blind_packet` configuration. The selected route becomes the member writer’s ordinary `--packet` input. A route name does not prove blindness: the source assessor must examine the complete original packet, every actual read, command input and final-stage input for prior answers or author judgments.
