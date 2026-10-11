/**
 * A shell read that showed a whole file counts as a read (file-tracker/shell-reads.ts):
 * candidate extraction, the full-content check, and the bash tool_result wiring.
 */
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fileTrackerExtension from "../../extensions/file-tracker/index.ts";
import { expandCandidate, shellReadCandidates, shellReadPaths, shownInFull } from "../../extensions/file-tracker/shell-reads.ts";
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

const CWD = resolve("/work");
const HOME = resolve("/home/me");
/** The words a command may have printed, whatever directory they resolve in. */
const words = (command: string) => shellReadCandidates(command, CWD, HOME).map((candidate) => candidate.word);
/** The absolute paths a command may have printed, with no glob to expand. */
const paths = (command: string) => shellReadPaths(command, CWD, HOME, () => []);

describe("shellReadCandidates", () => {
	it("takes the file arguments of cat, head, tail and sed", () => {
		expect(words("cat a.py b.py")).toEqual(expect.arrayContaining(["a.py", "b.py"]));
		expect(words("cat Makefile && git status --short")).toContain("Makefile");
		expect(words("head -n 50 src/x.ts")).toContain("src/x.ts");
		expect(words("sed -n '1,200p' notes.md")).toContain("notes.md");
		expect(words("/bin/cat a.txt")).toContain("a.txt");
		expect(words("LC_ALL=C cat a.txt")).toContain("a.txt");
	});

	it("takes the words a reader loops over, since the content check decides", () => {
		expect(words('for f in CLAUDE.md src/a.py; do printf "%s" "$f"; cat "$f"; done')).toEqual(
			expect.arrayContaining(["CLAUDE.md", "src/a.py"]),
		);
		const absolute = words('for f in /tmp/a.txt; do cat "$f"; done');
		expect(absolute).toContain("/tmp/a.txt");
		expect(absolute).not.toContain("tmp/a.txt");
	});

	it("offers nothing without a reader command, or when the line does not parse", () => {
		expect(words("grep -n foo a.py")).toEqual([]);
		expect(words("ls src && git diff a.py")).toEqual([]);
		expect(words("cat 'unbalanced")).toEqual([]);
	});
});

