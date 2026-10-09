/**
 * A shell read that showed a whole file counts as a read (file-tracker/shell-reads.ts):
 * candidate extraction, the full-content check, and the bash tool_result wiring.
 */
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fileTrackerExtension from "../../extensions/file-tracker/index.ts";
import { expandCandidate, shellReadCandidates, shownInFull } from "../../extensions/file-tracker/shell-reads.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import { CHILD_WROTE_CHANNEL } from "../../extensions/lib/child-writes.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { bashParserReady } from "../../extensions/lib/bash-parser.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

vi.mock("node:fs", async (load) => {
	const actual = await load<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

beforeAll(async () => {
	await bashParserReady();
});

describe("shellReadCandidates", () => {
	it("takes the file arguments of cat, head, tail and sed", () => {
		expect(shellReadCandidates("cat a.py b.py")).toEqual(expect.arrayContaining(["a.py", "b.py"]));
		expect(shellReadCandidates("cat Makefile && git status --short")).toContain("Makefile");
		expect(shellReadCandidates("head -n 50 src/x.ts")).toContain("src/x.ts");
		expect(shellReadCandidates("sed -n '1,200p' notes.md")).toContain("notes.md");
		expect(shellReadCandidates("/bin/cat a.txt")).toContain("a.txt");
		expect(shellReadCandidates("LC_ALL=C cat a.txt")).toContain("a.txt");
	});

	it("takes the words a reader loops over, since the content check decides", () => {
		expect(shellReadCandidates('for f in CLAUDE.md src/a.py; do printf "%s" "$f"; cat "$f"; done')).toEqual(
			expect.arrayContaining(["CLAUDE.md", "src/a.py"]),
		);
		const absolute = shellReadCandidates('for f in /tmp/a.txt; do cat "$f"; done');
		expect(absolute).toContain("/tmp/a.txt");
		expect(absolute).not.toContain("tmp/a.txt");
	});

	it("offers nothing without a reader command, or when the line does not parse", () => {
		expect(shellReadCandidates("grep -n foo a.py")).toEqual([]);
		expect(shellReadCandidates("ls src && git diff a.py")).toEqual([]);
		expect(shellReadCandidates("cat 'unbalanced")).toEqual([]);
	});
});

describe("expandCandidate", () => {
	const readdir = (dir: string) => (dir === "src" ? ["a.py", "b.py", "notes.md", ".hidden.py"] : dir === "." ? ["Makefile", "x.py"] : []);

	it("expands a glob in the last component against that directory", () => {
		expect(expandCandidate("src/*.py", readdir)).toEqual(["src/a.py", "src/b.py"]);
		expect(expandCandidate("*.py", readdir)).toEqual(["x.py"]);
	});

	it("passes a plain word through and expands no glob in a directory component", () => {
		expect(expandCandidate("src/a.py", readdir)).toEqual(["src/a.py"]);
		expect(expandCandidate("*/a.py", readdir)).toEqual([]);
	});
});

describe("shownInFull", () => {
	it("needs the whole content in the output, trailing whitespace aside", () => {
		expect(shownInFull("line one\nline two", "line one\nline two\n")).toBe(true);
		expect(shownInFull("==> a <==\nline one\nline two\n\nexit 0", "line one\nline two\n")).toBe(true);
		expect(shownInFull("line one", "line one\nline two\n")).toBe(false);
		expect(shownInFull("     1\tline one\n     2\tline two", "line one\nline two\n")).toBe(false);
	});

	it("never counts an empty or tiny one-line file, whose text turns up by chance", () => {
		expect(shownInFull("anything", "")).toBe(false);
		expect(shownInFull("anything", "\n")).toBe(false);
		expect(shownInFull("(bash completed with no output)", "completed\n")).toBe(false);
		expect(shownInFull("Exit code 1", "1\n")).toBe(false);
		expect(shownInFull("cat: x: No such file or directory", "No such file or directory\n")).toBe(false);
	});

	it("counts a short multi-line file and a long one-line file", () => {
		expect(shownInFull("test:\n\tpython3 t.py", "test:\n\tpython3 t.py\n")).toBe(true);
		const line = "export const VERSION = '1.2.3'; // bumped by release";
		expect(shownInFull(line, `${line}\n`)).toBe(true);
	});
});

describe("file-tracker: a bash result counts as a read", () => {
	let dir: string;
	let fake: FakePi;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "file-tracker-shell-"));
		fake = createFakePi();
		fileTrackerExtension(fake.pi as never);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const ctx = () => createFakeCtx({ cwd: dir });
	let callId = 0;
	/** A bash call as pi runs it: tool_call (the tracker snapshots its candidates), then tool_result. */
	const bash = async (command: string, text: string, during?: () => void) => {
		const toolCallId = `b${++callId}`;
		await fake.fireOne("tool_call", { toolName: "bash", toolCallId, input: { command } }, ctx());
		during?.();
		return fake.fireOne("tool_result", { toolName: "bash", toolCallId, input: { command }, content: [{ type: "text", text }], isError: false }, ctx());
	};
	const edit = (name: string) => fake.fireOne<{ block?: boolean; reason?: string }>("tool_call", { toolName: "edit", input: { path: name } }, ctx());

	it("opens no candidate file before the permission gate decides the call", async () => {
		const secret = join(dir, "secret.txt");
		writeFileSync(secret, "token = 1\n");
		vi.mocked(fs.readFileSync).mockClear();
		await fake.fireOne("tool_call", { toolName: "bash", toolCallId: "denied", input: { command: "cat secret.txt" } }, ctx());
		expect(vi.mocked(fs.readFileSync).mock.calls.some(([path]) => String(path).endsWith("secret.txt"))).toBe(false);
	});

	it("clears a subagent's write attribution once a shell read shows the file", async () => {
		const file = join(dir, "notes.md");
		const emitted: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push((data as { text: string }).text));
		writeFileSync(file, "child line one\nchild line two\n");
		fake.events.emit(CHILD_WROTE_CHANNEL, { path: file, agent: "sweep" });
		await bash("cat notes.md", "child line one\nchild line two");
		writeFileSync(file, "child line one\nchild line two\nuser line\n");
		await fake.fireOne("tool_execution_end", { toolName: "bash", toolCallId: "later", isError: false }, ctx());
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toContain("That's usually deliberate");
		expect(emitted[0]).not.toContain("sweep");
	});

	it("allows an edit after a cat that printed the whole file", async () => {
		writeFileSync(join(dir, "Makefile"), "test:\n\tpython3 t.py\n");
		await bash("cat Makefile", "test:\n\tpython3 t.py");
		expect(await edit("Makefile")).toBeUndefined();
	});

	it("allows an edit after a loop that cat-ed each file in full", async () => {
		writeFileSync(join(dir, "a.py"), "alpha = 1\nprint(alpha)\n");
		writeFileSync(join(dir, "b.py"), "beta = 2\nprint(beta)\n");
		await bash('for f in a.py b.py; do printf "\\n--- %s ---\\n" "$f"; cat "$f"; done', "\n--- a.py ---\nalpha = 1\nprint(alpha)\n\n--- b.py ---\nbeta = 2\nprint(beta)");
		expect(await edit("a.py")).toBeUndefined();
		expect(await edit("b.py")).toBeUndefined();
	});

	it("allows an edit after a loop over a glob printed each file in full", async () => {
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "a.py"), "alpha = 1\nprint(alpha)\n");
		await bash('for f in src/*.py; do echo "== $f"; cat "$f"; done', "== src/a.py\nalpha = 1\nprint(alpha)");
		expect(await edit(join("src", "a.py"))).toBeUndefined();
	});

	it("resolves a shell read in the entered worktree, where the shell ran", async () => {
		const worktree = join(dir, "wt");
		mkdirSync(worktree);
		writeFileSync(join(worktree, "m.py"), "content that lives in the worktree copy only\n");
		fake.events.emit(WORKTREE_CHANNEL, { path: worktree });
		await bash("cat m.py", "content that lives in the worktree copy only");
		expect(await edit(join(worktree, "m.py"))).toBeUndefined();
	});

	it("resolves a shell word as the shell does: cat @x reads the file named @x", async () => {
		writeFileSync(join(dir, "@config.txt"), "the at-sign file's own text\nsecond line\n");
		writeFileSync(join(dir, "config.txt"), "second line\nother\n");
		await bash("cat @config.txt", "the at-sign file's own text\nsecond line");
		expect(await edit(join(dir, "@config.txt"))).toBeUndefined();
		expect((await edit("config.txt"))?.block).toBe(true);
	});

	it("does not certify a file the same command rewrote (cat x; cp y x)", async () => {
		const file = join(dir, "config.txt");
		writeFileSync(file, "obsolete = yes\nmode = safe and sound\nfooter = yes\n");
		await bash("cat config.txt; cp replacement.txt config.txt", "obsolete = yes\nmode = safe and sound\nfooter = yes", () =>
			writeFileSync(file, "mode = safe and sound\nfooter = yes\n"),
		);
		expect((await edit("config.txt"))?.block).toBe(true);
	});

	it("never reads a device a command named (head -c 1 /dev/zero)", async () => {
		// /dev/zero reports size 0; reading it would never end. The test passing at all is the check.
		await bash("head -c 1 /dev/zero | od -c", "0000000  \\0\n0000001");
		expect(true).toBe(true);
	});

	it("still refuses after a partial read, and says why", async () => {
		writeFileSync(join(dir, "big.py"), "alpha = 1\nbeta = 2\ngamma = 3\n");
		await bash("cat big.py | head -1", "alpha = 1");
		const result = await edit("big.py");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("A shell read counts only when its output showed the whole file");
	});

	it("keeps the stale guard: a change after the shell read blocks the edit", async () => {
		const file = join(dir, "x.txt");
		writeFileSync(file, "first version of the notes file\nline two\n");
		await bash("cat x.txt", "first version of the notes file\nline two");
		writeFileSync(file, "second\n");
		expect((await edit("x.txt"))?.reason).toContain("has changed on disk");
	});

	it("rebuilds shell reads from the transcript on resume", async () => {
		writeFileSync(join(dir, "r.txt"), "resumed content of the file r.txt\nline 2\n");
		const branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat r.txt" } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "resumed content of the file r.txt\nline 2" }] } },
		];
		const resumed = createFakeCtx({ cwd: dir, sessionManager: { getSessionId: () => "s1", getBranch: () => branch } });
		await fake.fire("session_start", { reason: "resume" }, resumed);
		await bashParserReady();
		expect(await fake.fireOne("tool_call", { toolName: "edit", input: { path: "r.txt" } }, resumed)).toBeUndefined();
	});
});
