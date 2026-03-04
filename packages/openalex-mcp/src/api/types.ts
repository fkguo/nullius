/**
 * Minimal OpenAlex API response types.
 * Only fields commonly used across tools are typed; additional fields pass through as unknown.
 */

export interface OpenAlexMeta {
  count: number;
  db_response_time_ms?: number;
  page?: number;
  per_page?: number;
  next_cursor?: string | null;
  groups_count?: number | null;
}

export interface OpenAlexListResponse<T> {
  meta: OpenAlexMeta;
  results: T[];
  group_by?: OpenAlexGroupByEntry[];
}

export interface OpenAlexGroupByEntry {
  key: string;
  key_display_name: string;
  count: number;
}

export interface OpenAlexAutocompleteResult {
  id: string;
  display_name: string;
  hint?: string;
  cited_by_count?: number;
  works_count?: number;
  entity_type?: string;
  external_id?: string;
}

export interface OpenAlexAutocompleteResponse {
  meta: { count: number; db_response_time_ms?: number };
  results: OpenAlexAutocompleteResult[];
}

/** Minimal Work entity (full schema has 50+ fields) */
export interface Work {
  id: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number;
  type?: string;
  open_access?: { is_oa?: boolean; oa_status?: string };
  [key: string]: unknown;
}

/** Generic entity type for non-Work entities */
export type OpenAlexEntity = Record<string, unknown> & { id: string };
