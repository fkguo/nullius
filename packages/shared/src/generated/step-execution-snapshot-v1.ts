/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Content-addressed provenance captured immediately before process spawn and immediately after process exit. The closure is declared and locked but is not claimed to be OS-syscall traced.
 */
export type StepExecutionSnapshotV1 =
  | PreSpawnStepExecutionSnapshot
  | PostExitStepExecutionSnapshot;
export type PreSpawnStepExecutionSnapshot = StepExecutionSnapshotBase & {
  phase: "pre_spawn";
  /**
   * @minItems 1
   */
  workspace_file_refs: [
    WorkspaceFileSnapshotEntry,
    ...WorkspaceFileSnapshotEntry[],
  ];
  [k: string]: unknown;
};
export type PostExitStepExecutionSnapshot = StepExecutionSnapshotBase & {
  phase: "post_exit";
  /**
   * @minItems 1
   */
  workspace_file_refs: [
    WorkspaceFileSnapshotEntry,
    ...WorkspaceFileSnapshotEntry[],
  ];
  output_refs: WorkspaceFileSnapshotEntry[];
  [k: string]: unknown;
};

export interface StepExecutionSnapshotBase {
  schema_version: 1;
  phase?: "pre_spawn" | "post_exit";
  step_id: string;
  captured_at: string;
  manifest_ref: WorkspaceFileSnapshotEntry;
  script_ref: WorkspaceFileSnapshotEntry;
  runtime_identity: NativeRuntimeIdentityV1;
  execution_environment: ProductionEnvironment;
  /**
   * @minItems 1
   */
  workspace_file_refs?: [
    WorkspaceFileSnapshotEntry,
    ...WorkspaceFileSnapshotEntry[],
  ];
  external_dependency_refs?: ExternalDependencySnapshotEntryV1[];
  output_refs?: WorkspaceFileSnapshotEntry[];
  external_dependency_closure: "declared_and_locked_not_syscall_traced";
}
export interface WorkspaceFileSnapshotEntry {
  relative_path: string;
  sha256: string;
  size_bytes: number;
}
export interface NativeRuntimeIdentityV1 {
  requested_token: string;
  canonical_path: string;
  sha256: string;
  size_bytes: number;
  executable_format: "elf" | "mach_o" | "pe";
}
export interface ProductionEnvironment {
  policy: "nullius_production_allowlist_v1";
  variables: {
    [k: string]: string;
  };
  sha256: string;
}
export interface ExternalDependencySnapshotEntryV1 {
  canonical_path: string;
  sha256: string;
  size_bytes: number;
}