describe("shellReadPaths: the directory a cd sets", () => {
	const at = (...parts: string[]) => resolve(CWD, ...parts);

	it("resolves a reader after a literal cd in the directory it moved to", () => {
		expect(paths("cd src && cat app.ts")).toContain(at("src", "app.ts"));
		expect(paths("cd src && cat app.ts")).not.toContain(at("app.ts"));
		expect(paths("cd src; cat app.ts")).toContain(at("src", "app.ts"));
		expect(paths("cd -- src && cat app.ts")).toContain(at("src", "app.ts"));
		expect(paths("cd src/lib && cd .. && cat app.ts")).toContain(at("src", "app.ts"));
		expect(paths("cd /srv/repo && cat app.ts")).toContain(resolve("/srv/repo", "app.ts"));
		expect(paths("cd ~/proj && cat app.ts")).toContain(resolve(HOME, "proj", "app.ts"));
	});

	it("follows a cd later in an && list into the members after it, which run only once it succeeded", () => {
		expect(paths("git pull && cd src && cat app.ts")).toContain(at("src", "app.ts"));
		expect(paths("if cd src && cat app.ts; then :; fi")).toContain(at("src", "app.ts"));
		// The shape the worktree extension wraps a command in.
		expect(paths("cd '/wt' && ( cd src && cat app.ts )")).toContain(resolve("/wt", "src", "app.ts"));
	});

	it("resolves the words a reader loops over in the reader's directory", () => {
		const found = paths('cd src && for f in a.ts b.ts; do cat "$f"; done');
		expect(found).toEqual(expect.arrayContaining([at("src", "a.ts"), at("src", "b.ts")]));
		expect(found).not.toContain(at("a.ts"));
	});

	it("keeps a cd inside a subshell or a substitution out of the commands after it", () => {
		expect(paths("(cd src && cat a.ts); cat b.ts")).toEqual(expect.arrayContaining([at("src", "a.ts"), at("b.ts")]));
		expect(paths("(cd src && ls); cat b.ts")).toContain(at("b.ts"));
		expect(paths("(cd src && ls); cat b.ts")).not.toContain(at("src", "b.ts"));
		expect(paths('echo "$(cd src)"; cat b.ts')).toContain(at("b.ts"));
		expect(paths('echo "$(cd src)"; cat b.ts')).not.toContain(at("src", "b.ts"));
		// The shape the worktree extension wraps a command in.
		expect(paths("cd '/wt' && ( cat app.ts )")).toContain(resolve("/wt", "app.ts"));
	});

	it.each([
		["a variable target", 'cd "$DIR" && cat app.ts'],
		["a substitution target", "cd $(git rev-parse --show-toplevel) && cat app.ts"],
		["the previous directory", "cd - && cat app.ts"],
		["a glob target", "cd sr* && cat app.ts"],
		["another user's home", "cd ~root && cat app.ts"],
		["an option", "cd -P src && cat app.ts"],
		["two arguments", "cd src lib; cat app.ts"],
		["an empty target", "cd '' && cat app.ts"],
		["pushd", "pushd src && cat app.ts"],
		["popd", "popd; cat app.ts"],
		["a wrapper", "builtin cd src && cat app.ts"],
		["an assignment prefix", "CDPATH=/srv cd src && cat app.ts"],
		["a cd that may not run", "test -d src && cd src; cat app.ts"],
		["a cd after ||", "true || cd src && cat app.ts"],
		["a negated cd", "! cd src && cat app.ts"],
		["a cd in an if branch", "if true; then cd src; fi; cat app.ts"],
		["a cd last in a pipeline (lastpipe)", "echo | cd src; cat app.ts"],
		["a cd in a loop", "for d in a b; do cat app.ts; cd src; done"],
		["a backgrounded cd", "cd src & cat app.ts"],
		["eval", "eval cd src; cat app.ts"],
		["source", "source env.sh; cat app.ts"],
		["a function that may replace cd", "cd() { :; }; cd src; cat app.ts"],
	])("leaves a reader after %s unresolved, never guessed", (_, command) => {
		expect(paths(command).filter((path) => path.endsWith("app.ts"))).toEqual([]);
	});

	it("re-anchors on a later absolute cd", () => {
		expect(paths('cd "$DIR"; cd /srv/repo; cat app.ts')).toContain(resolve("/srv/repo", "app.ts"));
	});

	it("expands a glob in the reader's directory", () => {
		const readdir = (dir: string) => (dir === at("src") ? ["a.py", "b.md"] : []);
		const found = shellReadPaths('cd src && for f in *.py; do cat "$f"; done', CWD, HOME, readdir);
		expect(found).toContain(at("src", "a.py"));
		expect(found).not.toContain(at("src", "b.md"));
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

	describe("after a cd in the same command", () => {
		const APP = "export const app = 'the subdirectory copy';\n";
		beforeEach(() => {
			mkdirSync(join(dir, "src"));
			writeFileSync(join(dir, "src", "app.ts"), APP);
		});

		it("allows an edit after cd src && cat app.ts printed the whole file", async () => {
			await bash("cd src && cat app.ts", APP.trimEnd());
			expect(await edit(join("src", "app.ts"))).toBeUndefined();
		});

		it("does not guess the directory after a cd it cannot follow", async () => {
			writeFileSync(join(dir, "app.ts"), APP);
			await bash('cd "$TARGET" && cat app.ts', APP.trimEnd());
			expect((await edit("app.ts"))?.block).toBe(true);
			expect((await edit(join("src", "app.ts")))?.block).toBe(true);
		});

		it("snapshots the file the cd resolved to: a rewrite by the same command is not certified", async () => {
			await bash("cd src && cat app.ts && cp ../other.ts app.ts", APP.trimEnd(), () => writeFileSync(join(dir, "src", "app.ts"), `${APP}// rewritten\n`));
			expect((await edit(join("src", "app.ts")))?.block).toBe(true);
		});

		it("never counts a file above the shell-read size floor in the cd's directory", async () => {
			const big = `${"x".repeat(100)}\n`.repeat(3000);
			writeFileSync(join(dir, "src", "big.txt"), big);
			await bash("cd src && cat big.txt", big.trimEnd());
			expect((await edit(join("src", "big.txt")))?.block).toBe(true);
		});

		it("rebuilds a read after a cd from the transcript on resume", async () => {
			const branch = [
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cd src && cat app.ts" } }] } },
				{ type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: APP.trimEnd() }] } },
			];
			const resumed = createFakeCtx({ cwd: dir, sessionManager: { getSessionId: () => "s-cd", getBranch: () => branch } });
			await fake.fire("session_start", { reason: "resume" }, resumed);
			await bashParserReady();
			expect(await fake.fireOne("tool_call", { toolName: "edit", input: { path: join("src", "app.ts") } }, resumed)).toBeUndefined();
		});
	});

	describe("across a compaction", () => {
		const KEPT = "unique kept shell content\nsecond line of it\n";
		/** A bash call and its result as the branch stores them. */
		const shellTurn = (id: string, command: string, text: string) => [
			{ type: "message", id: `a${id}`, message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] } },
			{ type: "message", id: `r${id}`, message: { role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text }] } },
		];
		const compact = (branch: unknown[]) =>
			fake.fire("session_compact", { compactionEntry: branch[branch.length - 1], fromExtension: true, reason: "manual", willRetry: false },
				createFakeCtx({ cwd: dir, sessionManager: { getSessionId: () => "same-session", getBranch: () => branch } }));

		it("keeps a shell read whose call and complete result stay in the kept tail", async () => {
			writeFileSync(join(dir, "kept.txt"), KEPT);
			await bash("cat kept.txt", KEPT.trimEnd());
			expect(await edit("kept.txt")).toBeUndefined();
			await compact([...shellTurn("1", "cat kept.txt", KEPT.trimEnd()), { type: "compaction", id: "c", firstKeptEntryId: "a1" }]);
			expect(await edit("kept.txt")).toBeUndefined();
		});

		it("keeps a kept shell read after a cd, resolved as the live read was", async () => {
			mkdirSync(join(dir, "src"));
			writeFileSync(join(dir, "src", "kept.txt"), KEPT);
			await bash("cd src && cat kept.txt", KEPT.trimEnd());
			await compact([...shellTurn("1", "cd src && cat kept.txt", KEPT.trimEnd()), { type: "compaction", id: "c", firstKeptEntryId: "a1" }]);
			expect(await edit(join("src", "kept.txt"))).toBeUndefined();
		});

		it("forgets a shell read the compaction summarized away", async () => {
			writeFileSync(join(dir, "kept.txt"), KEPT);
			await bash("cat kept.txt", KEPT.trimEnd());
			const branch = [...shellTurn("1", "cat kept.txt", KEPT.trimEnd()), ...shellTurn("2", "ls", "kept.txt"), { type: "compaction", id: "c", firstKeptEntryId: "a2" }];
			await compact(branch);
			expect((await edit("kept.txt"))?.reason).toContain("has not been read");
		});

		it("forgets a file whose kept shell output showed only part of it", async () => {
			writeFileSync(join(dir, "kept.txt"), KEPT);
			// Read through the shell, not the read tool, so the post-compaction restore has nothing to bring back.
			await bash("cat kept.txt", KEPT.trimEnd());
			const branch = [...shellTurn("1", "cat kept.txt", KEPT.trimEnd()), ...shellTurn("2", "head -1 kept.txt", "unique kept shell content"), { type: "compaction", id: "c", firstKeptEntryId: "a2" }];
			await compact(branch);
			expect((await edit("kept.txt"))?.reason).toContain("has not been read");
		});

		it("keeps the stale guard: a kept shell read of a file changed since is stale, not unread", async () => {
			writeFileSync(join(dir, "kept.txt"), KEPT);
			await bash("cat kept.txt", KEPT.trimEnd());
			writeFileSync(join(dir, "kept.txt"), `${KEPT}a line someone else added\n`);
			await compact([...shellTurn("1", "cat kept.txt", KEPT.trimEnd()), { type: "compaction", id: "c", firstKeptEntryId: "a1" }]);
			expect((await edit("kept.txt"))?.reason).toContain("has changed on disk");
		});
	});
});
