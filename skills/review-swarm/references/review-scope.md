Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Quick start (single reviewer, one command — advisory)

For one reviewer, `review_one.py` assembles the whole packet for you (no
hand-written prompt files). Its model family remains unknown until evidenced;
treat its verdict as **advisory only** for artifacts that warrant a second
seat (the packet itself carries that caveat as its first line). **Cross-family
review is preferred, not required**, and which artifacts warrant a second seat
at all is a scoping decision, not a blanket rule: a second seat is for
result-bearing, public-surface, or irreversible artifacts — headline claims and
the derivations/numbers they rest on, cross-package contracts, default-entry
behavior (the same scoping the [two-phase formal review protocol](two-phase-protocol.md) uses). Take that
seat from another model family when the machine has one (the launcher's
preflight over the agents file says which families are usable here: declared,
runner executable present; the family of a seat that ran is what its captured
identity evidence says, not what the file promised). When it has only one, the
second seat comes from the same family: it cannot establish model-family
independence, so the round is a degraded one and is recorded as
`single_family` (the launcher's independence record does this; never relabel
it). The other two axes are then recorded on their own terms, not assumed:
where the claim admits a candidate-withheld route (`--role source-extraction`
for a transcription, `derivation-verify` for a derivation, an independent
reproduction for a number), that route — raw inputs and a neutral question,
the candidate withheld — is the second seat, with the candidate-visible
comparison only afterwards, and the input axis is then genuinely independent;
where it does not (a manuscript, a design, a diff), the second seat is a fresh
reader that receives the artifact and the question but not the first seat's
report, any prior verdict, or the author's framing beyond the artifact, and
its input axis is recorded as candidate-visible — a review, not a
reproduction. A degraded round closes the artifact under this policy because
the alternative on a one-family machine is no second seat at all, not because
the label makes it equivalent to a cross-family one. Internal
implementation variants — writers, fixtures, launchers, schema plumbing —
close on a single-family review plus local tests either way (an implementation
never closes on its author's own tests alone). Reviewer investment scales with
the artifact's stakes the same way reasoning effort does; spending a
cross-family panel on every internal diff is the recorded waste pattern, not
the safe default.

```bash
python3 scripts/bin/review_one.py \
  --model codex/default \
  --artifact /path/to/notes.md \
  --role correctness
```

See [single-reviewer invocation](single-reviewer-invocation.md) and the [full flag reference](review-one-flags.md).
