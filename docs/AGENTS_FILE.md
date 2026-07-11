# Third-Party Agents File (`agents.json`)

Cross-family review and verification skills (`review-swarm`, `derivation-verify`) need to know which model families exist on a machine, which execution route serves each family, and which model string each route should be given (for example: the gpt family runs through the codex CLI with `gpt-5.6-terra`; the glm family runs through the opencode CLI with `zhipuai-coding-plan/glm-5.2`). Before this file existed, that knowledge was scattered across skill prose and script defaults, so a model upgrade had no single update point.

The agents file is that single update point. It is a plain JSON file describing the family → runner → model-string mapping plus a policy block for honest degradation when too few families are available.

Three consumers read it today, each with its own self-contained parser (deliberately no shared library; the example template below is the shared parsing fixture that keeps the parsers aligned):

- `skills/review-swarm/scripts/bin/run_multi_task.py` (`--agents-file`)
- `skills/derivation-verify/scripts/run_multi_backend.py` (`--agents-file`)
- `skills/idea-pairwise-match/scripts/run_panel.py` (`--roster`)

The five CLI runner skills (`claude-cli-runner`, `codex-cli-runner`, `gemini-cli-runner`, `opencode-cli-runner`, `kimi-cli-runner`) do NOT read this file. They keep accepting explicit arguments only; the agents file is resolved by the orchestrating scripts above, which then pass explicit model strings down.

## Discovery Order

Each consumer resolves the agents file in this order; the first hit wins:

1. An explicit CLI flag (`--agents-file PATH` for review-swarm and derivation-verify; `--roster PATH` for idea-pairwise-match). Highest priority; also the only source honored when auto-discovery is disabled (see below).
2. Project level: `<project>/.nullius/agents.json`, where `<project>` is found by walking up to the first directory containing `.git` — review-swarm and derivation-verify walk up from the current working directory (the same walk `review-swarm` already uses for `review-swarm.json`); idea-pairwise-match walks up from its materials directory, so the roster follows the campaign the materials belong to rather than wherever the command happened to be invoked from.
3. User level: `~/.nullius/agents.json`.
4. Nothing found: the run proceeds with the built-in default, which is equivalent to a pure-native configuration.

**A missing file is never an error.** Every consumer must behave exactly as it did before the agents file existed: explicit model specs keep working, and nothing degrades or warns. Only `family:` specs (which cannot be resolved without a file) are rejected in that case.

**A malformed file IS an error.** If a discovered or explicitly named file exists but fails to parse or violates the schema, the run stops with an input error rather than silently continuing with a partial or empty configuration.

Auto-discovery (steps 2 and 3) is disabled by environment variable so that tests and child launcher processes stay hermetic:

- `review-swarm`: `REVIEW_SWARM_NO_AUTO_CONFIG=1` (the same switch that already disables `review-swarm.json` auto-discovery).
- `derivation-verify`: `DERIVATION_VERIFY_NO_AUTO_CONFIG=1`.

An explicit `--agents-file` flag still works when auto-discovery is disabled.

## Schema (version 1)

```json
{
  "version": 1,
  "families": {
    "claude": { "runner": "native",   "models": { "default": "opus", "strong": "fable", "fast": "sonnet" } },
    "gpt":    { "runner": "codex",    "models": { "default": "gpt-5.6-terra", "strong": "gpt-5.6-sol", "fast": "gpt-5.6-luna" } },
    "glm":    { "runner": "opencode", "models": { "default": "zhipuai-coding-plan/glm-5.2" },
                "notes": "run review invocations in the foreground; background concurrency has died silently" },
    "kimi":   { "runner": "kimi",     "models": { "default": "kimi-code/kimi-for-coding" } },
    "gemini": { "runner": "gemini",   "available": false, "notes": "no local access on this machine" }
  },
  "policy": { "cross_family_minimum": 3, "when_below_minimum": "native_subagents" }
}
```

Top-level fields:

