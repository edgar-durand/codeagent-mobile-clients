/**
 * Superseded Box-image collection for `fleet_prune_host` (fleet-1, 2026-10-02).
 *
 * WHY THIS EXISTS. The daily prune was `docker image prune -f` (dangling only),
 * which can never touch a TAGGED image. A hand-built `codeam-box:fix` (7 GB)
 * sat on fleet-1 for two months that way. This module plans which Box images
 * may go, so the handler can remove them by name.
 *
 * The rule: keep the CURRENT Box image (what `:latest` resolves to) plus ONE
 * previous release for rollback, and never anything a container references.
 * Everything else that carries a Box tag is superseded.
 *
 * The rollback image usually has NO tag: a `docker pull` that moves `:latest`
 * leaves the old image untagged, i.e. dangling, and the dangling prune that runs
 * next would delete it. So the plan names it and the handler tags it
 * `<repo>:rollback` BEFORE that prune runs. Under the containerd image store
 * a dangling image also loses its RepoDigests, so the only link back to the Box
 * repo is its layers: an untagged image that shares the Box base layer is
 * treated as a Box release. That guess only decides which image gets KEPT; the
 * untagged images it skips are ones the dangling prune removes anyway.
 *
 * ⚠️ The planner never returns a non-Box tag, the current image, or a
 * referenced image for removal. Docker refuses `rmi` (without `-f`, which the
 * handler never passes) on an image a container uses, STOPPED ones included,
 * so a referenced image is protected twice.
 */

/** One `docker image inspect` row, parsed. */
export interface FleetImageInfo {
  id: string;
  /** RFC 3339, from `.Created` (the build time, so it orders releases). */
  created: string;
  repoTags: string[];
  layers: string[];
}

export interface FleetImageGcPlan {
  /** The previous release we keep for rollback, if there is one. */
  rollback?: { id: string; tagAs?: string };
  /** Box tags to `docker rmi` (by tag, so a non-Box tag on the same image survives). */
  removeTags: string[];
}

/** The tag that pins the kept previous release against the dangling prune. */
export const FLEET_ROLLBACK_TAG = 'rollback';

/** The `docker image inspect --format` template {@link parseFleetImageInspect} reads. */
export const FLEET_IMAGE_INSPECT_FORMAT =
  '{{.Id}}|{{.Created}}|{{join .RepoTags ","}}|{{join .RootFS.Layers ","}}';

/** `ghcr.io/x/codeam-box:latest` → `ghcr.io/x/codeam-box`; tolerates a registry port. */
export function repoOfImageRef(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon > ref.lastIndexOf('/') ? ref.slice(0, colon) : ref;
}

export function parseFleetImageInspect(stdout: string): FleetImageInfo[] {
  const out: FleetImageInfo[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length !== 4 || !parts[0].startsWith('sha256:')) continue;
    const [id, created, tags, layers] = parts;
    out.push({
      id,
      created,
      repoTags: tags ? tags.split(',').filter((t) => t && t !== '<none>:<none>') : [],
      layers: layers ? layers.split(',') : [],
    });
  }
  return out;
}

export function planFleetBoxImageGc(input: {
  images: FleetImageInfo[];
  /** Full image ids every container (any state) was created from. */
  referenced: ReadonlySet<string>;
  /** The full id `:latest` resolves to. */
  currentId: string;
  /** The image reference boxes are created from, e.g. `ghcr.io/x/codeam-box:latest`. */
  currentRef: string;
}): FleetImageGcPlan {
  const { images, referenced, currentId, currentRef } = input;
  const current = images.find((i) => i.id === currentId);
  if (!current) return { removeTags: [] };

  const currentRepo = repoOfImageRef(currentRef);
  // `codeam-box` is the local name hand builds on the host have used (`:fix`).
  const boxRepos = new Set([currentRepo, 'codeam-box']);
  const boxTagsOf = (img: FleetImageInfo): string[] =>
    img.repoTags.filter((t) => boxRepos.has(repoOfImageRef(t)));
  const baseLayer = current.layers[0];
  const isBox = (img: FleetImageInfo): boolean =>
    boxTagsOf(img).length > 0 ||
    (img.repoTags.length === 0 && !!baseLayer && img.layers[0] === baseLayer);

  const previous = images
    .filter((i) => i.id !== currentId && isBox(i))
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const rollback = previous[0];

  const rollbackTag = `${currentRepo}:${FLEET_ROLLBACK_TAG}`;
  const tagAs = rollback && boxTagsOf(rollback).length === 0 ? rollbackTag : undefined;
  const removeTags: string[] = [];
  for (const img of previous.slice(1)) {
    if (referenced.has(img.id)) continue;
    for (const tag of boxTagsOf(img)) {
      // When the handler is about to MOVE the rollback tag, that move already
      // untags the old holder; an explicit rmi of the name could land after
      // the move and strip it from the new rollback image.
      if (tagAs && tag === rollbackTag) continue;
      removeTags.push(tag);
    }
  }

  return {
    rollback: rollback ? { id: rollback.id, ...(tagAs ? { tagAs } : {}) } : undefined,
    removeTags,
  };
}
