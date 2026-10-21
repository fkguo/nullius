Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Quick start (reviewer selection and family evidence)

Select the intended models explicitly and map their exact model identifiers in an agents file when
family attribution is required. Same-family native reviews stay separate unless deliberately executed
as CLI seats for aggregation (see [Host-aware execution](execution-and-identity.md)). Wired routes are `claude/...`,
`codex/...`, `gemini/...`, `kimi/...`, and any OpenCode `provider/model`. The examples below suggest
routes from each host; the route labels alone do not prove the executed families:

- From a **Claude** host → `codex/...`, `gemini/...`, `zhipuai-coding-plan/glm-5.2` (not `claude/...`).
- From a **Codex** host → `claude/...`, `gemini/...`, `zhipuai-coding-plan/glm-5.2` (not `codex/...`).
- From an **OpenCode/GLM** host → `claude/...`, `codex/...`, `gemini/...` (not the OpenCode lane).

Example, driven from a Claude host (three non-Claude reviewers):

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/cross_family_review \
  --system /path/to/reviewer_system.md \
  --prompt /path/to/packet.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --agents-file /path/to/agents.json \
  --check-review-contract
```

Choose the intended reviewer models explicitly. Verify actual identity and input/method independence
before crediting the review; there is no automatic family rotation to rely on.

## Convergence check

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/multi_review \
  --system /path/to/system.md \
  --prompt /path/to/task.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --check-convergence \
  --check-review-contract \
  --agents-file /path/to/agents.json \
  --convergence-threshold 0.8
```

`--check-convergence` measures **lexical similarity** between completed eligible reviewer outputs
(Jaccard). It is a signal that reviewers are talking about the same things —
it is **not** the acceptance convergence defined in the [gate-loop discipline](gate-loop-and-freshness.md): two similar NOT_READY reviews sharing the same blockers score high
similarity while the artifact is not accepted at all. Acceptance convergence
is always read from **contract-valid** verdicts (zero BLOCKING findings on the
current artifact, dispositions complete), never from this similarity score; a
malformed delivery joins the count only after its same-model normalization
rerun (see the [delivery disposition rule](delivery-and-runtime-evidence.md)). `convergence.converged` additionally requires
at least two eligible outputs and the declared completed-family quorum. Unknown identities, unchecked
contracts and unavailable roster entries cannot supply that quorum. `quorum_satisfied` records this
condition separately from the similarity value.