| Field | Type | Meaning |
|---|---|---|
| `version` | int, required | Schema version. Must be the JSON integer `1`; consumers reject any other value, including `1.0` and `"1"`. |
| `families` | object, required | One entry per model family. The key is the family name used in `family:` specs and in reports; it must be lowercase (family names travel through case-normalized channels — `family:` specs and native family tags — and a non-lowercase name would compare unequal to its own normalized form). |
| `policy` | object, optional | Degradation policy (see below). May be omitted entirely (the defaults below apply), but an explicit `null` or non-object value is malformed. |

Two configuration contradictions are rejected at parse time, because either would make family attribution ambiguous and could count one physical family twice in a cross-family gate: two families declaring the same dedicated (non-`opencode`) runner — one dedicated execution route is one model family; merge them into one family with several tiers — and two families declaring the same (runner, model string) pair. `opencode` itself is a multi-provider gateway and may serve several families with distinct model strings.

Per-family fields:

| Field | Type | Meaning |
|---|---|---|
| `runner` | string, required | Execution route label. One of: `native`, `codex`, `opencode`, `kimi`, `gemini`, `claude-cli`. |
| `models` | object, optional | Named model tiers for this family. Keys are tier names (`default`, `strong`, `fast`, ...); values are the model strings the runner's CLI accepts. `default` is what a bare `family:<name>` spec resolves to. |
| `available` | bool, optional | Explicit availability declaration. `false` means the family must be treated as absent on this machine. When omitted, the family is declared available, and the runtime still checks that the runner's executable actually exists before counting the family as usable. |
| `notes` | string, optional | Free-text operational notes (quirks, invocation constraints). Surfaced in error messages where relevant. |

Unknown-key handling is currently consumer-dependent, not a settled cross-parser contract. What every parser agrees on: a top-level `_notes` key is accepted, so a file may carry its own comment there alongside `version`/`families`/`policy`. Where they differ: `review-swarm` and `derivation-verify` ignore ANY unknown key at any level; `idea-pairwise-match`'s parser rejects unknown keys everywhere except that one top-level `_notes` (a typo in a per-family field, such as a misspelled `model`, is caught there as a parse error but silently ignored by the other two). Until the three parsers converge on one behavior, the portable subset is: comments only in top-level `_notes`, no other extra keys anywhere.

Runner labels:

| Runner | Meaning | Executable checked |
|---|---|---|
| `native` | The host agent's own family. Served by the host's native subagents in-process; CLI launchers cannot execute it and reject `family:` specs that resolve to it. | none (always considered present) |
| `codex` | The codex CLI (via `codex-cli-runner`). | `codex` |
| `opencode` | The opencode CLI (via `opencode-cli-runner`). Model strings carry their own `provider/model` prefix. | `opencode` |
| `kimi` | The Kimi Code CLI (via `kimi-cli-runner`). The executable is the current `kimi` binary; the skill directory name `kimi-cli-runner` is historical. | `kimi` |
| `gemini` | The gemini CLI (via `gemini-cli-runner`). | `gemini` |
| `claude-cli` | The claude CLI (via `claude-cli-runner`), for machines where the claude family is exercised through the CLI rather than natively. | `claude` |

Policy fields:

| Field | Type | Meaning |
|---|---|---|
| `cross_family_minimum` | int, optional (default 3) | Minimum number of usable families for a review/verification round to count as fully cross-family. |
| `when_below_minimum` | string, optional (default `native_subagents`) | What the calling skill should do when fewer families are usable. `native_subagents` — fall back to a panel of the host's own subagents (multiple instances, distinct review perspectives) — is the only value schema version 1 defines; consumers reject anything else rather than guessing. |

## Family Specs

review-swarm and derivation-verify accept, anywhere a model spec is accepted (`--models` in `run_multi_task.py`; `--backends` / `--comparators` in `run_multi_backend.py`):

```
family:<name>          # resolves to the family's "default" tier
family:<name>:<tier>   # resolves to a named tier, e.g. family:gpt:strong
```

Resolution uses the agents file: the family's runner picks the execution route, and the tier's model string becomes the explicit model argument. Errors are explicit and immediate: an unknown family, an unknown tier, a family declared `available: false`, a family whose runner executable is not present on the machine, a family whose runner is `native` (native families are run by the host itself, not through a CLI launcher — `derivation-verify` accepts them as host-supplied `native_derivations` instead), or an opencode model string whose leading segment collides with a reserved launcher prefix (`claude/`, `codex/`, `gemini/`, `kimi/`, `family:` — the collision would silently re-route the agent to a different runner than the file declares). A `family:` spec without any agents file is likewise an input error; it is never silently reinterpreted.

