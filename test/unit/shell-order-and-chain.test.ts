/**
 * Three places where the pre-gate judged other files than the line reaches
 * (2026-11-22 shell-analysis review, F5, F7 and F9).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

	// git changes into each directory, so the next -C starts where a link pointed.
	posixOnly("applies the next -C from where a symbolic link led", () => {
		mkdirSync(join(cwd, "deep"));
		symlinkSync(cwd, join(cwd, "deep", "link"));
		expect(analyze("git -C deep/link -C .. status").notes.join("\n")).toContain(`runs git -C .., which points outside the working directory`);
		expect(analyze("git -C deep/link status").verdict).toBe("safe");
	});

	// The kernel follows the link before it applies the `..` after it.
	posixOnly("walks one -C word in filesystem order, a link before the .. after it", () => {
		mkdirSync(join(cwd, "deep"));
		symlinkSync(cwd, join(cwd, "deep", "link"));
		expect(analyze("git -C deep/link/.. status").notes.join("\n")).toContain("which points outside the working directory");
		expect(analyze("git -C deep/link/../" + basename(cwd) + " status").verdict).toBe("safe");
		expect(analyze("git -C deep/.. status").verdict).toBe("safe");
		expect(analyze("git -C ./deep/../deep/link status").verdict).toBe("safe");
	});

	posixOnly("judges the checkout from that directory too", () => {
		mkdirSync(join(cwd, "deep"));
		mkdirSync(join(cwd, "a", "b"), { recursive: true });
		symlinkSync(join(cwd, "a", "b"), join(cwd, "deep", "link"));
		// A repository layout git takes as the checkout of `a`, reached only through the link.
		mkdirSync(join(cwd, "a", "objects"));
		mkdirSync(join(cwd, "a", "refs"));
		writeFileSync(join(cwd, "a", "HEAD"), "ref: refs/heads/main\n");
		expect(analyze("git -C deep/link -C .. status").notes.join("\n")).toContain("bareRepository");
	});

	posixOnly("reads git's file operands from that directory too", () => {
		mkdirSync(join(cwd, "deep"));
		symlinkSync(cwd, join(cwd, "deep", "home"));
		writeFileSync(join(root, "o.txt"), "secret\n");
		// From the link's target, `../o.txt` is outside the working directory.
		expect(analyze("git -C deep/home diff ../o.txt a.txt").verdict).toBe("escalate");
	});

	it("keeps the result of a chain with no symbolic link", () => {
		mkdirSync(join(cwd, "deep"));
		expect(analyze("git -C deep -C .. status").verdict).toBe("safe");
		expect(analyze("git -C deep -C ../.. status").verdict).toBe("escalate");
		expect(analyze("git -C deep diff ../a.txt a.txt").verdict).toBe("safe");
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
