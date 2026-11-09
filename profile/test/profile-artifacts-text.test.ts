/**
 * One Code's artifact wording (profile/text/artifacts/) for what the golden
 * snapshot cannot reach: an opened browser, autoOpen off, a delete the user
 * answers, a long list, and the store's own failures, its size refusal and a
 * listed artifact's line. The golden snapshot pins the bytes of every other
 * artifact text.
 */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { artifactsText } from "../text/artifacts/index.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";

const artifacts = artifactsText(ALL_LIVE);

const page = { id: "report-a1b2c3", title: "Report", version: 1, created: true, url: "file:///s/view.html", file: "/s/index.html", galleryUrl: "file:///g.html" };

describe("One Code's artifact text", () => {
	it("words a publish whose browser opened, and one with autoOpen off", () => {
		expect(artifacts.published({ ...page, browser: { kind: "tried" } })).toBe(
			'Published "Report" as the artifact report-a1b2c3.\nLink: file:///s/view.html\nFile: /s/index.html\nOpened it in the user\'s default browser.\nGallery of all artifacts: file:///g.html',
		);
		expect(artifacts.published({ ...page, browser: { kind: "autoOpenOff", settingsPath: "~/.onecode/settings.json" } })).toContain(
			"Opening the browser is off (artifacts.autoOpen is false in ~/.onecode/settings.json). Give the user the link.",
		);
		expect(artifacts.opened({ url: "file:///v.html", failed: "noDisplay" })).toBe("file:///v.html\nNo browser was opened: no graphical display is available. Give the user the link.");
		expect(artifacts.noBrowserReason("launchFailed")).toBe("the browser could not be started");
	});

	it("words the user's answer to a delete and the store's failures", () => {
		expect(artifacts.deleteDeclined).toBe("The user declined; the artifact was not deleted.");
		expect(artifacts.deleteAborted).toBe("The operation was aborted; the artifact was not deleted.");
		expect(artifacts.deleted({ id: "report-a1b2c3", title: "Report" })).toBe('Deleted the artifact report-a1b2c3 ("Report").');
		expect(artifacts.publishProblem({ kind: "unknownId", id: "gone-1" })).toBe('Publishing failed: No artifact has the id "gone-1". Run the artifact tool with action "list" to see the ids.');
		expect(artifacts.publishProblem({ kind: "failed", osMessage: "EACCES" })).toBe("Publishing failed: EACCES");
		expect(artifacts.publishProblem({ kind: "insideStore", path: "/s/index.html" })).toMatch(/^\/s\/index\.html is inside the artifact store\./);
	});

	it("says how many a capped list left out", () => {
		const shown = [{ id: "a-1", title: "A", version: 2, updated: "2026-11-05 10:00", url: "file:///a" }];
		expect(artifacts.list({ total: 3, shown, galleryUrl: "file:///g" })).toBe(
			'3 artifacts, newest first:\n- a-1: "A" (v2, updated 2026-11-05 10:00 UTC)\n  file:///a\n(2 more not shown; raise `limit` to see them.)\nGallery: file:///g',
		);
	});
});

describe("artifact store wording", () => {
	const words = () => requireText("artifacts");

	it("names the size of a page too large to publish", () => {
		const text = words().publishProblem({ kind: "tooLarge", path: "/tmp/p.html", bytes: 16 * 1024 * 1024 + 1, maxBytes: 16 * 1024 * 1024 });
		expect(text).toMatch(/is 16\.0 MB; an artifact is at most 16 MB\./);
	});

	it("lists one artifact as its id, title, version, project and viewer link", () => {
		const line = words().listLine({ id: "a-1", title: "Listed", version: 1, updated: "2026-09-27 10:00", project: "~/repo", url: "file:///store/a-1/view.html" });
		expect(line).toBe('- a-1: "Listed" (v1, updated 2026-09-27 10:00 UTC) [~/repo]\n  file:///store/a-1/view.html');
	});
});
