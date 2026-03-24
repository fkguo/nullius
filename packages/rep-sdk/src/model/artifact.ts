export interface ArtifactRef {
  uri: string;
  kind?: string;
  schema_version?: number;
  sha256: string;
  size_bytes?: number;
  produced_by?: string;
  created_at?: string;
}
