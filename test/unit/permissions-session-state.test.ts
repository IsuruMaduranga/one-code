/**
 * permissions/index.ts wiring for the PERMISSIONS-REVIEW-2026-09-05 medium/low
 * fixes that live in the gate's session state rather than in `decide()`:
 * scoped "don't ask again" grants (M2), the runtime-protected agent dir (M7),
 * a fresh gate per session (L1), and worktree originals through the prompt
 * and the plan-mode pre-gate (L3).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGINAL_COMMAND_CHANNEL } from "../../extensions/lib/original-command.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/permissions/modes.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

type Prompt = { title: string; options: string[] };
type GateResult = { block?: boolean; reason?: string } | undefined;

describe("permissions session state", () => {
	let fake: FakePi;
	let cwd: string;
	let stateDir: string;
	let agentDir: string;
	const prompts: Prompt[] = [];
	/** What the next prompt answers: an index into its options. */
	let answerWith = 0;

	const makeCtx = (hasUI = true) =>
		createFakeCtx({
			cwd,
			hasUI,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "s1", getSessionDir: () => join(stateDir, "session"), getBranch: () => [] },
			ui: {
				select: vi.fn(async (title: string, options: string[]) => {
					prompts.push({ title, options });
					return options[answerWith];
				}),
				input: vi.fn(async () => undefined),
			},
		});
	let ctx: Record<string, unknown>;

	const call = (toolName: string, input: Record<string, unknown>, toolCallId = `c${prompts.length}-${Math.random()}`) =>
		fake.fireOne<GateResult>("tool_call", { toolName, input, toolCallId }, ctx);

	beforeEach(async () => {
		stateDir = mkdtempSync(join(tmpdir(), "perm-state-"));
		cwd = join(stateDir, "project");
		agentDir = join(stateDir, "agent");
		vi.stubEnv("ONECODE_STATE_DIR", join(stateDir, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		fake = createFakePi();
		prompts.length = 0;
		answerWith = 0;
		permissionsExtension(fake.pi as never);
		ctx = makeCtx();
		await fake.fire("session_start", { reason: "startup" }, ctx);
		// The shipped default is now `auto` (CC 2.1.266 parity); these cases
		// exercise default-mode machinery (interactive prompts, session grants),
		// so pin the mode to `default` explicitly. Tests that need another mode
		// emit their own MODE_CHANNEL after this.
		fake.events.emit(MODE_CHANNEL, { mode: "default" });
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	describe("M2: scoped session grants", () => {
		it("offers a working-directory-scoped grant for an in-project write and honours it for that tool only", async () => {
			answerWith = 1; // the grant
			expect(await call("write", { path: "src/a.ts" })).toBeUndefined();
			expect(prompts).toHaveLength(1);
			expect(prompts[0].options).toEqual(["Yes", "Yes, and allow write anywhere in the working directory this session", "No, tell the agent what to do differently"]);

			// Covered: another in-project write, no prompt.
			expect(await call("write", { path: "docs/b.md" })).toBeUndefined();
			expect(prompts).toHaveLength(1);

			// Not covered: an outside write (its own grant stops at the file's directory), and edit.
			answerWith = 0;
			expect(await call("write", { path: join(stateDir, "elsewhere", "c.txt") })).toBeUndefined();
			expect(prompts).toHaveLength(2);
			expect(prompts[1].options[1]).toBe(`Yes, and allow write under ${join(stateDir, "elsewhere")} this session`);
			expect(await call("edit", { path: "src/a.ts" })).toBeUndefined();
			expect(prompts).toHaveLength(3);
		});

		it("offers no session grant for a protected path", async () => {
			expect(await call("write", { path: ".git/hooks/pre-commit" })).toBeUndefined();
			expect(prompts[0].title).toContain("protected path");
			expect(prompts[0].options).toEqual(["Yes", "No, tell the agent what to do differently"]);
		});

		it("mints an exact-literal grant for bash and a domain grant for web_fetch", async () => {
			answerWith = 1;
			expect(await call("bash", { command: "npm test" })).toBeUndefined();
			expect(prompts[0].options[1]).toBe("Yes, and don't ask again for this exact command this session");
			expect(await call("bash", { command: "npm test" })).toBeUndefined();
			expect(await call("bash", { command: "npm test && curl x" })).toBeUndefined();
			expect(prompts).toHaveLength(2); // the compound line prompted again

			expect(await call("web_fetch", { url: "https://example.com/a" })).toBeUndefined();
			expect(prompts[2].title).toContain("https://example.com/a");
			expect(prompts[2].options[1]).toBe("Yes, and don't ask again for example.com this session");
			expect(await call("web_fetch", { url: "https://example.com/b" })).toBeUndefined();
			expect(prompts).toHaveLength(3);
		});
	});

	describe("L1: a new session starts with a clean gate", () => {
		it("drops session grants on a non-reload session_start", async () => {
			answerWith = 1;
			expect(await call("write", { path: "a.ts" })).toBeUndefined();
			expect(await call("write", { path: "b.ts" })).toBeUndefined();
			expect(prompts).toHaveLength(1);

			await fake.fire("session_start", { reason: "reload" }, ctx);
			fake.events.emit(MODE_CHANNEL, { mode: "default" }); // session_start resets to the auto default
			expect(await call("write", { path: "c.ts" })).toBeUndefined();
			expect(prompts).toHaveLength(1); // a reload is the same conversation

			await fake.fire("session_start", { reason: "new" }, ctx);
			fake.events.emit(MODE_CHANNEL, { mode: "default" });
			expect(await call("write", { path: "d.ts" })).toBeUndefined();
			expect(prompts).toHaveLength(2); // /clear: the grant is gone
		});
	});

	describe("M7: pi's agent directory is protected at runtime", () => {
		it("a write into getAgentDir() prompts as a protected path even in acceptEdits", async () => {
			fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
			expect(await call("write", { path: "src/free.ts" })).toBeUndefined();
			expect(prompts).toHaveLength(0);
			expect(await call("write", { path: join(agentDir, "extensions", "evil.ts") })).toBeUndefined();
			expect(prompts).toHaveLength(1);
			expect(prompts[0].title).toContain("protected path");
		});
	});

	describe("L3: worktree-wrapped bash is judged and shown as the model wrote it", () => {
		const worktree = () => join(stateDir, "wt");
		const wrap = (command: string) => `cd '${worktree()}' && (${command}\n)`;
		const wrapped = (command: string, toolCallId: string) => {
			fake.events.emit(ORIGINAL_COMMAND_CHANNEL, { toolCallId, command, cwd: worktree() });
			return call("bash", { command: wrap(command) }, toolCallId);
		};

		it("the prompt shows the original command, not the cd wrapper", async () => {
			expect(await wrapped("env rm -f README.md", "w1")).toBeUndefined();
			expect(prompts[0].title).toContain("env rm -f README.md");
			expect(prompts[0].title).not.toContain("cd '");
		});

		it("plan mode's read-only allowance applies to the original (the wrapper's newline used to escalate every call)", async () => {
			fake.events.emit(MODE_CHANNEL, { mode: "plan" });
			expect(await wrapped("git status", "w2")).toBeUndefined();
			expect(prompts).toHaveLength(0);
			const denied = await wrapped("rm -rf dist", "w3");
			expect(denied?.block).toBe(true);
			// An unwrapped call with the same wrapper text (no original published) is still judged as written.
			const raw = await call("bash", { command: wrap("git status") }, "w4");
			expect(raw?.block).toBe(true);
		});
	});

	describe("shipped default mode", () => {
		it("starts a fresh session in auto, matching Claude Code 2.1.266", async () => {
			// A fresh extension instance (mode initialized, no default pin): with no
			// --permission-mode flag and no settings defaultMode, the first
			// session_start must land in auto.
			const freshFake = createFakePi();
			const modes: string[] = [];
			freshFake.events.on(PERMISSION_STATUS_CHANNEL, (d) => modes.push((d as { mode: string }).mode));
			permissionsExtension(freshFake.pi as never);
			await freshFake.fire("session_start", { reason: "startup" }, makeCtx());
			expect(modes.at(-1)).toBe("auto");
		});
	});
});
