/**
 * A shell read that showed a whole file counts as a read (file-tracker/shell-reads.ts):
 * candidate extraction, the full-content check, and the bash tool_result wiring.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fileTrackerExtension from "../../extensions/file-tracker/index.ts";
import { shellReadCandidates, shownInFull } from "../../extensions/file-tracker/shell-reads.ts";
import { bashParserReady } from "../../extensions/lib/bash-parser.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

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
	});

	it("offers nothing without a reader command, or when the line does not parse", () => {
		expect(shellReadCandidates("grep -n foo a.py")).toEqual([]);
		expect(shellReadCandidates("ls src && git diff a.py")).toEqual([]);
		expect(shellReadCandidates("cat 'unbalanced")).toEqual([]);
	});
});

describe("shownInFull", () => {
	it("needs the whole content in the output, trailing whitespace aside", () => {
		expect(shownInFull("line 1\nline 2", "line 1\nline 2\n")).toBe(true);
		expect(shownInFull("==> a <==\nline 1\nline 2\n\nexit 0", "line 1\nline 2\n")).toBe(true);
		expect(shownInFull("line 1", "line 1\nline 2\n")).toBe(false);
		expect(shownInFull("     1\tline 1\n     2\tline 2", "line 1\nline 2\n")).toBe(false);
	});

	it("never counts an empty file", () => {
		expect(shownInFull("anything", "")).toBe(false);
		expect(shownInFull("anything", "\n")).toBe(false);
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
	const bash = (command: string, text: string) =>
		fake.fireOne("tool_result", { toolName: "bash", input: { command }, content: [{ type: "text", text }], isError: false }, ctx());
	const edit = (name: string) => fake.fireOne<{ block?: boolean; reason?: string }>("tool_call", { toolName: "edit", input: { path: name } }, ctx());

	it("allows an edit after a cat that printed the whole file", async () => {
		writeFileSync(join(dir, "Makefile"), "test:\n\tpython3 t.py\n");
		await bash("cat Makefile", "test:\n\tpython3 t.py");
		expect(await edit("Makefile")).toBeUndefined();
	});

	it("allows an edit after a loop that cat-ed each file in full", async () => {
		writeFileSync(join(dir, "a.py"), "a = 1\n");
		writeFileSync(join(dir, "b.py"), "b = 2\n");
		await bash('for f in a.py b.py; do printf "\\n--- %s ---\\n" "$f"; cat "$f"; done', "\n--- a.py ---\na = 1\n\n--- b.py ---\nb = 2");
		expect(await edit("a.py")).toBeUndefined();
		expect(await edit("b.py")).toBeUndefined();
	});

	it("still refuses after a partial read, and says why", async () => {
		writeFileSync(join(dir, "big.py"), "a = 1\nb = 2\nc = 3\n");
		await bash("cat big.py | head -1", "a = 1");
		const result = await edit("big.py");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("A shell read counts only when its output showed the whole file");
	});

	it("keeps the stale guard: a change after the shell read blocks the edit", async () => {
		const file = join(dir, "x.txt");
		writeFileSync(file, "first\n");
		await bash("cat x.txt", "first");
		writeFileSync(file, "second\n");
		expect((await edit("x.txt"))?.reason).toContain("has changed on disk");
	});

	it("rebuilds shell reads from the transcript on resume", async () => {
		writeFileSync(join(dir, "r.txt"), "resumed content\n");
		const branch = [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat r.txt" } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "resumed content" }] } },
		];
		const resumed = createFakeCtx({ cwd: dir, sessionManager: { getSessionId: () => "s1", getBranch: () => branch } });
		await fake.fire("session_start", { reason: "resume" }, resumed);
		await bashParserReady();
		expect(await fake.fireOne("tool_call", { toolName: "edit", input: { path: "r.txt" } }, resumed)).toBeUndefined();
	});
});
