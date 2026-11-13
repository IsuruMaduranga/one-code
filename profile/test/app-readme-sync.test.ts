import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS script without a declaration file
import { appReadmeFrom } from "../../scripts/app-readme.mjs";

const root = join(__dirname, "..", "..");

describe("app/README.md is the root README with absolute links", () => {
	it("matches `npm run sync:app-readme` output (run it after editing README.md)", () => {
		const expected = appReadmeFrom(readFileSync(join(root, "README.md"), "utf8"));
		expect(readFileSync(join(root, "app", "README.md"), "utf8")).toBe(expected);
	});

	it("leaves no repo-relative link or image for npm to break", () => {
		const app = readFileSync(join(root, "app", "README.md"), "utf8");
		expect(app).not.toMatch(/\]\((?![a-z][a-z\d+.-]*:|\/\/|#)[^)]+\)/i);
		expect(app).not.toMatch(/src="(?![a-z][a-z\d+.-]*:|\/\/)/i);
	});

	it("rewrites links to blob URLs and images (HTML or Markdown) to raw URLs", () => {
		const out = appReadmeFrom(
			'[g](docs/guide/README.md) [a](#x) [h](https://x.y) <img src="demo/a.gif"> ![shot](demo/b.png) [l](LICENSE)',
		);
		expect(out).toBe(
			'[g](https://github.com/IsuruMaduranga/one-code/blob/master/docs/guide/README.md) [a](#x) [h](https://x.y) ' +
				'<img src="https://raw.githubusercontent.com/IsuruMaduranga/one-code/master/demo/a.gif"> ' +
				"![shot](https://raw.githubusercontent.com/IsuruMaduranga/one-code/master/demo/b.png) " +
				"[l](https://github.com/IsuruMaduranga/one-code/blob/master/LICENSE)",
		);
	});

	it("leaves network-path and non-HTTP URI targets alone", () => {
		const src = '![c](//cdn.example/i.png) [m](mailto:a@b.c) <img src="data:image/png;base64,AA==">';
		expect(appReadmeFrom(src)).toBe(src);
	});
});
