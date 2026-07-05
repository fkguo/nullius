---
name: idea-allocation
description: "Decision layer for allocating research effort across a portfolio of ideas: Thompson-sampling allocation from per-idea posteriors (a Beta construction with Laplace pseudo-counts), slot-based cuts into deep investment vs reconnaissance vs hold, cold-start handling for ideas without a posterior, and an activation monitor for ideas waiting on external conditions with ready-to-paste lifecycle-transition commands. Use before each investment round, after new evidence has updated the belief graph posteriors, or when checking whether waiting ideas can enter play. Keeps utility, cost, and budget OUT of the belief layer; slot counts are caller-supplied (no built-in budget); an explicit random seed makes every allocation reproducible."
---

# Idea Allocation

Turn per-idea posteriors into one round of investment decisions, and watch the
queue of ideas waiting for their entry condition. Two standard-library Python
scripts, no third-party dependencies:

- `scripts/thompson_allocation.py` — one Thompson-sampling draw per active
  idea, ranked, cut into deep investment / reconnaissance / hold, written as
  an `allocation_decision_v1` artifact.
- `scripts/activation_monitor.py` — a check report over ideas in
  `waiting_activation`, grouped by condition kind, with a ready-to-paste
  lifecycle-transition command for every condition already satisfied.

## When to use

- Before each investment round: decide where the next block of person-time
  and compute goes.
- After new evidence has been folded into the belief graph and posteriors
  were re-derived: re-read the fresh posteriors and re-allocate. Revival is
  automatic this way — an idea whose posterior rose on new evidence simply
  starts winning draws again; nothing needs to be un-archived by hand here.
- Any time you want to know whether a waiting idea can enter play: run the
  activation monitor and follow its check guidance.

## Layering principle

The belief graph computes one thing per idea: the probability that the idea
is worth investing in, given the evidence. Utility, cost, capacity, and
budget NEVER enter the belief graph — they belong to the decision layer,
which is this skill. Concretely:

- Posteriors come in read-only. These scripts never write back to the belief
  graph and never adjust a posterior because an idea is cheap or expensive.
- Budget lives in the slot counts you pass on the command line, in the
  `budget_note` strings of the artifact, and nowhere else.
- If an allocation feels wrong because the belief feels wrong, fix it with
  evidence (route new observations into the belief graph), not by editing
  numbers here.

## Input: the campaign store snapshot

Both scripts read `nodes_latest.json` from the campaign store (a top-level
object with `campaign_id` and `nodes`; `nodes` may be a list or a mapping
from node id to node). Per node, the pinned fields are:

| field | meaning |
| --- | --- |
| `node_id` | non-empty string identifier |
| `lifecycle_state` | `active`, `waiting_activation`, or `archived`; missing means `active` |
| `posterior` | optional object: `value` in [0, 1], `evidence_count` >= 0, `updated_at` ISO 8601, optional `gaia_package_ref` |
| `activation_condition` | required for `waiting_activation`: `kind`, `description`, `satisfied`, optional `last_checked_at` |

`activation_condition.kind` is one of `tool_readiness`, `data_release`,
`stage_reached`, `exploratory_computation`, `other`. A store that fails
validation is rejected as a whole, with every problem listed — the scripts
refuse to allocate on top of malformed belief data.

## The Beta construction, and why

Each active idea with posterior summary `value = v`, `evidence_count = n`
samples from:

```
Beta(alpha = v * n + 1,  beta = (1 - v) * n + 1)
```

Read `n` as an equivalent sample size: the belief is treated as if it came
from `n` observations with success fraction `v`, plus one Laplace
pseudo-count on each side. Why this is the right shape:

- Zero evidence gives `Beta(1, 1)`, the uniform distribution: no evidence
  means no opinion, and the draw lands anywhere with equal density.
- The distribution mean `(v * n + 1) / (n + 2)` tracks `v` (the bias is at
  most `1 / (n + 2)`), and the variance `mean * (1 - mean) / (n + 3)` shrinks
  like `1 / n`: concentration grows with the amount of evidence.
- Little evidence means a wide distribution, so a weakly-explored idea draws
  with high variance and regularly out-draws a better-believed idea. That IS
  the exploration mechanism — it falls out of the construction rather than
  being bolted on as a bonus term.
- The density is strictly positive on the open interval between 0 and 1 for
  every finite `n`, so no idea's chance of drawing high is ever exactly
  zero. Nothing starves: the tests exhibit the exact upset probability of a
  weakly-believed idea over a strongly-believed one, nonzero at every
  evidence level (a few percent at low evidence, astronomically small but
  still positive at high evidence).

## Running an allocation round

```
python skills/idea-allocation/scripts/thompson_allocation.py \
  --nodes /path/to/campaign-store/nodes_latest.json \
  --seed 42 --deep-slots 2 --recon-slots 3
```

- `--seed`, `--deep-slots`, `--recon-slots` are required. There are no
  default slot counts on purpose: slots encode real person-time and compute
  capacity for the coming round, which only the caller knows. Pick them per
  round and treat them as the budget dial.
- One draw per eligible idea (active with a posterior), draw order fixed by
  sorted node id, ranked by sampled value descending. The top `deep_slots`
  become `deep_investment`, the next `recon_slots` become `reconnaissance`,
  the rest `hold`.
