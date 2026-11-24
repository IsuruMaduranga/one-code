import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOutputLink, linkOutputFile } from "../../extensions/agents/subagents/output-link.ts";

// Windows refuses a symbolic link without Developer Mode or admin rights; the fallback is covered there by the wiring.
describe.skipIf(process.platform === "win32")("a resident agent's output file", () => {
	let dir: string;
	let target: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "output-link-"));
		mkdirSync(join(dir, "session"));
		target = join(dir, "session", "run.jsonl");
		path = join(dir, "tasks", "a1.output");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("links to the session file, making the tasks folder", () => {
		writeFileSync(target, "transcript\n");
		expect(linkOutputFile(path, target)).toBe(true);
		expect(readlinkSync(path)).toBe(target);
		expect(readFileSync(path, "utf8")).toBe("transcript\n");
	});

	it("follows the session file as pi rewrites it in place", () => {
		writeFileSync(target, "one\n");
		linkOutputFile(path, target);
		writeFileSync(target, "one\ntwo\n");
		expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
	});

	it("replaces a text spool written before the session file existed", () => {
		mkdirSync(join(dir, "tasks"));
		writeFileSync(path, "reply so far");
		writeFileSync(target, "transcript\n");
		expect(isOutputLink(path)).toBe(false);
		expect(linkOutputFile(path, target)).toBe(true);
		expect(isOutputLink(path)).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("transcript\n");
	});

	it("makes the link again after the temp folder was cleared", () => {
		writeFileSync(target, "transcript\n");
		linkOutputFile(path, target);
		rmSync(join(dir, "tasks"), { recursive: true });
		expect(linkOutputFile(path, target)).toBe(true);
		expect(lstatSync(path).isSymbolicLink()).toBe(true);
	});

	it("keeps the text spool where a link is refused", () => {
		mkdirSync(join(dir, "tasks"));
		writeFileSync(path, "reply so far");
		// A folder in the way of the link's temporary name stands in for a refused symlink.
		mkdirSync(`${path}.link`);
		writeFileSync(join(`${path}.link`, "held"), "");
		expect(linkOutputFile(path, target)).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("reply so far");
	});

	it("reports a link it cannot make", () => {
		writeFileSync(join(dir, "tasks"), "a file where the folder should be");
		expect(linkOutputFile(path, target)).toBe(false);
		expect(isOutputLink(path)).toBe(false);
	});
});
