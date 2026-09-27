import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOWNLOAD_GLOBAL, renderDownloadPayload, renderGallery } from "../../extensions/artifacts/gallery.ts";
import {
	type ArtifactMeta,
	deleteArtifact,
	exportArtifact,
	fileUrl,
	galleryPath,
	getArtifact,
	listArtifacts,
	listLine,
	MAX_ARTIFACT_BYTES,
	pagePath,
	pageTitle,
	publishArtifact,
	publishProblem,
	resolveArtifactRef,
	slugify,
	versionPath,
	LockBusyError,
	viewerPath,
	withLock,
} from "../../extensions/artifacts/store.ts";
import { renderViewer } from "../../extensions/artifacts/viewer.ts";
import { noDisplayReason, openerPlan } from "../../extensions/lib/open-browser.ts";

let base: string;
let root: string;
let suffixes: number;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "artifacts-"));
	root = join(base, "store");
	suffixes = 0;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const page = (title: string, body = "hello") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

function publish(sourceName: string, html: string, extra: Partial<Parameters<typeof publishArtifact>[1]> = {}) {
	const sourcePath = join(base, sourceName);
	writeFileSync(sourcePath, html);
	return publishArtifact(root, {
		sourcePath,
		html,
		now: new Date(Date.UTC(2026, 8, 27, 10, suffixes)),
		suffix: () => `s${++suffixes}`,
		...extra,
	});
}

describe("slugify and pageTitle", () => {
	it("slugs a title to lowercase hyphenated ASCII, capped at 40 characters", () => {
		expect(slugify("Q3 Revenue — Café Dashboard!")).toBe("q3-revenue-cafe-dashboard");
		expect(slugify("x".repeat(60))).toHaveLength(40);
		expect(slugify("日本語")).toBe("page");
	});

	it("reads the <title>, decoding entities and collapsing whitespace", () => {
		expect(pageTitle("<title>\n  Tom &amp; Jerry &#8212; &#x41;  </title>")).toBe("Tom & Jerry — A");
		expect(pageTitle("<TITLE lang=en>Upper</TITLE>")).toBe("Upper");
		expect(pageTitle("<title>   </title>")).toBeUndefined();
		expect(pageTitle("<h1>No title</h1>")).toBeUndefined();
	});
});

