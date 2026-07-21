/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Computation contract schema (UX-02). Standardizes the interface between research-team computation planning and hep-calc execution. A manifest.json at the root of a computation/ directory must conform to this schema.
 */
export interface ComputationManifestV1 {
  /**
   * Schema version, always 1 for this schema.
   */
  schema_version: 1;
  /**
   * Human-readable title for this computation manifest.
   */
  title?: string;
  /**
   * Brief description of what this computation does.
   */
  description?: string;
  /**
   * Primary execution entry point.
   */
  entry_point: {
    /**
     * Relative path to the main entry script (e.g. 'mathematica/run_all.wl', 'python/main.py').
     */
    script: string;
    /**
     * Tool/interpreter used to run the entry script.
     */
    tool?: "mathematica" | "julia" | "python" | "bash";
    /**
     * Command-line arguments passed to the entry script.
     */
    args?: string[];
    /**
     * Explicit runtime-specific variables accepted by the Nullius production allowlist. Nullius fixed safety variables and loader, module, project, depot, library-path, and shell-startup selectors are rejected.
     */
    env?: {
      [k: string]: string;
    };
  };
  /**
   * Ordered or dependency-resolved execution steps.
   *
   * @minItems 1
   */
  steps: [
    {
      /**
       * Unique step identifier within this manifest.
       */
      id: string;
      /**
       * Human-readable description of what this step does.
       */
      description?: string;
      /**
       * Tool/interpreter for this step.
       */
      tool: "mathematica" | "julia" | "python" | "bash";
      /**
       * Relative path to the script for this step.
       */
      script?: string;
      /**
       * Arguments passed to the script.
       */
      args?: string[];
      /**
       * Explicit runtime-specific variables accepted by the Nullius production allowlist. Host environment is never inherited; fixed safety variables and loader, module, project, depot, library-path, and shell-startup selectors are rejected.
       */
      env?: {
        [k: string]: string;
      };
      /**
       * Relative paths to files this step is expected to produce.
       */
      expected_outputs?: string[];
      /**
       * Step IDs that must complete before this step runs.
       */
      depends_on?: string[];
      /**
       * Per-step timeout in minutes.
       */
      timeout_minutes?: number;
    },
    ...{
      /**
       * Unique step identifier within this manifest.
       */
      id: string;
      /**
       * Human-readable description of what this step does.
       */
      description?: string;
      /**
       * Tool/interpreter for this step.
       */
      tool: "mathematica" | "julia" | "python" | "bash";
      /**
       * Relative path to the script for this step.
       */
      script?: string;
      /**
       * Arguments passed to the script.
       */
      args?: string[];
      /**
       * Explicit runtime-specific variables accepted by the Nullius production allowlist. Host environment is never inherited; fixed safety variables and loader, module, project, depot, library-path, and shell-startup selectors are rejected.
       */
      env?: {
        [k: string]: string;
      };
      /**
       * Relative paths to files this step is expected to produce.
       */
      expected_outputs?: string[];
      /**
       * Step IDs that must complete before this step runs.
       */
      depends_on?: string[];
      /**
       * Per-step timeout in minutes.
       */
      timeout_minutes?: number;
    }[],
  ];
  /**
   * Runtime environment requirements.
   */
  environment: {
    /**
     * Minimum required Wolfram Mathematica version (e.g. '13.3').
     */
    mathematica_version?: string;
    /**
     * Minimum required Julia version (e.g. '1.9').
     */
    julia_version?: string;
    /**
     * Minimum required Python version (e.g. '3.11').
     */
    python_version?: string;
    /**
     * Target platform constraint.
     */
    platform?: "any" | "linux" | "macos" | "windows";
    /**
     * Free-text notes about the execution environment.
     */
    notes?: string;
  };
  /**
   * Software and data dependencies.
   */
  dependencies: {
    /**
     * Required Mathematica packages (e.g. ['FeynCalc', 'FeynArts', 'LoopTools']).
     */
    mathematica_packages?: string[];
    /**
     * Required Julia packages (e.g. ['LoopTools']).
     */
    julia_packages?: string[];
    /**
     * Required Python packages with optional version constraints (e.g. ['numpy>=1.24', 'scipy']).
     */
    python_packages?: string[];
    /**
     * External C/Fortran libraries required (e.g. ['LoopTools-2.15', 'COLLIER-1.2']).
     */
    external_libraries?: string[];
    /**
     * Workspace-relative data files copied into the computation workspace and included in its adjacent snapshots. Absolute paths and URIs are not accepted here; use external_dependency_refs for content-addressed external files.
     */
    data_files?: string[];
    /**
     * Workspace-relative lock or environment files whose content pins declared package and library dependencies.
     */
    lock_files?: string[];
    /**
     * Explicit content-addressed local dependency files outside the computation workspace. Every path must be absolute so its meaning never depends on the caller working directory. Each file is live-rehashed before and after every step and at decisive verification.
     */
    external_dependency_refs?: {
      path: string;
      sha256: string;
      size_bytes?: number;
    }[];
  };
  /**
   * Resource budget for this computation.
   */
  computation_budget?: {
    /**
     * Estimated wall-clock runtime in minutes.
     */
    estimated_runtime_minutes?: number;
    /**
     * Hard timeout in minutes (computation aborts if exceeded).
     */
    max_runtime_minutes?: number;
    /**
     * Maximum RAM usage in GB.
     */
    max_memory_gb?: number;
    /**
     * Maximum number of CPU cores to use.
     */
    max_cpu_cores?: number;
    /**
     * Maximum disk space for outputs in GB.
     */
    max_disk_gb?: number;
    /**
     * Free-text notes about resource requirements.
     */
    notes?: string;
  };
  /**
   * Top-level output files produced by this manifest (relative paths).
   */
  outputs?: string[];
  /**
   * ISO 8601 UTC timestamp when this manifest was created.
   */
  created_at?: string;
}
