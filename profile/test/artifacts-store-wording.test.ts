/** One Code's words for the artifact store: the size refusal and a listed artifact's line. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("artifact store wording", () => {
	const artifacts = () => requireText("artifacts");

	it("names the size of a page too large to publish", () => {
		const text = artifacts().publishProblem({ kind: "tooLarge", path: "/tmp/p.html", bytes: 16 * 1024 * 1024 + 1, maxBytes: 16 * 1024 * 1024 });
		expect(text).toMatch(/is 16\.0 MB; an artifact is at most 16 MB\./);
	});

	it("lists one artifact as its id, title, version, project and viewer link", () => {
		const line = artifacts().listLine({ id: "a-1", title: "Listed", version: 1, updated: "2026-09-27 10:00", project: "~/repo", url: "file:///store/a-1/view.html" });
		expect(line).toBe('- a-1: "Listed" (v1, updated 2026-09-27 10:00 UTC) [~/repo]\n  file:///store/a-1/view.html');
	});
});
