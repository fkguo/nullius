/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * This interface was referenced by `MigrationRegistryV1`'s JSON-Schema
 * via the `definition` "MigrationOperation".
 */
export type MigrationOperation = {
  /**
   * Operation type.
   */
  op: "add_field" | "remove_field" | "rename_field" | "set_field";
  /**
   * Dot-path to the target field.
   */
  path?: string;
  /**
   * Value for add_field / set_field operations.
   */
  value?:
    | string
    | number
    | boolean
    | {
        [k: string]: unknown;
      }
    | unknown[]
    | null;
  /**
   * Source path for rename_field operations.
   */
  from_path?: string;
};

/**
 * Registry of schema migration chains. Each entry describes how to migrate artifacts from one schema version to another.
 */
export interface MigrationRegistryV1 {
  /**
   * Registry format version.
   */
  version: 1;
  /**
   * Migration chains, one per schema.
   */
  chains: MigrationChain[];
}
/**
 * This interface was referenced by `MigrationRegistryV1`'s JSON-Schema
 * via the `definition` "MigrationChain".
 */
export interface MigrationChain {
  /**
   * Identifier matching the schema filename stem (e.g. 'artifact_ref_v1').
   */
  schema_id: string;
  /**
   * Current (latest) schema version number.
   */
  current_version: number;
  /**
   * Ordered list of version-to-version migration steps.
   */
  migrations: MigrationStep[];
}
/**
 * This interface was referenced by `MigrationRegistryV1`'s JSON-Schema
 * via the `definition` "MigrationStep".
 */
export interface MigrationStep {
  /**
   * Source version number.
   */
  from_version: number;
  /**
   * Target version number.
   */
  to_version: number;
  /**
   * Ordered list of field-level operations to apply.
   */
  operations: MigrationOperation[];
}
