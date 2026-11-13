Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### M3: hallucinated_measurement_or_result

**Definition.** A numerical value — a measured constant, a rate or
ratio, a fit parameter, a benchmark accuracy, a sample size,
a p-value, a simulation parameter — cited without verifying it against
the cited source's actual table, equation, or figure.

**Signs.**
- Value looks "about right" from memory; uncertainty is absent or
  stated with the wrong number of significant digits.
- A cited measurement does not name the specific table, equation, or
  figure it came from in the source.
- A current reference value, world average or database-derived data point
  has no checked official edition/release, record or table. A provider call
  alone does not establish that its local database is current.
- Two papers' results are compared without checking their observable
  definitions, conditions, units and uncertainty conventions in the sources.

**Minimum disconfirming check.** The general rule is **domain-neutral**:
for each cited numeric value, open the specific table, equation, or
figure in the source and quote the value plus its uncertainty exactly.
Match any additional database check to the claim being made. For a specific
historical measurement, check that paper's reported result and definitions;
a later world average neither replaces it nor establishes its comparability.
Consult a database when using its data or reference value, or when it helps
resolve the source's identity or applicable corrections:

- **HEP particle property reference values** (mass, lifetime, branching
  fraction, decay width, etc.) → inspect the applicable PDG edition, record
  and notes via `pdg_get` / `pdg_get_measurements` / `pdg_get_property`, or
  the official published tables. Record the edition actually read. A claim
  of the current value additionally requires checking that edition's currency.
- **HEP experiment data taken from HEPData** → read the official release and
  table, using `hepdata_get_table` or its published data files; check row,
  qualifiers, units and uncertainty components as well as the numeric value.
- **ML / DL benchmark results** → verify against the cited paper's
  specific dataset version, metric definition, evaluation split, and
  hyperparameter table. There is no centralized canonical reference;
  the paper's own §experiments / §results section *is* the canonical
  source.
- **Astrophysics / cosmology observations** → verify against the
  cited survey release version (e.g. DR-N), the calibration pipeline
  version, and the specific catalogue table — the survey
  documentation, not a third-party summary, is the canonical source.
- **Condensed-matter / chemistry / biology / etc.** → trace to the
  paper's specific table or figure; when adopting a community-database
  value (PDB, ICSD, etc.), check its applicable release and record.
  Treat third-party reviews as candidates, not authority.

**Cross-paper numerical comparison.** Read the relevant source tables,
equations and definitions, including headers and footnotes. Record each
quantity's observable, conditions, units, uncertainty components and source
locator. A downloaded path or parsed excerpt is a pointer to inspect, not
proof that the source was read. Preserve asymmetric errors, limits and shared
inputs; establish comparability and the treatment of correlations before
computing a difference or combination with existing numerical execution.
When definitions or covariance remain unresolved, state what cannot be
compared. No comparable pair does not establish agreement, and agreement
alone does not justify a weighted average. Keep any independence or Gaussian
approximation explicit in the reported calculation.

**Required source evidence.** For each adopted value, retain the source
identity/version, location, original value and uncertainty, and the material
actually read (see [M2](m2-citations.md)). Official source files already read,
published database tables and provider retrievals can supply this evidence;
a particular tool name is not required. If the source needed for a claim is
unavailable, state the limitation and do not substitute memory, a secondary
summary or an unrelated current average. Additional lookups should resolve
a concrete identity, correction or reference-value question.
