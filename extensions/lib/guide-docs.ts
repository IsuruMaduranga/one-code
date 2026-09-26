/**
 * Where the documentation the `one-code-guide` agent reads lives on this
 * machine: One Code's own user guide (`docs/guide/`, shipped in the npm
 * package next to `extensions/`) and the running pi's `docs/` and `examples/`
 * (pi's `getDocsPath()`/`getExamplesPath()`, which name the host pi's copies in
 * both install shapes; findings §6).
 *
 * The permissions extension makes these directories readable without a prompt
 * (never writable), so the guide agent can read them on any model tier.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocsPath, getExamplesPath } from "@earendil-works/pi-coding-agent";

/** One Code's user guide, `<package>/docs/guide`; its `README.md` is the index. */
export const ONE_CODE_GUIDE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "guide");

export interface GuideDocs {
	/** One Code's user guide. */
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
	return { guide: ONE_CODE_GUIDE_DIR, piDocs: existing(getDocsPath), piExamples: existing(getExamplesPath) };
}

/** The directories as a list, for the permission gate's read-only roots. */
export function guideDocsDirs(docs: GuideDocs = guideDocs()): string[] {
	return [docs.guide, docs.piDocs, docs.piExamples].filter((dir): dir is string => !!dir && existsSync(dir));
}
