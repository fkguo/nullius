/**
 * Automatically augments `select` fields to always include required fields.
 *
 * When a `select` param is provided for works entities, `id` and `doi` are
 * always included to guarantee downstream composition (INSPIRE resolution,
 * Zotero import, etc.). For other entities, only `id` is guaranteed.
 */

/**
 * Augment a select string to include required fields for the given entity.
 * If select is undefined, returns undefined (no augmentation, all fields returned).
 */
export function augmentSelect(select: string | undefined, entity: string): string | undefined {
  if (!select) return select;
  const fields = select.split(',').map(f => f.trim()).filter(Boolean);
  const required = entity === 'works' ? ['id', 'doi'] : ['id'];
  for (const req of required) {
    if (!fields.includes(req)) fields.unshift(req);
  }
  return fields.join(',');
}
