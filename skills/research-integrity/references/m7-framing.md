Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### M7: frame_lock

**Definition.** Continuing to interpret a result through the initial
framing of the question even after evidence has accumulated that
would fit a different framing better. The agent's reasoning never
crosses the framing boundary; new findings are made to fit the
existing story.

**Signs.**
- Every new finding "confirms" the original hypothesis.
- Anomalies described as noise without testing the alternative they
  would support.
- The agent's wording mirrors the original prompt's wording too
  closely; no reformulation has occurred.
- A result that contradicts the framing is described as a "minor
  caveat" rather than as a load-bearing observation.

**Minimum disconfirming check.** State the result one more time using
the *opposing* framing — switch sign of the effect, swap the role of
the proposed cause and the proposed consequence, or try the null
hypothesis as if it were the working hypothesis. If the opposing
framing sounds equally natural, the framing is not load-bearing —
proceed. If the opposing framing makes the result *disappear* or
contradicts a different observation, you may be frame-locked.

**Tools that help.** None machine-enforceable; this is an explicit
prose step. `research-harness` recovery is a good moment to perform
it, by re-reading `research_contract.md` and
`research_plan.md#Current Status` with fresh eyes after the M1–M6
material checks have been completed.
