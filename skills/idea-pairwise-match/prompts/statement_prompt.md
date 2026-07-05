# Advocacy statement request: Idea {{IDEA_LABEL}}

You are writing the advocacy statement for one side of a pairwise idea
match. A cross-family judge panel will read your statement next to the
opposing idea's statement, produced from this same template. You have not
seen the opposing idea and must not speculate about it.

The judges are instructed to discard any argument that lacks an anchor, so
an unanchored argument is worse than no argument: it is discarded, counted,
and reflects poorly on the statement.

## Committed criteria (binding)

Commitment hash: {{COMMITMENT_HASH}}

```json
{{COMMITMENT_JSON}}
```

## The idea you argue for

```json
{{IDEA_CARD_JSON}}
```

## Contract

- Argue for this idea only. Do not mention, guess at, or attack the opposing
  idea.
- Use only facts present in the idea card and its claims. Do not introduce
  new results, new references, or new numbers.
- Every argument line MUST end with an anchor tag:
  "[anchor: literature -> reference]" or "[anchor: computation -> reference]".
  The reference must be one of the card's evidence entries (a URI or artifact
  path taken verbatim from the card). A tag whose reference is not a card
  evidence entry is treated as unanchored: the line is dropped from what the
  judges see and counted, exactly as if it had no tag.
- Organize the statement as one short section per committed criterion, in
  the committed order. A criterion the card cannot speak to gets the single
  line "No anchored argument under this criterion." rather than padding.
- Close with a section "Honest weaknesses" holding one or two known
  limitations of the idea. Weakness admissions are not merit claims; anchor
  them where the card allows it.
- Length: at most {{WORD_CAP}} words in total.
- The first two lines of your output must be exactly:

criteria_commitment: {{COMMITMENT_HASH}}
idea_node_id: {{NODE_ID}}

- Output the statement markdown only: no preamble, no closing commentary,
  no code fences around the whole statement.
