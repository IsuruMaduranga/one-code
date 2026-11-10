/**
 * Where the documentation the profile's guide agent reads lives on this
 * machine: the product's own user guide (the brand's `guideDir`, shipped in
 * the npm package) and the running pi's `docs/` and `examples/`
 * (pi's `getDocsPath()`/`getExamplesPath()`, which name the host pi's copies in
 * both install shapes; findings §6).
 *
 * The permissions extension makes these directories readable without a prompt
 * (never writable), so the guide agent can read them on any model tier.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDocsPath, getExamplesPath } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../core/package-root.ts";
import { guideDir } from "../profile/brand.mjs";

/** The product's user guide (the brand's `guideDir`; One Code's is `<package>/docs/guide`); its `README.md` is the index. A product may ship none. */
export const GUIDE_DIR = join(PACKAGE_ROOT, ...guideDir.split("/"));

export interface GuideDocs {
	/** The product's user guide; the folder is missing when the product ships none. */
	guide: string;
	/** The running pi's docs (extensions, packages, settings, …); undefined when not found. */
	piDocs?: string;
	/** The running pi's examples (extensions among them); undefined when not found. */
	piExamples?: string;
}

function existing(read: () => string): string | undefined {
	try {
		const dir = read();
		return existsSync(dir) ? dir : undefined;
	} catch {
		return undefined;
	}
}

export function guideDocs(): GuideDocs {
	return { guide: GUIDE_DIR, piDocs: existing(getDocsPath), piExamples: existing(getExamplesPath) };
}

/** The directories that exist, for the permission gate's read-only roots. */
export function guideDocsDirs(docs: GuideDocs = guideDocs()): string[] {
	return [existsSync(docs.guide) ? docs.guide : undefined, docs.piDocs, docs.piExamples].filter((dir): dir is string => !!dir);
}
