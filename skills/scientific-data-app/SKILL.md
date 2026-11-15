---
name: scientific-data-app
description: "Build or port an offline desktop/mobile app over an authoritative scientific dataset (particle properties, nuclear structure, evaluated nuclear data, constants, materials) where displayed numbers, provenance and source conflicts must remain correct. Provides a six-gate pipeline — data atlas, product/UX criteria, narrow interface contract, frozen parsing/display rules with independently generated fixtures, real-data acceptance matrix, release gate — plus a two-seat review and adjudication protocol, honesty grades, and copy-ready templates for a private design-docs repo. Use when starting such an app, porting an existing dataset app to a new dataset, or when a dataset app's numbers, UX or release claims must become reviewable."
---

# Scientific Data App

An app that displays evaluated scientific data is a data-correctness product wearing an
interface. The expensive failures are not widget bugs. They are a plausible number with
the wrong magnitude, a generic name silently resolved to one charge state, a limit
rendered as a measurement, a summary shown as if it were one experiment, a field
declared "not covered" that the database actually has. Those failures compile, pass the
happy-path tests, and survive code review that does not know the data.

This skill is the countermeasure set proven on a reference build — Particle Library, an
offline PDG reader (Flutter; macOS, iOS, Android; first public release six days after the
first design commit) — and generalized. It is an orchestration layer: `review-swarm` runs
independent review seats and owns identity/freshness bookkeeping; `research-integrity`
owns claim hygiene; a dataset lookup skill (e.g. `pdg-lookup`, a future `nds-lookup`) owns
data access. This skill supplies the artifact contracts, the gate order, and the failure
modes specific to dataset readers.

**Scope.** A local-first reader over an evaluated or curated numeric dataset: particle
properties, nuclear structure, evaluated nuclear data, reaction data, fundamental
constants, materials. Desktop and mobile from one codebase is a normal requirement.
**Not** a general CRUD app, a web service, a plotting library, or a paper tool.

## Non-negotiables

1. **No app code before the atlas (G0) and the interface contract (G2).** In the
   reference build a complete implementation was discarded because it had been written
   before the contract; the rewrite started from the design documents, and the documents
   were the only artifact that survived.
2. **The dataset's semantics are the spec.** If the source cannot support a statement,
   the app shows `not recorded`. Never infer a value, an identity, a limit, a unit or a
   relation from display text.
3. **Every displayed quantity carries provenance** (dataset, version, record key) and a
   frozen display rule backed by a fixture.
4. **Only artifacts count.** A gate is passed when its document, fixture or record
   exists and is fresh — not when an agent says it is.
5. **Static review never certifies runtime or physical correctness.** Record what was
   executed, what was read, and what one reviewer reported without independent check.
6. **One authoritative document per topic.** Every other version carries an inline
   `non-normative — see <authority>` marker; conflicting documents are adjudicated in one
   table before implementation continues.
7. **Two repositories.** Design documents, review records and release operations live in a
   private `<Project>-Internal` repository; the public repository carries user-facing code
   and documentation. Cross-link with commit hashes; never copy private review records
   into public history.

## The six gates

| Gate | Artifact | Pass condition | Does not prove |
| --- | --- | --- | --- |
| G0 atlas | `docs/00-data-atlas.md` | every table/field has a destination; identity and encodings stated; a non-empty "cannot provide" section; counts re-derived independently | that every field is physically understood |
| G1 product/UX | `docs/01-product-ux.md` + criteria-first review | every required flow has a named real example; name-first navigation; every state has a rendering | device usability |
| G2 contract | `docs/02-interface-contract.md` | empty vs missing distinguished; every query returns provenance; no UI reads rows | implementation fidelity |
| G3 rules | `docs/03-frozen-rules.md` + fixture generator | rules partition the whole dataset; fixture generated independently; regeneration byte-identical; uncovered input has a fallback | that the rules are physically right |
| G4 acceptance | `docs/04-acceptance-matrix.md` | every known trap has a real example with expected output; display sweeps are exhaustive, not sampled | performance, accessibility |
| G5 release | `docs/07-release.md` | real build + smoke per claimed platform; data terms recorded; key custody; version/update consistency | store approval |

