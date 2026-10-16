# Review swarm: `review_one.py` flag reference

Flags:

- `--model SPEC` — **required, exactly one**, no default (`codex/default`,
  `gemini/default`, `kimi/default`, `claude/<model>`, or an OpenCode
  `provider/model`).
- `--artifact PATH` (repeatable), `--diff BASE..HEAD`, **or**
  `--extraction-request PATH` — mutually exclusive packet inputs. The first two
  are review targets. The last is a neutral locator/question list accepted only
  by `source-extraction`.
- A `--diff` packet contains changed hunks, not every unchanged declaration or
  invariant they depend on. Add the full relevant files with repeatable `--context`
  flags when a correctness verdict may depend on surrounding definitions. A reviewer must
  not infer that an implementation element is absent merely because it is not
  visible in the diff.
- **Confirmation rounds default to the delta.** For a re-review of an artifact
  whose prior content hashes were already reviewed, the packet may be the exact
  delta from the reviewed baseline plus the manifest reference to that
  baseline (the freshness gate already accepts "the complete exact delta from
  the reviewed hash"), with a findings-to-resolutions table. Reserve full-file
  packets for first rounds, and re-escalate when the delta reaches into
  surface the panel never reviewed, changes formulas/assumptions, a data model
  or global invariant, or an origin-traceability root — or when the reviewer
  asks. Re-feeding unchanged contracts, registries, and prior verdicts every
  round consumes reviewer context without adding verification power.
- **Packet composition**: embed immutable snapshots (content copies) of
  anything that lifecycle machinery rewrites in place (status summaries,
  registries, adjudication indexes). A packet that embeds a live mutable file
  goes STALE on every unrelated bookkeeping write, cascading re-reviews that
  verify nothing new.
- **Candidate-commit binding**: a packet whose review target is a committed
  candidate states **exactly one** candidate commit in a machine-readable
  header line (`Candidate-commit: <full commit id>`, top of the packet, never
  inside embedded artifacts or diffs); registration or bookkeeping commits,
  when mentioned at all, are labeled as such and never share that line. A
  dispatch in which the reviewer must guess which of two commits is under
  review is refused before any reviewer is launched — an ambiguous binding
  voids the whole round after the tokens are already spent. Machine support:
  `review_one.py --candidate-commit <ref>` resolves the ref to its full
  commit id at dispatch (a movable ref is pinned then and there), records it
  in the input manifest, emits the header line, and — when the target is a
  `--diff BASE..HEAD` — refuses a candidate id that does not equal the
  resolved HEAD side of the range. Candidate binding names the state under
  review; `--baseline-review` separately binds the BASE to the previously
  reviewed state — the two relations never substitute for each other.
- `--role generic|correctness|execution-adversary|source-extraction|source-fidelity` — picks the
  system prompt from `templates/<role>.md` (default: `generic`). Each template
  embeds the required review-contract output format.
- `--source PATH` (repeatable) — exact UTF-8 text/LaTeX/Markdown primary-source
  input for the two source roles. They fail closed before model
  launch when no source is supplied, when source and target are the same file,
  or when the source is binary/non-UTF-8. A PDF/image-capable reviewer must
  first check PDF/scan passages against the original rendered page. Persist
  the visually verified excerpt, locator, original-page hash, and crop hash;
  lossy automatic PDF decoding is not formula-level evidence. A later
  text-only pass checks note against excerpt, not excerpt against original page.
- `--source-text-origin direct-original-text|visually-verified-transcription` —
  **required** for both source roles. This prevents a manually normalized extract
  from being silently treated as publisher/repository bytes. The declaration is
  recorded but not machine-proven.
- `--source-provenance-evidence PATH` (repeatable) — exact UTF-8 record of the
  original document/page/crop locators and hashes plus the visual comparison.
  Required for `visually-verified-transcription`. It must be separate from the
  source and correction-search files. The launcher verifies presence, separation,
  UTF-8 validity, and hashes; the reviewer must still inspect it for source-layer
  normalization, answer leakage, and lack of an independent visual verifier.
- `--correction-status not-applicable|checked-none-found|checked-corrections-included`
  — **required** for both source roles; it prevents silent reliance on an
  unchecked main publication. Use `not-applicable` only when a correction chain
  is genuinely inapplicable, not as a shortcut for an unperformed search.
- `--correction-source PATH` (repeatable) — exact UTF-8 correction text. It is
  required with `checked-corrections-included`, rejected with the other statuses,
  and persisted separately from the primary source in the packet and manifest.
- `--correction-search-evidence PATH` (repeatable) — exact UTF-8 record of the
  indexes/identifiers searched and their result. It is required for both
  `checked-none-found` and `checked-corrections-included`, so a negative or
  positive correction-chain claim cannot be represented by an unsupported flag.
- `--extraction-request PATH` — exact UTF-8 neutral questions/locators for
  `source-extraction`. That role rejects `--artifact`, `--diff`, and `--context`
  to keep the candidate and prior verdict out of the packet by construction.
  The launcher cannot semantically prove that the request is neutral, so the
  reviewer must block if it contains an expected answer or proposed correction.
- `--context PATH` — optional extra material appended to the packet. Repeatable;
  every file is embedded and recorded in command-line order. Duplicate paths are
  rejected instead of being silently collapsed, and a context path identical to
  an `--artifact` target is rejected for every reviewer role.
- `--locator PATH` — notebook-only raw-byte source locator. Its bytes and hash
  enter the same review input manifest and pre/post/final freshness checks,
  without embedding or claiming to read its binary/invalid UTF-8 content. The scope
  inventory must list it under `opaque_links`; its necessity assessment belongs
  in `opaque_sources`. Missing assessments or required unread sources refuse
  notebook acceptance. Supply checked readable text dependencies when needed.
- `--out-dir DIR` — defaults to `./review-one-<UTC timestamp>/`; the assembled
  inputs are persisted under `<out-dir>/inputs/` for audit. Every run also writes
  `inputs/review_input_manifest.json`, which records the SHA-256 of each target,
  primary source, correction source, correction-search record, source-provenance
  record, context, neutral extraction request, persisted system prompt, and
  persisted packet, plus the exact diff hash when applicable.
- `--host-family FAMILY` — pass your own family to make the entry refuse when
  `--model` resolves to it, pointing you to host-native sub-agent review instead
  (mirrors "Host-aware execution" above).
- `--max-prompt-bytes N` / `--max-prompt-chars N` — the launcher's prompt-size
  guard applied to the assembled inputs; an oversize packet is refused with the
  guard's message (no silent truncation).
- `--use-project-config` — opt back into `.nullius/review-swarm.json`
  auto-discovery; by default the entry sets `REVIEW_SWARM_NO_AUTO_CONFIG=1` so
  runs are hermetic. With the flag, `REVIEW_SWARM_NO_AUTO_CONFIG` is removed for
  the delegated run even when the caller's environment already sets it (the
  prior value is restored afterward), so the opt-in works under a suppressing
  environment too.
- `--timeout-secs`, `--claude-live-capture`, `--expected-secs`, `--inactivity-secs`,
  `--inactivity-grace-secs`, `--backend-tool-mode`, `--<backend>-runner` — forwarded
  to the launcher unchanged. No implicit hard deadline is added by this entry.
