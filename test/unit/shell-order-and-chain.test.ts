/**
 * Three places where the pre-gate judged other files than the line reaches
 * (2026-11-22 shell-analysis review, F5, F7 and F9).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeShellCommand } from "../../extensions/lib/shell/shell-analysis.ts";

let root: string;
let cwd: string;
const analyze = (command: string) => analyzeShellCommand({ command, cwd, home: "/home/dana" });
const posixOnly = it.skipIf(process.platform === "win32");

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "shell-order-")));
	cwd = join(root, "project");
	mkdirSync(join(cwd, "sub"), { recursive: true });
	mkdirSync(join(root, "outside"));
	writeFileSync(join(cwd, "a.txt"), "a\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a contained move with another path on the line", () => {
	it("keeps a lone mv or cp contained", () => {
		expect(analyze("mv a.txt b.txt").containedNonNetwork).toBe(true);
		expect(analyze("cp a.txt sub/b.txt").containedNonNetwork).toBe(true);
	});

	it("keeps a line of file commands on plain files contained", () => {
		expect(analyze("mkdir -p build && touch build/x && cp a.txt build/r.md && mv build/r.md build/s.md").containedNonNetwork).toBe(true);
	});

	posixOnly.each(["mv sub/rel link2 && echo x > link2", "mv sub/rel link2; cat link2", "cp -R sub copy && echo x > copy/rel", "mv sub/rel link2 > log.txt"])("%s is not contained", (command) => {
		symlinkSync("../a.txt", join(cwd, "sub", "rel"));
		const evidence = analyze(command);
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.containedNonNetwork).toBe(false);
	});
});

describe("two moves on one line", () => {
	// The first move retargets the link; the second writes through it at its new place.
	posixOnly("is not contained when both may carry a link", () => {
		mkdirSync(join(cwd, "sub", "deep"));
		mkdirSync(join(cwd, "dir"));
		symlinkSync("../x", join(cwd, "sub", "deep", "rel"));
		const evidence = analyze("mv sub/deep/rel link && cp -r dir link");
		expect(evidence.verdict).toBe("escalate");
		expect(evidence.containedNonNetwork).toBe(false);
	});
});

describe("chained git -C", () => {
	posixOnly("resolves each -C from the one before", () => {
		symlinkSync(join(root, "outside"), join(cwd, "sub", "out"));
		expect(analyze("git -C sub/out log -p").verdict).toBe("escalate");
		expect(analyze("git -C sub -C out log -p").verdict).toBe("escalate");
		expect(analyze("git -C sub -C .. log -p").notes.join("\n")).not.toContain("points outside the working directory");
	});
});

describe("ls -L with an abbreviated --recursive", () => {
	it.each(["ls -L --recurs sub", "ls --deref --recursive sub", "ls -LR sub"])("%s escalates", (command) => {
		expect(analyze(command).verdict).toBe("escalate");
	});

	it("leaves plain listings safe", () => {
		expect(analyze("ls -la sub").verdict).toBe("safe");
		expect(analyze("ls -R sub").verdict).toBe("safe");
		expect(analyze("ls --color sub").verdict).toBe("safe");
	});
});
