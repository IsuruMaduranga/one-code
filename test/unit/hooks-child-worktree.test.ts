/**
 * A child session's hooks in a worktree: they run in the child's cwd with the
 * parent's project root, format the child's files, and never start for an
 * aborted turn. A project hook approved in the parent (One Code's source
 * provider reads Claude Code's project settings):
 * profile/test/hooks-child-worktree-project.test.ts.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTrustSessionState } from "../../extensions/safety/hooks/trust.ts";
import { childHookBridge, makeHookWorktreeDirs, writeHookScript } from "./helpers/hook-worktree.ts";
import { writeUserSettings } from "./helpers/settings-files.ts";
import { hooksText } from "../../extensions/safety/hooks/text.ts";

const state = vi.hoisted(() => ({ home: `/nonexistent/one-code-child-hooks-${Math.random().toString(36).slice(2)}` }));
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.home, default: { ...actualDefault, homedir: () => state.home } };
});

describe("child hooks in a worktree", () => {
	let root: string;
	let parent: string;
	let worktree: string;

	beforeEach(() => {
		({ root, project: parent, worktree } = makeHookWorktreeDirs("hooks-child-worktree-"));
		resetTrustSessionState();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetTrustSessionState();
		rmSync(root, { recursive: true, force: true });
	});

	const script = (name: string, body: string) => writeHookScript(root, name, body);
	const bridge = () => childHookBridge(parent);

	it("runs PreToolUse in the child's cwd while preserving the project root and child transcript", async () => {
		const record = join(root, "seen.json");
		const command = script("record", `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), project: process.env.CLAUDE_PROJECT_DIR, payload: JSON.parse(input) })));
`);
		writeUserSettings(parent, homedir(), { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } });
		const hooks = await bridge();
		const transcript = join(root, "child.jsonl");
		await hooks.preToolUse({ toolName: "bash", input: { command: "pwd" }, cwd: worktree, sessionId: "child", transcriptPath: transcript });
		const seen = JSON.parse(readFileSync(record, "utf8"));
		expect(seen).toMatchObject({ cwd: worktree, project: parent, payload: { cwd: worktree, transcript_path: transcript, agent_id: "child" } });
	});

	it("formats the child's relative file without modifying the parent checkout", async () => {
		writeFileSync(join(parent, "file.txt"), "parent contents\n");
		writeFileSync(join(worktree, "file.txt"), "child contents\n");
		const command = script("format", `process.stdin.resume(); require("node:fs").writeFileSync("file.txt", "formatted child\\n");`);
		writeUserSettings(parent, homedir(), { hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command }] }] } });
		const hooks = await bridge();
		const outcome = await hooks.postToolUse({ toolName: "write", input: { path: "file.txt", content: "child contents\n" }, cwd: worktree, sessionId: "child", content: [], isError: false });
		expect(readFileSync(join(parent, "file.txt"), "utf8")).toBe("parent contents\n");
		expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("formatted child\n");
		expect(outcome.additionalContext).toContain(hooksText.fileChangedByHook({ path: join(worktree, "file.txt") }));
	});

	it("does not start a hook for an already-aborted child turn", async () => {
		const record = join(root, "aborted-hook-ran.txt");
		const command = script("aborted", `process.stdin.resume(); require("node:fs").writeFileSync(${JSON.stringify(record)}, "ran");`);
		writeUserSettings(parent, homedir(), { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } });
		const hooks = await bridge();
		const controller = new AbortController();
		controller.abort();
		await hooks.preToolUse({ toolName: "bash", input: { command: "pwd" }, cwd: worktree, sessionId: "child", signal: controller.signal });
		expect(existsSync(record)).toBe(false);
	});
});