describe("publishArtifact", () => {
	it("stores a new artifact with its page, meta, download payload and gallery", () => {
		const { meta, created } = publish("report.html", page("Build Times"), { description: "CI build durations.", project: "/repo" });
		expect(created).toBe(true);
		expect(meta).toMatchObject({ id: "build-times-s1", title: "Build Times", description: "CI build durations.", project: "/repo", version: 1 });
		expect(readFileSync(pagePath(root, meta.id), "utf-8")).toBe(page("Build Times"));
		expect(getArtifact(root, meta.id)).toEqual(meta);
		expect(existsSync(join(root, meta.id, "download.js"))).toBe(true);
		expect(readFileSync(viewerPath(root, meta.id), "utf-8")).toContain('<iframe id="page" src="index.html" title="Build Times">');
		expect(readFileSync(galleryPath(root), "utf-8")).toContain("Build Times");
	});

	it.skipIf(process.platform === "win32")("keeps the store private to the user, tightening a loose one", () => {
		publish("a.html", page("Private"));
		expect(statSync(root).mode & 0o777).toBe(0o700);
		chmodSync(root, 0o755);
		publish("b.html", page("Still Private"));
		expect(statSync(root).mode & 0o777).toBe(0o700);
	});

	it("falls back to the title parameter, then the file name, for a page with no <title>", () => {
		expect(publish("a.html", "<p>a</p>", { title: "Given Title" }).meta.title).toBe("Given Title");
		expect(publish("plain-notes.html", "<p>b</p>").meta.title).toBe("plain-notes");
		// A blank title parameter is no title.
		expect(publish("blank.html", "<p>c</p>", { title: "   " }).meta).toMatchObject({ title: "blank", id: "blank-s3" });
	});

	it("leaves the artifact untouched when a write fails partway", () => {
		const first = publish("r.html", page("Sturdy", "one"));
		// A directory where the payload's temp file goes makes that write fail.
		mkdirSync(join(root, first.meta.id, `download.js.next-${process.pid}`));
		expect(() => publish("r.html", page("Sturdy", "two"))).toThrow();
		expect(getArtifact(root, first.meta.id)?.version).toBe(1);
		expect(readFileSync(pagePath(root, first.meta.id), "utf-8")).toBe(page("Sturdy", "one"));
		expect(existsSync(join(root, first.meta.id, "versions"))).toBe(false);
		expect(readdirSync(join(root, first.meta.id)).filter((name) => name.includes(".next-") && name !== `download.js.next-${process.pid}`)).toEqual([]);
		// Once the obstacle is gone, the same publish goes through as version 2.
		rmSync(join(root, first.meta.id, `download.js.next-${process.pid}`), { recursive: true });
		expect(publish("r.html", page("Sturdy", "two")).meta.version).toBe(2);
	});

	it("releases a lock only while it is still the holder's", () => {
		const lock = join(base, "lock");
		withLock(lock, "busy", (held) => {
			expect(held()).toBe(true);
			// Another session took it over (its token now in the owner file).
			writeFileSync(join(lock, "owner"), "someone-else");
			expect(held()).toBe(false);
		});
		expect(readFileSync(join(lock, "owner"), "utf-8")).toBe("someone-else");
		// A released lock is gone.
		const other = join(base, "other-lock");
		withLock(other, "busy", () => {});
		expect(existsSync(other)).toBe(false);
	});

	it("rolls every replaced file back when a rename fails partway", () => {
		const first = publish("r.html", page("Rolled", "one"));
		const payloadBefore = readFileSync(join(root, first.meta.id, "download.js"), "utf-8");
		// The viewer, renamed last, is blocked by a non-empty directory in its place.
		const view = viewerPath(root, first.meta.id);
		rmSync(view);
		mkdirSync(view);
		writeFileSync(join(view, "x"), "");
		expect(() => publish("r.html", page("Rolled", "two"))).toThrow();
		expect(getArtifact(root, first.meta.id)?.version).toBe(1);
		expect(readFileSync(pagePath(root, first.meta.id), "utf-8")).toBe(page("Rolled", "one"));
		expect(readFileSync(join(root, first.meta.id, "download.js"), "utf-8")).toBe(payloadBefore);
		expect(readdirSync(join(root, first.meta.id)).filter((name) => name.includes(".next-"))).toEqual([]);
	});

	it("renames the download when a republish of the same bytes changes the fallback title", () => {
		const first = publish("untitled.html", "<p>same</p>", { title: "First Name" });
		publish("untitled.html", "<p>same</p>", { title: "Second Name" });
		expect(readFileSync(join(root, first.meta.id, "download.js"), "utf-8")).toContain('"filename":"second-name.html"');
	});

	it("reclaims a lock whose owner process has exited, never one whose owner is alive", () => {
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		const lock = join(base, "lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "owner"), `${dead}-gone`);
		expect(withLock(lock, "busy", () => "ran")).toBe("ran");
		// The parent process is alive: its lock is waited on, then refused, however
		// old within this boot.
		mkdirSync(lock);
		writeFileSync(join(lock, "owner"), `${process.ppid}-alive`);
		const sameBoot = new Date(Date.now() - Math.min(60_000, uptime() * 500));
		utimesSync(lock, sameBoot, sameBoot);
		expect(() => withLock(lock, "busy", () => "ran", 100)).toThrow(LockBusyError);
		expect(readFileSync(join(lock, "owner"), "utf-8")).toBe(`${process.ppid}-alive`);
		// From before this boot, the same pid names some other process: reclaimed.
		const preBoot = new Date(Date.now() - (uptime() + 3_600) * 1000);
		utimesSync(lock, preBoot, preBoot);
		expect(withLock(lock, "busy", () => "ran", 100)).toBe("ran");
	});

	it("deletes past a lock its crashed owner left behind", () => {
		const { meta } = publish("a.html", page("Orphaned"));
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		mkdirSync(join(root, meta.id, ".lock"));
		writeFileSync(join(root, meta.id, ".lock", "owner"), `${dead}-gone`);
		expect(deleteArtifact(root, meta.id)).toBe(true);
		expect(existsSync(join(root, meta.id))).toBe(false);
	});

	it("takes over a lock a crashed session left behind", () => {
		const first = publish("r.html", page("Locked", "one"));
		const lock = join(root, first.meta.id, ".lock");
		mkdirSync(lock);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		expect(publish("r.html", page("Locked", "two")).meta.version).toBe(2);
		expect(existsSync(lock)).toBe(false);
	});

	it("republishing the same source makes a new version and keeps the old one", () => {
		const first = publish("r.html", page("Report", "one"), { description: "First." });
		const second = publish("r.html", page("Report", "two"));
		expect(second.created).toBe(false);
		expect(second.meta).toMatchObject({ id: first.meta.id, version: 2, description: "First.", createdAt: first.meta.createdAt });
		expect(readFileSync(versionPath(root, first.meta.id, 1), "utf-8")).toBe(page("Report", "one"));
		expect(readFileSync(pagePath(root, first.meta.id), "utf-8")).toBe(page("Report", "two"));
		expect(publish("r.html", page("Report", "three")).meta.version).toBe(3);
		expect(readFileSync(versionPath(root, first.meta.id, 2), "utf-8")).toBe(page("Report", "two"));
		// Each earlier version keeps its own download payload, and the viewer lists it.
		expect(readFileSync(join(root, first.meta.id, "versions", "v1.js"), "utf-8")).toContain("one");
		expect(readFileSync(join(root, first.meta.id, "download.js"), "utf-8")).toContain("three");
		const viewer = readFileSync(viewerPath(root, first.meta.id), "utf-8");
		expect(viewer).toContain('href="#v2"');
		expect(viewer).toContain("var LATEST = 3;");
	});

	it("keeps the current page in place while a new version is written", () => {
		const first = publish("r.html", page("Kept", "one"));
		publish("r.html", page("Kept", "two"));
		// The earlier version is a copy, and no temp file is left behind.
		expect(readdirSync(join(root, first.meta.id)).sort()).toEqual(["download.js", "index.html", "meta.json", "versions", "view.html"]);
		expect(readdirSync(join(root, first.meta.id, "versions")).sort()).toEqual(["v1.html", "v1.js"]);
	});

	it("republishing identical content refreshes the details without a new version", () => {
		const first = publish("r.html", page("Same"));
		const again = publish("r.html", page("Same"), { description: "Now described." });
		expect(again.meta.version).toBe(1);
		expect(again.meta.description).toBe("Now described.");
		expect(existsSync(join(root, first.meta.id, "versions"))).toBe(false);
	});

	it("updates the artifact an id names, whatever the source path", () => {
		const first = publish("old-session.html", page("Tracker", "old"));
		const updated = publish("new-session.html", page("Tracker", "new"), { id: first.meta.id });
		expect(updated.meta).toMatchObject({ id: first.meta.id, version: 2, sourcePath: join(base, "new-session.html") });
		expect(listArtifacts(root)).toHaveLength(1);
	});

	it("refuses an id that names no artifact, with the fix", () => {
		expect(() => publish("x.html", page("X"), { id: "missing-123" })).toThrow(/action "list"/);
	});

	it("keeps two same-titled pages from different files apart", () => {
		const a = publish("a.html", page("Same Title"));
		const b = publish("b.html", page("Same Title"));
		expect(a.meta.id).not.toBe(b.meta.id);
		expect(listArtifacts(root)).toHaveLength(2);
	});
});

describe("publishProblem", () => {
	it("accepts a normal .html page", () => {
		expect(publishProblem(root, join(base, "p.html"), 100)).toBeUndefined();
		expect(publishProblem(root, join(base, "p.HTM"), 100)).toBeUndefined();
	});

	it("names the fix for each refused page", () => {
		expect(publishProblem(root, join(base, "p.md"), 100)).toMatch(/not an \.html file/);
		expect(publishProblem(root, join(root, "x-1", "index.html"), 100)).toMatch(/inside the artifact store/);
		expect(publishProblem(root, join(base, "p.html"), 0)).toMatch(/empty/);
		expect(publishProblem(root, join(base, "p.html"), MAX_ARTIFACT_BYTES + 1)).toMatch(/at most 16 MB/);
	});
});

describe("listing, resolving and deleting", () => {
	it("lists newest first and skips folders without a valid meta file", () => {
		const older = publish("a.html", page("Older"));
		const newer = publish("b.html", page("Newer"));
		mkdirSync(join(root, "stray-folder"));
		writeFileSync(join(root, "stray-folder", "meta.json"), "{broken");
		// Valid JSON missing a field the listing formats is skipped too, not a crash.
		mkdirSync(join(root, "no-dates"));
		writeFileSync(join(root, "no-dates", "meta.json"), JSON.stringify({ id: "no-dates", title: "T", version: 1, sourcePath: "/x.html" }));
		expect(listArtifacts(root).map((m) => m.id)).toEqual([newer.meta.id, older.meta.id]);
		expect(listArtifacts(join(base, "nowhere"))).toEqual([]);
	});

	it("resolves an id, a file URL, or a path inside the artifact's folder", () => {
		const { meta } = publish("a.html", page("Resolve Me"));
		expect(resolveArtifactRef(root, meta.id)).toBe(meta.id);
		expect(resolveArtifactRef(root, fileUrl(pagePath(root, meta.id)))).toBe(meta.id);
		expect(resolveArtifactRef(root, pagePath(root, meta.id))).toBe(meta.id);
		expect(resolveArtifactRef(root, "no-such-id")).toBeUndefined();
		expect(resolveArtifactRef(root, "../store")).toBeUndefined();
		expect(resolveArtifactRef(root, join(base, "a.html"))).toBeUndefined();
		expect(getArtifact(root, "../escape")).toBeUndefined();
	});

	it.skipIf(process.platform === "linux")("matches a differently cased path into the store where the filesystem folds case", () => {
		const { meta } = publish("a.html", page("Cased"));
		const shouted = join(base, "STORE", meta.id.toUpperCase(), "INDEX.HTML");
		expect(resolveArtifactRef(root, shouted)).toBe(meta.id);
		expect(publishProblem(root, shouted, 10)).toMatch(/inside the artifact store/);
	});

	it("lists one artifact as its id, title, version, project and viewer link", () => {
		const { meta } = publish("a.html", page("Listed"), { project: join(base, "repo") });
		const line = listLine(root, meta, base);
		expect(line).toContain(`- ${meta.id}: "Listed" (v1, updated 2026-09-27 10:00 UTC) [~/repo]`);
		expect(line).toContain(fileUrl(viewerPath(root, meta.id)));
	});

	it("exports to Downloads without overwriting, or to home when there is no Downloads", () => {
		const { meta } = publish("a.html", page("Export Me", "body"));
		const home = join(base, "home");
		mkdirSync(home);
		expect(exportArtifact(root, meta, home)).toBe(join(home, "export-me.html"));
		mkdirSync(join(home, "Downloads"));
		expect(exportArtifact(root, meta, home)).toBe(join(home, "Downloads", "export-me.html"));
		expect(exportArtifact(root, meta, home)).toBe(join(home, "Downloads", "export-me-2.html"));
		expect(readFileSync(join(home, "Downloads", "export-me-2.html"), "utf-8")).toBe(page("Export Me", "body"));
	});

	it("deletes an artifact and every version, and drops it from the gallery", () => {
		const { meta } = publish("a.html", page("Doomed", "1"));
		publish("a.html", page("Doomed", "2"));
		expect(deleteArtifact(root, meta.id)).toBe(true);
		expect(existsSync(join(root, meta.id))).toBe(false);
		expect(readFileSync(galleryPath(root), "utf-8")).not.toContain("Doomed");
		expect(deleteArtifact(root, meta.id)).toBe(false);
	});
});

describe("gallery", () => {
	const meta = (over: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
		id: "chart-abc123",
		title: "Chart",
		sourcePath: "/tmp/chart.html",
		createdAt: "2026-09-27T10:00:00.000Z",
		updatedAt: "2026-09-27T11:30:00.000Z",
		version: 1,
		...over,
	});

	it("escapes every model-written string", () => {
		const html = renderGallery([meta({ title: `<script>alert(1)</script>`, description: `"quoted" & <b>` })]);
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("&quot;quoted&quot; &amp; &lt;b&gt;");
	});

	it("links the current page, each earlier version, and the download payload", () => {
		const html = renderGallery([meta({ version: 3, project: "/home/u/repo" })], "/home/u");
		expect(html).toContain('href="chart-abc123/view.html"');
		expect(html).toContain('href="chart-abc123/view.html#v2"');
		expect(html).toContain('href="chart-abc123/view.html#v1"');
		expect(html).not.toContain("view.html#v3");
		expect(html).toContain('data-download="chart-abc123/download.js"');
		expect(html).toContain("~/repo");
		expect(html).toContain("2026-09-27 11:30 UTC");
	});

	it("shows an empty state with no artifacts", () => {
		expect(renderGallery([])).toContain("No artifacts yet");
	});

	it("the download payload hands the exact page to the gallery's global", () => {
		const html = `<script>if (a < b && "</script>") {}</script>\u2028`;
		let received: unknown;
		runInNewContext(renderDownloadPayload("chart.html", html), { window: { [DOWNLOAD_GLOBAL]: (payload: unknown) => (received = payload) } });
		expect(received).toEqual({ filename: "chart.html", html });
		// Loaded outside the gallery, it does nothing.
		expect(() => runInNewContext(renderDownloadPayload("x.html", "y"), { window: {} })).not.toThrow();
	});
});

