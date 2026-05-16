/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
export interface PaperManifestV2 {
  /**
   * 1 = legacy manifest (version always 1, parent_version and review_ref always null). 2 = versioned manifest with real version, parent_version, and review_ref.
   */
  schemaVersion: 1 | 2;
  version: number;
  parent_version: number | null;
  review_ref: string | null;
  [k: string]: unknown;
}
