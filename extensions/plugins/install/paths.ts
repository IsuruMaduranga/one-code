/**
 * Plugin cache path construction + containment checks (pure).
 *
 * Installed plugin files live in `<root>/cache/<marketplace>/<plugin>/<version>/`
 * with every segment sanitized — marketplace manifests are third-party content,
 * so entry names must never be able to place files outside the cache, and
 * `./relative` plugin sources must never read outside their marketplace clone.
 */

import { join } from "node:path";
import { pathWithinBase, sanitizePathSegment } from "../../lib/plugin-root.ts";

export function versionedCachePath(root: string, marketplace: string, plugin: string, version: string): string {
	return join(
		root,
		"cache",
		sanitizePathSegment(marketplace),
		sanitizePathSegment(plugin),
		sanitizePathSegment(version, true),
	);
}

/** True when `target` resolves inside `base` (rejects .. escapes and absolute overrides). */
export const withinBase = pathWithinBase;
