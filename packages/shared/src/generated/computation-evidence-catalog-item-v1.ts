/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * A single entry in computation_evidence_catalog_v1.jsonl. Records the outputs of a hep-calc skill run, keyed by source identifiers. Intentionally distinct from EvidenceCatalogItemV1 (which requires paper_id + LatexLocatorV1 and is LaTeX-only). Computation evidence does not have a paper_id and uses artifact paths + SHA-256 instead of LaTeX locators.
 */
export interface ComputationEvidenceCatalogItemV1 {
  /**
   * Schema version, always 1 for this schema.
   */
  schema_version: 1;
  /**
   * ID of the orchestrator run that produced these artifacts.
   */
  run_id: string;
  /**
   * ID of the specific computation step within the run (matches manifest step.id).
   */
  step_id: string;
  /**
   * Identifier of the hep-calc skill that produced the artifacts (e.g. 'hep-calc/mathematica-feyncalc').
   */
  skill_id: string;
  /**
   * Artifact files produced by this computation step, with SHA-256 integrity checksums.
   *
   * @minItems 1
   */
  artifacts: [
    {
      /**
       * Path to the artifact file, relative to run_dir or as an ArtifactRef URI (artifact://<run_id>/<step_id>/<filename>).
       */
      path: string;
      /**
       * SHA-256 hex digest of the artifact file (64 lowercase hex characters).
       */
      sha256: string;
      /**
       * Human-readable description of what this artifact contains.
       */
      description?: string;
    },
    ...{
      /**
       * Path to the artifact file, relative to run_dir or as an ArtifactRef URI (artifact://<run_id>/<step_id>/<filename>).
       */
      path: string;
      /**
       * SHA-256 hex digest of the artifact file (64 lowercase hex characters).
       */
      sha256: string;
      /**
       * Human-readable description of what this artifact contains.
       */
      description?: string;
    }[],
  ];
  /**
   * SHA-256 hex digest of the computation_manifest_v1.json file used for this computation. Provides a cryptographic pointer back to the exact computation specification.
   */
  manifest_sha256?: string;
  /**
   * ISO 8601 UTC timestamp when this entry was ingested via hep_run_ingest_skill_artifacts.
   */
  ingested_at: string;
  /**
   * Optional classification tags (e.g. ['feyncalc', 'one-loop', 'SMEFT']).
   *
   * @maxItems 20
   */
  tags?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  /**
   * Optional free-text notes about this computation result.
   */
  notes?: string;
}