An agent requested through a `family:` spec never participates in `run_multi_task.py`'s optional backend fallback (`--fallback-mode`): the caller asked for that specific family, and an unusable family is honestly absent, never substituted. Such a skipped fallback is recorded in the trace as `fallback_skipped_family_spec`; rerun the same family or drop it explicitly instead.

Explicit model specs (`codex/gpt-5.6-terra`, `zhipuai-coding-plan/glm-5.2`, ...) always keep working and always take priority over anything the agents file says: the file only supplies mappings, it never overrides an explicit argument.

## Availability and Honest Degradation

A family counts as **usable** when it is declared available (`available` is absent or `true`) AND its runner's executable is actually present on the machine (`native` always passes this check). A family that is not usable is honestly absent: consumers never substitute another family for it.

When the number of usable families is below `cross_family_minimum`, the run itself still proceeds (the launcher never blocks on this), but the calling skill is expected to follow `when_below_minimum` and fall back to the host's native subagent panel. Either way, the run's outputs must make the situation visible rather than silent — every consumer records its panel/backends composition in its result files. review-swarm (`meta.json`) and derivation-verify (the verification matrix) share the exact field set below. idea-pairwise-match records the same information under its own field names, split across its two outputs: `panel_run_report.json` carries `roster.source`, `independence`, `independent_runners`, `families_present`, `absent`, and `min_families`, while the `pairwise_match_v1` artifact carries `independent_runners` and `panel_independence` (`mode` / `families_present` / `families_absent`) — see that skill's docs. Unlike the other two consumers it also enforces the degradation itself (the panel refuses to run cross-family below the floor) rather than delegating it to a calling skill. The shared review-swarm/derivation-verify field set:

- `agents_file`: which file was used (`explicit` / `project` / `user`) or `none`.
- `independence.level`: `cross_family` when at least two distinct families actually produced output, `single_family` when exactly one did, `none` when none did.
- `independence.participating_families`: the distinct families that actually produced output.
- `independence.declared_available_families`: the families usable on this machine (declared available in the file AND runner executable present).
- `independence.absent_families`: declared families that did not participate in this run (including those declared `available: false`).
- `independence.below_minimum` plus the policy fields, so a reader can see that a degraded round was known to be degraded when it ran.

The independence field set is identical on every path, including the pure-native missing-file path. Without an agents file, the declaration-relative fields (`declared_available_families`, `absent_families`, `cross_family_minimum`, `below_minimum`, `when_below_minimum`) are `null`: "nothing was declared", which is deliberately distinct from an empty list ("everything declared participated").

This is the configuration form of an existing principle (stated in `numerical-reliability-gate`): single-model agreement is the floor, cross-family agreement is the ceiling — a degraded round is allowed, but it must be labeled as what it is.

Family attribution for the independence record works on the resolved execution, not on wording: a spec resolved from `family:gpt` and an explicit `codex/gpt-5.6-terra` count as the same family when the model string matches an agents-file tier; runners used by exactly one declared family map to that family; opencode model strings are matched by their `provider/` prefix; anything the file cannot attribute keeps its runner label as the family name (the pre-agents-file behavior). In `derivation-verify`, a host-declared native family tag goes through the same mapping: a host tagging its own derivations `codex` and a CLI derivation attributed to the `gpt` family are one physical family, so they can never count as two independent families in the cross-family gate. A native tag the file cannot attribute at all (for example the gateway alias `opencode`, which several declared families may sit behind) is dropped from the gate visibly (`native_dropped` in the matrix row) rather than kept under an unattributed label, where it could sit beside a roster-attributed CLI family and count one physical family twice.

## Example Template

An annotated, copyable template lives at [`docs/examples/agents.example.json`](examples/agents.example.json). It is also the shared parsing fixture across the consumers' test suites, which is what keeps the self-contained parsers behaviorally aligned. Copy it to `~/.nullius/agents.json`, replace the model strings with the ones your locally installed CLIs accept, and delete or adjust the `available: false` entries to match your machine.
