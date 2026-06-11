import * as crypto from 'crypto';

/**
 * Derive a stable, unique, bd/SQL-safe **prefix** (= shared-server database
 * name) from a `projectKey` (D7 → D16). Under bd shared-server mode, "each
 * project on a shared server must have a unique prefix (database name)" and
 * per-repo isolation is achieved entirely by that name — so this prefix is the
 * mechanism that scopes one repo's issues + memories away from another's.
 *
 * Requirements:
 *   - **stable**: same `projectKey` → same prefix on every machine/clone (the
 *     key is the normalized git origin, so the laptop and the codespace agree).
 *   - **unique**: different keys must never collide → an 8-char sha256 suffix.
 *   - **bd/SQL-safe**: a MySQL/Dolt database identifier — start with a letter,
 *     then `[a-z0-9_]`, bounded length.
 *
 * Shape: `<slug(repo-name)>_<sha8(projectKey)>`, e.g.
 *   `github.com/edgar-durand/codeagent-mobile` → `codeagent_mobile_3f9a1c02`.
 */
export function prefixForProjectKey(projectKey: string): string {
  const tail = projectKey.split('/').pop() ?? projectKey;
  let slug = tail
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  // Must start with a letter (DB identifiers can't lead with a digit/underscore).
  if (!slug || !/^[a-z]/.test(slug)) slug = `p_${slug}`;
  slug = slug.replace(/_$/, '').slice(0, 24).replace(/_$/, '');
  const hash = crypto.createHash('sha256').update(projectKey).digest('hex').slice(0, 8);
  return `${slug}_${hash}`;
}
