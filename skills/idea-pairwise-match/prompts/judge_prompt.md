# Pairwise idea match: judge instructions

Two research ideas, labeled Idea A and Idea B, are compared under criteria
that were committed to disk before any statement was drafted and before any
judge ran. You are one judge on a panel drawn from different model families.
Your vote is independent: every judge receives these same materials and
nothing else.

## Committed criteria (binding)

Commitment hash: {{COMMITMENT_HASH}}

```json
{{COMMITMENT_JSON}}
```

## Binding rules

1. Judge ONLY against the committed criteria above. Do not introduce criteria
   of your own, and do not reward qualities outside the list, however
   impressive they seem.
2. An argument without an explicit anchor must be discarded: it must not
   influence your vote in either direction. An argument is a claim of merit
   for one of the ideas; an anchored argument is a statement line carrying an
   anchor tag of the form "[anchor: literature -> reference]" or
   "[anchor: computation -> reference]". If the tag is missing, empty, or
   malformed, treat the argument as unanchored, discard it, and count it.
   Report the total number of discarded unanchored arguments across both
   statements in unanchored_arguments_discarded. Statement lines that admit a
   weakness of their own idea are not merit claims and are not counted.
3. A tie is a legal outcome. Vote "tie" when the anchored evidence does not
   separate the two ideas under the committed criteria. Never force a winner
   for the sake of decisiveness.

Anchor references were content-vetted upstream; you are not asked to fetch
them. Weigh the substance of each anchored argument against each committed
criterion, for both ideas, then decide.

## Materials

### Idea A: card summary

{{CARD_SUMMARY_A}}

### Idea B: card summary

{{CARD_SUMMARY_B}}

### Advocacy statement for Idea A

{{STATEMENT_A}}

### Advocacy statement for Idea B

{{STATEMENT_B}}

## Required output

Reply with exactly one fenced JSON code block and nothing else. The object
must have exactly these three keys:

- "vote": "a", "b", or "tie".
- "anchored_arguments": the anchored arguments that most shaped your
  judgment, from either statement, each as an object with exactly
  "argument" (a short restatement in your words), "anchor_type"
  ("literature" or "computation"), and "anchor_ref" (the reference copied
  from the anchor tag). Typically two to six entries.
- "unanchored_arguments_discarded": integer count, zero or more.

Shape example (values are illustrative only):

```json
{
  "vote": "tie",
  "anchored_arguments": [
    {
      "argument": "short restatement of the decisive point",
      "anchor_type": "literature",
      "anchor_ref": "https://example.org/some-reference"
    }
  ],
  "unanchored_arguments_discarded": 0
}
```