describe("viewer", () => {
	const meta: ArtifactMeta = {
		id: "chart-abc123",
		title: `<b>"Chart"</b>`,
		sourcePath: "/tmp/chart.html",
		createdAt: "2026-09-27T10:00:00.000Z",
		updatedAt: "2026-09-27T11:30:00.000Z",
		version: 1,
	};

	it("escapes the title in the tab, the bar and the frame", () => {
		const html = renderViewer(meta, "/store/chart-abc123");
		expect(html).not.toContain("<b>");
		expect(html).toContain("<title>&lt;b&gt;&quot;Chart&quot;&lt;/b&gt;</title>");
	});

	it("lists versions only when there are earlier ones, and never offers server actions", () => {
		expect(renderViewer(meta, "/s/c")).not.toContain("Versions</div>");
		const html = renderViewer({ ...meta, version: 3 }, "/s/c");
		expect(html).toContain('href="#v2"');
		expect(html).toContain('href="#v1"');
		expect(html).not.toContain('href="#v3"');
		expect(html).not.toMatch(/>(Share|Chat|Rename|Duplicate|Pin)</);
	});

	it("embeds the file paths as JSON a page path cannot break out of", () => {
		const html = renderViewer(meta, "/s/</script><script>x()</script>");
		expect(html).not.toContain("</script><script>x()");
		// The separator may be \\ (Windows `join`), so only the escaped `<` is certain.
		expect(html).toContain("\\u003c");
	});
});

describe("open-browser", () => {
	it("picks the platform opener, never cmd.exe on Windows", () => {
		expect(openerPlan("file:///a.html", "darwin")).toEqual({ command: "open", args: ["file:///a.html"] });
		expect(openerPlan("file:///a.html", "linux")).toEqual({ command: "xdg-open", args: ["file:///a.html"] });
		const win = openerPlan("file:///C:/a.html", "win32", { SystemRoot: "C:\\Windows" });
		expect(win.command.toLowerCase()).toContain("rundll32.exe");
		expect(win.args).toEqual(["url.dll,FileProtocolHandler", "file:///C:/a.html"]);
	});

	it("reports no display over SSH or on a Linux box without X or Wayland", () => {
		expect(noDisplayReason("darwin", {})).toBeUndefined();
		expect(noDisplayReason("darwin", { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" })).toMatch(/SSH/);
		expect(noDisplayReason("linux", {})).toMatch(/no graphical display/);
		expect(noDisplayReason("linux", { DISPLAY: ":0" })).toBeUndefined();
		expect(noDisplayReason("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBeUndefined();
		expect(noDisplayReason("win32", {})).toBeUndefined();
	});
});