Run G0 alone; G1 and G2 can run in parallel after G0; G3 after G2; G4 after G3; G5 last.
Full conditions, evidence and failure examples: [references/gates.md](references/gates.md).

## Review protocol

- **Two seats.** One reviews *spec fidelity* (implementation against the frozen contract,
  byte-for-byte where applicable); one reviews *implementation quality* (correctness,
  error paths, test strength, resource use). Give each the artifact and a neutral
  question — never the author's verdict or the other seat's report.
- **Criteria first.** For a design review, write the acceptance criteria before the
  candidate is shown. `review-swarm` offers this as its two-phase mode; use it instead of
  inventing another.
- **Findings get IDs and dispositions.** `ACCEPT`, `PARTIAL`, `REJECT` (with reason), or
  `DEFERRED` (with the named acceptance point). BLOCKING and HIGH must be closed or
  deferred by name; every LOW is dispositioned.
- **Re-review the fix diff.** Fixes introduce regressions: in the reference build a guard
  fix created a new escape path, and a display fix silently dropped a percent marker on
  ~550 real rows. A finding is closed only when the diff that closes it is reviewed.
- **Stop at convergence, not at agreement.** Zero BLOCKING and closed HIGH is the bar; do
  not keep reviewing to manufacture consensus, and match depth to risk (data semantics >
  UI > copy).
- **Honest degradation.** Different routes or aliases are not different model families; an
  unavailable seat is recorded as unavailable. Details:
  [references/review-and-adjudication.md](references/review-and-adjudication.md).

## Honesty grades

Every claim in a review record, handoff or release note carries one of:

| Grade | Meaning |
| --- | --- |
| `reproduced` | a script or test observed the behaviour |
| `source-read` | traced in source; not executed |
| `audit-line` | reported by a reviewer; the lead did not independently verify |

Unverified items are listed with runnable verification steps. They are never dropped, and
never upgraded by repetition.

## Failure modes

| Failure | Countermeasure |
| --- | --- |
| code first, contract later; implementation rewritten from scratch | G2 before code |
| physics inferred from display text | G3 rule + full sweep (a 63%/87% magnitude loss was found this way) |
| generic name resolved to one identity | G3 identity rules with charge/isomer counterexamples |
| one value per quantity when the dataset has several sources | G0 cross-source section + G1 source-comparison flow |
| document versions contradict each other | single authority + inline non-normative markers + adjudication table |
| the same interaction reimplemented per page | G1 component contract + code review checklist |
| defensive AI phrasing in user-facing copy | G1 copy rules; delete it |
| static review treated as runtime proof | honesty grades + G4 executed checks |
| signing key lost, installs cannot update | G5 key custody |
| a new release moves `releases/latest` away from the data assets | G5: keep the data release latest, publish with `latest=false`, or pin asset URLs; verify after publishing |
| debug-build performance reported as release performance | G5 measured on release hardware |

## Read next

| Task | Read |
| --- | --- |
| Run a gate, decide what its artifact must contain | [references/gates.md](references/gates.md) |
| Run or adjudicate a review | [references/review-and-adjudication.md](references/review-and-adjudication.md) |
| Port an existing app to a new dataset | [references/porting-playbook.md](references/porting-playbook.md) |
| Map particle-data concepts to nuclear data | [references/nuclear-mapping.md](references/nuclear-mapping.md) |

## Scaffold and check

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/scientific-data-app" ] && echo "$r/skills/scientific-data-app" && break; done || true)}"
python3 "$SKILL_DIR/scripts/new_kit.py" --target /path/to/design-docs-repo
python3 "$SKILL_DIR/scripts/check_kit.py" --kit-root /path/to/design-docs-repo --gate G0
```

`new_kit.py` copies the templates (never overwrites without `--force`). `check_kit.py` is
fail-closed: it exits non-zero while a required document, heading, section body or
placeholder is missing, and prints a JSON verdict. Templates live in
[assets/templates/](assets/templates/); they contain `TODO:` markers on purpose.

## Boundaries

- The atlas links to the dataset's own documentation; it does not paraphrase it into a
  second source of truth.
- This skill does not choose a UI framework or a distribution channel; it specifies what
  must be true before those choices are exercised.
- It does not replace `review-swarm`, `research-integrity` or a dataset lookup skill.
