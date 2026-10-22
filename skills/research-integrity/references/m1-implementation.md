Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## The eight modes

### M1: implementation_bug_passing_self_review

**Definition.** A coding error that the agent reviewed and judged
clean, because the review used the same broken mental model as the
implementation. The bug is invisible to the author and visible to a
fresh reader.

**Signs.**
- "Self-review: looks correct." with no specific counter-hypothesis
  attempted.
- Tests pass, but were written by the same agent that wrote the bug.
- Recent diff deleted code that "looked unused," and the symptom
  appeared after.
- The agent's mental model of the function and the code's actual
  behavior have not been independently re-derived.

**Minimum disconfirming check.** Pick one load-bearing assumption made
in the code (e.g. "this branch is only reached when X is set", "this
loop iterates over already-deduplicated entries") and search the
codebase for a counterexample. If you cannot construct one, that itself
is a signal worth flagging in the response.

**Tools that help.**
- `git diff` against the prior known-good commit — sometimes the bug
  is the recent deletion.
- A fresh subagent or peer model running an adversarial review of the
  diff in isolation.
- Call-graph tracing — grep for call sites, or a code-intelligence tool
  if one is available — to surface invariants you may have forgotten existed.
- `pnpm -r build` and the targeted package's `vitest` / `pytest` —
  type-checking and tests catch a subset of M1, but they do not
  substitute for the disconfirming check.
