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
- The cited work has a canonical reference database for this kind of
  quantity but no call to that database appears in the transcript
  (HEP particle property → no `pdg_*` call; HEP experiment data point
  → no `hepdata_*` call; ML benchmark accuracy → no version-pinned
  dataset reference + metric definition lookup).
- Two papers' results are compared in prose but never aligned through
  a measurement-conflict check.

**Minimum disconfirming check.** The general rule is **domain-neutral**:
for each cited numeric value, open the specific table, equation, or
figure in the source and quote the value plus its uncertainty exactly.
The *additional* check depends on whether the cited work's discipline
has a canonical reference database:

- **HEP particle properties** (mass, lifetime, branching fraction,
  decay width, etc.) → verify against the current PDG record via
  `pdg_get` / `pdg_get_measurements` / `pdg_get_property`, and
  record the PDG year/edition that was checked.
- **HEP experiment data points** (cross sections, asymmetries, etc.
  with HEPData submissions) → fetch the table via `hepdata_get_table`
  and confirm the cited number matches the entry exactly.
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
  paper's specific table or figure; if a community database exists
  (PDB, ICSD, etc.) verify against it. Treat third-party reviews as
  candidates, not authority.

**Cross-paper tension detection.** When two HEP papers' results are
compared, `inspire_detect_measurement_conflicts` is the HEP-specific
tool. For non-HEP comparisons the discipline check is the same general rule:
align units, methodology, and uncertainty conventions before claiming
agreement or tension.

**Required evidence calls.** For each cited numeric value: the
content-fetch call appropriate to the paper's discipline (see [M2](m2-citations.md)),
plus the canonical-database call if one applies to that quantity's
class. PDG / HEPData calls are *only* required when the quantity is
in their scope; not having one for an ML benchmark is correct, not a
gap.
