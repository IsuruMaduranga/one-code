/**
 * Reads the one-code-extension package version from its own package.json so the
 * banner never hardcodes (and drifts from) the released version.
 *
 * The bundled app sets CC_VERSION to the app package version, which is kept in
 * lockstep with this package (working-docs/decisions/distribution.md). When the
 * extension is loaded directly via plain `pi` there is no CC_VERSION, so this
 * reads the extension's own package.json instead of falling back to a stale
 * literal.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../core/package-root.ts";

/**
 * Version from the extension's package.json (lib/core/package-root.ts). Returns "0.0.0" only if the file is somehow unreadable, so a bad
 * read is visibly wrong rather than silently masquerading as a real release.
 */
export function extensionVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			version?: unknown;
		};
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}