- Every candidate carries a `budget_note` explaining its cut, including
  whether the draw landed above the posterior mean (an exploration draw) or
  below it (a conservative draw).
- `--dry-run` prints the summary and writes nothing. Otherwise the artifact
  goes to `artifacts/allocations/allocation-<decision_id>.json` (override the
  directory with `--artifact-dir`).

### Cold start

Active ideas WITHOUT a posterior are never sampled and never occupy a deep
slot; they are appended to the tail of the reconnaissance list with a fixed
note ("no posterior yet — needs belief graph first"), outside the slot
budget. The first unit of work for such an idea is always the same: build its
belief-graph entry and obtain a first posterior, then it competes normally.
If many cold starts pile up, batch them across rounds — their notes make them
easy to spot.

### What reconnaissance means

A reconnaissance slot is a small, bounded scouting investment. Legitimate
destinations:

- Literature deep reads that produce evidence notes for the belief graph.
- Exploratory computations — small-scale feasibility or order-of-magnitude
  estimates. Their results feed back as observations into the belief graph
  ONLY after passing the numerical reliability checks; a scouting number that
  failed its checks is not evidence.
- Entering the idea into the pairwise contest, whose outcomes are themselves
  evidence for the belief graph.

Deep investment is the full treatment: sustained derivations, production
computations, manuscript-grade work.

## Monitoring ideas waiting for activation

```
python skills/idea-allocation/scripts/activation_monitor.py \
  --nodes /path/to/campaign-store/nodes_latest.json \
  --store-root /path/to/campaign-store
```

Waiting ideas do not participate in allocation. The monitor groups them by
condition kind and prints check guidance per kind:

| kind | what to check |
| --- | --- |
| `tool_readiness` | run the concrete command or flag that proves the tool or environment is ready (a version probe, a seeded smoke run) |
| `data_release` | the publication status of the awaited data source or release channel |
| `stage_reached` | whether the named project stage or milestone has been reached |
| `exploratory_computation` | whether the exploratory computation artifact exists AND passed the numerical reliability checks |
| `other` | no standard probe — follow the condition description verbatim |

For every node whose condition is already `satisfied: true` but which still
sits in `waiting_activation`, the report prints a ready-to-paste command that
performs the lifecycle transition through the campaign store's thin RPC
helper:

```
echo '{"method":"node.set_lifecycle","params":{...},"store_root":"..."}' \
  | node packages/idea-engine/bin/idea-rpc.mjs
```

The monitor itself NEVER performs the transition — executing the command is
the caller's action. The suggested `idempotency_key` is a deterministic
function of campaign id, node id, and target state, so pasting the same
suggestion twice is safe if the store honours idempotency keys.
`last_checked_at` is read-only for the monitor: whoever actually performs a
check or a transition updates it in the campaign store at that moment.

## The decision artifact

`allocation_decision_v1` (structure pinned with the campaign-store contracts;
the script validates its own output and refuses to write an artifact that
fails validation):

| field | content |
| --- | --- |
| `decision_id` | deterministic uuid5 over campaign id, seed, timestamp, store digest |
| `campaign_id` | campaign UUID |
| `generated_at` | ISO 8601 date-time |
| `method` | always `thompson_sampling` |
| `random_seed` | the seed that produced the draws |
| `candidates` | per idea: `node_id`, `posterior_value`, `evidence_count`, `sampled_value`, `allocation`, `budget_note`; the three numeric fields are all null for cold starts |
| `waiting_activation` | per waiting idea: `node_id`, `activation_condition`, `last_checked_at` |

## Seed and reproducibility

The seed is a required argument and is recorded in the artifact. Same seed +
same store content + same `--generated-at` reproduce the artifact byte for
byte (draw order is fixed by sorted node id; Python's random module is
deterministic for a given Python version; JSON is written with sorted keys).
Recomputing a past decision therefore needs the artifact's `random_seed`, the
store snapshot, and the slot counts from the original command — record the
command line in your run notes when the round matters.

## Interfaces to the sibling machinery

- Campaign store: supplies `nodes_latest.json`; receives lifecycle
  transitions only through its RPC helper, never by direct file edits from
  here. The artifact structure is pinned with the store's
  `allocation_decision_v1` contract.
- Belief graph: sole source of `posterior`. New evidence (deep-read notes,
  checked exploratory computations, contest outcomes) goes into the graph,
  the graph re-derives posteriors, and the next allocation round simply reads
  the fresh values — that loop is the revival mechanism.
- Pairwise contest: one of the reconnaissance destinations; its outcomes
  return to the belief graph as evidence.

## Tests

```
python -m pytest skills/idea-allocation/tests/
```

The statistical tests hold the sampler to exact theory with tolerances
derived from the Monte Carlo standard error of each estimator (5-sigma
bands, per-comparison false-failure probability about 5.7e-7) — never
hand-picked percentages. Exact rational arithmetic (integer-parameter Beta
closed forms) anchors the tail and upset probabilities; allocation logic,
artifact validation, byte-level seed reproducibility, and the pinned RPC
request shape (against a mock helper) are each locked by their own tests.
