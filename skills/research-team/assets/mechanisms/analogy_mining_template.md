# Analogy Mining (cross-domain structural analogy template)

Project: <PROJECT_NAME>  
Owner: <YOUR_NAME>  
Date: <YYYY-MM-DD>  
Profile: `<PROFILE>` (options: `theory_only | numerics_only | mixed | exploratory | literature_review | methodology_dev | custom`)

Goal: turn “this feels like X” into an auditable mapping:
Structure Signature → Candidate Source Domains → Minimal Literature Anchors → Mapping Table → Minimal Validation → Claim DAG entry (with fail-fast).

---

## How to use (bind into the main workflow)

- Turn “minimal literature anchors” into real KB notes under `knowledge_base/literature/` (each anchor should eventually have a KB note + external link).
- Register “minimal validation” outputs as Evidence (paths must exist), and cite them in the next team packet.
- Only promote an analogy into the main derivation chain if it becomes a falsifiable claim (with thresholded kill criteria). Otherwise keep it as an exploration note.

## 0) Structure Signature

Describe the *structure* (not the vocabulary) of your problem:

- State variables / object types: `<fields/operators/distributions/...>`
- Constraints / symmetries / invariants: `<symmetries/invariants/constraints>`
- Small parameters / scaling regimes: `<epsilon, lambda, scaling regimes>`
- Typical equation form: `<PDE/ODE/integral equation/variational principle>`
- Key singular / non-analytic structures: `<poles/branch cuts/turning points/boundary layers>`
- Outputs / diagnostics: `<observables/diagnostics>`

## 1) Candidate Source Domains

List 3–7 candidate “source domains / classic models / mathematical structures”, and one sentence why each matches the signature:

| Candidate | Why it matches signature | What would falsify quickly? |
|---|---|---|
|  |  |  |

## 2) Minimal Literature Anchors

For each candidate, provide at least one anchor (bibkey/link/book chapter). Later, materialize into `knowledge_base/literature/` notes.

- Candidate A anchor:
- Candidate B anchor:

## 3) Mapping Table

Map “source domain” objects to “target problem” objects. Each row must be testable (derivable / computable / checkable vs a reference).

| Source object | Target object | Mapping rule | Scope/assumptions | Test |
|---|---|---|---|---|
|  |  |  |  |  |

## 4) Minimal Validation

Do only 1–3 minimal validations first (fail-fast):

- V1 (consistency/limit/dimension/sign): `<what you check, expected pass/fail>`
- V2 (toy model / numeric sanity): `<...>`
- V3 (reference cross-check): `<...>`

Register validation outputs as Evidence (paths must exist):
- `knowledge_graph/evidence_manifest.jsonl`: add entries with `type=analogy_validation`

## 5) Write into the Claim DAG (minimum requirement)

If the analogy passes minimal validation (or is at least not falsified), write it as a clear claim:

- Claim statement (falsifiable):
- Dependencies (requires which existing claims/priors):
- Kill criteria (at least one; include a threshold):
- Linked trajectories (this run tag):

Write to:
- `knowledge_graph/claims.jsonl`
- `knowledge_graph/edges.jsonl` (connect with `supports/requires/competitor/contradicts`, etc.)

## 6) Fail-fast checklist (must tick)

If any item below is true, stop investment immediately or fork into a competing hypothesis:

- [ ] The mapping relies on word similarity rather than structural equivalence
- [ ] Dimensions/scaling cannot be aligned for key quantities
- [ ] A clear counterexample appears in V1/V2/V3
- [ ] The analogy only explains known facts but makes no discriminating prediction

