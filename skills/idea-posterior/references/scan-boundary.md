# Idea posterior: scan boundary

**Scan boundary.** The static scan is a review aid, not a security
boundary. It is designed to catch accidental and casual discipline breaks —
an off-grade likelihood pair, a missing anchor note, a grade written through
a variable, a statement aliased and called indirectly, a strong-grade
`downstream_reach` update missing its domain list — including the near
variants of those (an alias built from a module attribute such as
`i = lang.infer`, a reach claim identified by its `title="downstream_reach"`
rather than its variable name, a domains clause pushed inside the trailing
anchor note). It does **not** promise to catch deliberately obfuscated
authoring: code that hides a statement behind `exec`/`eval`, computed or
dynamically built attribute names, a wrapper re-bound through a non-Load
context, or runtime dispatch can defeat any static reader and is out of the
scan's guarantee by design. Those cases are the human reviewer's
responsibility, backed by version-controlled history. Chasing ever-deeper
static evasions is unbounded and is not attempted; the scan is held to the
accidental-and-casual bar above, and substance — whether an anchor is true,
a grade appropriate, a set of domains genuinely independent — is always the
reviewer's call.
