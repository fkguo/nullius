# Product review criteria — <PROJECT>

Written from the requirements **before** any candidate design was visible. The reviewer
applies these criteria to the candidate; the candidate does not supply the criteria.

## Required flows

1. Arrive and find an entity by a name or symbol a user would actually know — without
   knowing any internal identifier.
2. See the entity's key quantities, each with unit, uncertainty/limit and source.
3. Reach the values behind a displayed quantity, including the contributing records and
   their references.
4. Compare several entities, or several sources for one quantity, without losing the
   current context.
5. Return, copy and continue; selection and position survive.

## Names and identity

- Case, spaces, hyphens, unicode, aliases and common variants are accepted.
- Normalisation never erases physically meaningful markers (charge, isomer, excitation,
  anti-particle, state).
- Family names produce candidates; no silent replacement; no silent merge of states.
- Empty result keeps the input and suggests valid forms.

## Display rules

- Value, unit, uncertainty and limit are adjacent and unambiguous.
- A missing value is `not recorded`, never zero.
- Several sources are shown as several sources, or with an explicit comparison; no hidden
  preference.
- Copy produces a stable, complete citation-bearing string.

## States

Loading, empty, not-recorded, error, offline, stale and partial states each have a
recoverable rendering and never masquerade as each other.

## Platforms and accessibility

- Compact, medium and expanded layouts each checked on a real device or simulator.
- Keyboard and screen-reader paths for the primary flows.
- Text selection and copy everywhere values appear.

## First-release boundary

What is deliberately excluded, and why the exclusion does not damage trust in the data
that is shown.

## High-risk omissions

- several values merged into one;
- a limit shown as a measurement;
- unit conversion changing precision;
- partial coverage presented as complete;
- a reference detached from the value it supports;
- dataset version invisible.

## Acceptance checklist

- [ ] every flow has a real example and an end state
- [ ] no primary flow requires an internal identifier
- [ ] every state has a rendering
- [ ] copy and read-aloud text defined for values
- [ ] boundary and omissions stated
