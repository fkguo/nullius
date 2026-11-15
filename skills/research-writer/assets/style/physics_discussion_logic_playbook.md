# Physics discussion guidance

Use these questions and examples to improve a scientific argument after reading
its evidence. Select the parts relevant to the research question and audience;
there is no required order, paragraph count or universal uncertainty recipe.
These are writing aids, not measured consensus from a corpus or acceptance rules.

## The argument

State the physical question and what the current work establishes. Explain which
assumptions and constraints make that inference possible, and which observable or
quantity is actually determined. Connect the result to its physical mechanism
when the evidence permits that interpretation. Distinguish a mechanism supported
by diagnostics from a plausible explanation still requiring a test.

For a precision result, identify the precision target and the obstacle that
limits it. For a conceptual result, prioritize the logical distinction, theorem,
counterexample or physical effect over an artificial numerical headline. Choose
section structure and notation to make that particular argument easy to assess.

## Useful diagnostic questions

- **Method transfer:** when importing a technique from another problem, which
  benchmark or limit validates its use here? What new dependence or assumption
  appears in the transfer?
- **Regimes and matching:** are the natural energy/scale regimes and their
  overlap explicit? Does a matching test expose missing contributions or merely
  vary an arbitrary parameter? State scheme and scale conventions where needed.
- **Mechanism isolation:** what control or counterfactual can distinguish the
  proposed cause from a correlated change? Keep confounders fixed when making
  that comparison.
- **Shift attribution:** if a result differs from an earlier one, can the shift
  be traced to specific changed inputs, definitions or approximations? Do not
  infer attribution from the sign of the final difference alone.
- **Uncertainty:** what uncertainty is estimated, by what justified procedure,
  with which correlations and omissions? A spread under chosen variations is
  not automatically a statistical or systematic error bar.
- **Measurement versus extraction:** distinguish raw measurements from quantities
  reconstructed using model assumptions. Direct a comparison at commensurate
  quantities and conventions.
- **Independent routes:** when two calculations agree, which assumptions or data
  do they share? Explain the degree of independence and investigate discrepancies;
  do not automatically label the spread a systematic uncertainty.
- **Global consistency:** when several observables constrain a solution, test
  compatibility beyond the fitted channel. Localize tensions and consider
  alternative explanations.
- **Inference sensitivity:** choose variations that interrogate a specific
  assumption, fit range, prior or approximation. Explain why their range is
  scientifically informative.
- **Next experiment or calculation:** identify the remaining uncertainty or
  logical gap whose resolution would change the conclusion. Describe a concrete
  test and the result that would count against the current interpretation.

## Results, figures and limitations

Use the evidence needed for the claim. A figure should carry a stated inference,
with quantity definitions, units and data/model identities visible. Show the
baseline or diagnostic that makes its interpretation possible. Move detail to an
appendix when it aids readability, while keeping enough in the main text to
assess the conclusion.

Explain limitations in their actual scope. A cited source's statement, a checked
calculation, an assumption and an untested interpretation have different status.
Record unresolved load-bearing steps and the checks needed to resolve them;
avoid upgrading an unchecked claim merely because it has a reference.

## Learning from source papers

The existing `fetch_prl_style_corpus.py` and
`research_writer_learn_discussion_logic.py` can acquire papers and prepare
reading packs. Packs and optional model argument maps are navigation/analysis
inputs. Open the underlying sources to assess their arguments.

For each lesson, keep a source locator and explain the inference it helps make.
When synthesizing across papers, compare assumptions, argument structure and
counterexamples. Similar vocabulary does not establish agreement; absent terms
do not establish disagreement. Preserve conflicting cases when they reveal the
limits of a lesson. Do not copy distinctive phrasing or promote a model's
summarized lesson to a corpus-wide finding without checking the sources.

See [the style profile](style_profile.md) for optional writing conventions and
[corpus acquisition notes](prl_style_corpus.md) for retrieval details.
