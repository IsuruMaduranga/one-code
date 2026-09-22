// The app's README is the root README with its repo-relative links made
// absolute: npm renders app/README.md as the @one-ai/one-code package page,
// where `docs/guide/…`, `demo/…` and `LICENSE` would resolve under app/ and
// 404. Run `npm run sync:app-readme` after editing README.md;
// test/unit/app-readme-sync.test.ts fails while the two are out of step.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "IsuruMaduranga/one-code";
const BLOB = `https://github.com/${REPO}/blob/master/`;
const RAW = `https://raw.githubusercontent.com/${REPO}/master/`;

/** A target that already names its host or scheme: `https:`, `mailto:`, `data:`, `//cdn…`. */
const ABSOLUTE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
const toBlob = (path) => (ABSOLUTE.test(path) ? path : BLOB + path);
const toRaw = (path) => (ABSOLUTE.test(path) ? path : RAW + path);

/** Rewrite the root README's relative links and images to absolute GitHub URLs. */
export function appReadmeFrom(rootReadme) {
	return rootReadme
		// Markdown images first: raw content, so the image renders.
		.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, path) => `![${alt}](${toRaw(path)})`)
		// Markdown links; anchors stay as they are.
		.replace(/\]\((?!#)([^)\s]+)\)/g, (_m, path) => `](${toBlob(path)})`)
		// HTML image sources (the demo GIF): raw content, so the image renders.
		.replace(/src="([^"]+)"/g, (_m, path) => `src="${toRaw(path)}"`);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const out = appReadmeFrom(readFileSync(join(root, "README.md"), "utf8"));
	writeFileSync(join(root, "app", "README.md"), out);
	console.log("app/README.md synced from README.md");
}
