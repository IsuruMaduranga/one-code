/**
 * permissions/index.ts wiring for the PERMISSIONS-REVIEW-2026-09-05 medium/low
 * fixes that live in the gate's session state rather than in `decide()`:
 * scoped "don't ask again" grants (M2), the runtime-protected agent dir (M7),
 * a fresh gate per session (L1), and worktree originals through the prompt
 * and the plan-mode pre-gate (L3).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGINAL_COMMAND_CHANNEL } from "../../extensions/lib/original-command.ts";
import { PANEL_FOCUS_CHANNEL } from "../../extensions/lib/panel-focus.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";
import { shellQuote } from "../../extensions/lib/shell-quote.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/permissions/modes.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

type Prompt = { title: string; options: string[] };
type GateResult = { block?: boolean; reason?: string; terminate?: boolean } | undefined;

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

	// Claude Code's cancelAndAbort: a rejection without feedback in the main
	// session stops the turn; one with feedback lets the model act on it. Esc on
	// the prompt is a rejection without feedback, not a request to type one.
	describe("a rejected prompt", () => {
		const ui = () => ctx.ui as { select: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn> };
		const rejectWith = (choice: "esc" | "no", feedback?: string) => {
			ui().select.mockImplementationOnce(async (_title: string, options: string[]) => (choice === "esc" ? undefined : options.at(-1)));
			ui().input.mockImplementationOnce(async () => feedback);
		};

		// pi checks the signal before the block, so an abort inside the hook would
		// replace the rejection text with "Operation aborted": the abort follows
		// once pi has recorded the result.
		const rejected = async (toolCallId: string) => {
			const result = await call("bash", { command: "rm -rf build" }, toolCallId);
			expect(ctx.abort).not.toHaveBeenCalled();
			await fake.fire("tool_execution_end", { toolCallId, toolName: "bash", result: {}, isError: true }, ctx);
			return result;
		};

		it("stops the turn on Esc without asking for a reason", async () => {
			rejectWith("esc");
			const result = await rejected("esc-1");
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("STOP what you are doing");
			expect(ui().input).not.toHaveBeenCalled();
			expect(ctx.abort).toHaveBeenCalledTimes(1);
			// pi ends the loop after the batch instead of sending one more request
			// on the aborted signal (which printed "Error: This operation was aborted").
			expect(result?.terminate).toBe(true);
		});

		it("stops the turn on No with no reason given", async () => {
			rejectWith("no", "  ");
			const result = await rejected("no-1");
			expect(result?.block).toBe(true);
			expect(ctx.abort).toHaveBeenCalledTimes(1);
		});

		it("lets the turn go on with the user's reason", async () => {
			rejectWith("no", "use make clean instead");
			const result = await rejected("no-2");
			expect(result?.reason).toContain("use make clean instead");
			expect(ctx.abort).not.toHaveBeenCalled();
			expect(result?.terminate).toBe(false);
		});
	});

	// pi would show the prompt in the panel's place: the panel would not come
	// back and an Enter meant for it would answer the prompt.
	describe("a prompt while a panel holds the keyboard", () => {
		const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

		it("waits for the panel to close, says so, then asks", async () => {
			const panel = {};
			fake.events.emit(PANEL_FOCUS_CHANNEL, { id: panel, focused: true });
			let done = false;
			const pending = call("bash", { command: "rm -rf build" }, "panel-1").then((result) => {
				done = true;
				return result;
			});
			await settle();
			expect(prompts).toHaveLength(0);
			expect(done).toBe(false);
			expect((ctx.ui as { notify: unknown }).notify).toHaveBeenCalledWith(expect.stringContaining("Close this panel"), "info");
			fake.events.emit(PANEL_FOCUS_CHANNEL, { id: panel, focused: false });
			expect(await pending).toBeUndefined();
			expect(prompts).toHaveLength(1);
		});

		it("does not wait once the turn is stopped", async () => {
			const controller = new AbortController();
			ctx = { ...ctx, signal: controller.signal };
			fake.events.emit(PANEL_FOCUS_CHANNEL, { id: {}, focused: true });
			const pending = call("bash", { command: "rm -rf build" }, "panel-2");
			await settle();
			controller.abort();
			expect((await pending)?.block).toBe(true);
		});

		it("forgets panels with a new session", async () => {
			fake.events.emit(PANEL_FOCUS_CHANNEL, { id: {}, focused: true });
			await fake.fire("session_start", { reason: "new" }, ctx);
			fake.events.emit(MODE_CHANNEL, { mode: "default" });
			expect(await call("bash", { command: "rm -rf build" }, "panel-3")).toBeUndefined();
			expect(prompts).toHaveLength(1);
		});
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

		it("a worktree-wrapped monitor is judged and shown as the model wrote it too", async () => {
			fake.events.emit(ORIGINAL_COMMAND_CHANNEL, { toolCallId: "m1", command: "env rm -f README.md", cwd: worktree() });
			expect(await call("monitor", { command: wrap("env rm -f README.md"), description: "watch" }, "m1")).toBeUndefined();
			expect(prompts[0].title).toContain("env rm -f README.md");
			expect(prompts[0].title).not.toContain("cd '");
		});
	});

	describe("entered worktree permission anchor", () => {
		beforeEach(async () => {
			vi.stubEnv("CLAUDE_CONFIG_DIR", join(stateDir, "empty-config"));
			await fake.fire("session_start", { reason: "startup" }, ctx);
		});

		it("treats an entered external worktree as the write working directory", async () => {
			const worktree = join(stateDir, "wt");
			mkdirSync(worktree);
			fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: cwd });
			fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
			expect(await call("write", { path: join(worktree, "a.ts") })).toBeUndefined();
			expect(prompts).toHaveLength(0);
		});

		it("stops fast-pathing writes to the previous checkout after entry", async () => {
			const worktree = join(stateDir, "wt");
			mkdirSync(worktree);
			fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: cwd });
			fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
			expect(await call("write", { path: join(cwd, "a.ts") })).toBeUndefined();
			expect(prompts).toHaveLength(1);
		});

		it("preserves a worktree restored before permissions session_start", async () => {
			const worktree = join(stateDir, "restored-wt");
			mkdirSync(worktree);
			fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: cwd });
			await fake.fire("session_start", { reason: "startup" }, ctx);
			fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
			expect(await call("write", { path: join(worktree, "a.ts") })).toBeUndefined();
			expect(prompts).toHaveLength(0);
			expect(await call("write", { path: join(cwd, "a.ts") })).toBeUndefined();
			expect(prompts).toHaveLength(1);
		});

		it.each(["exit", "new-session"])("restores the main scope after %s", async (action) => {
			const worktree = join(stateDir, "wt");
			mkdirSync(worktree);
			fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: cwd });
			fake.events.emit(WORKTREE_CHANNEL, null);
			if (action === "new-session") await fake.fire("session_start", { reason: "new" }, ctx);
			fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
			expect(await call("write", { path: join(cwd, "a.ts") })).toBeUndefined();
			expect(prompts).toHaveLength(0);
			expect(await call("write", { path: join(worktree, "a.ts") })).toBeUndefined();
			expect(prompts).toHaveLength(1);
		});

		it("moves read scope on worktree switches and never falls back if one disappears", async () => {
			const first = join(stateDir, "first-wt");
			const second = join(stateDir, "second-wt");
			mkdirSync(first);
			mkdirSync(second);
			fake.events.emit(MODE_CHANNEL, { mode: "dontAsk" });
			fake.events.emit(WORKTREE_CHANNEL, { path: first, sharedRoot: cwd });
			expect(await call("read", { path: join(first, "a.ts") })).toBeUndefined();
			expect((await call("read", { path: join(cwd, "a.ts") }))?.block).toBe(true);
			fake.events.emit(WORKTREE_CHANNEL, { path: second, sharedRoot: cwd });
			expect(await call("read", { path: join(second, "a.ts") })).toBeUndefined();
			expect((await call("read", { path: join(first, "a.ts") }))?.block).toBe(true);
			rmSync(second, { recursive: true });
			expect((await call("read", { path: join(cwd, "a.ts") }))?.block).toBe(true);
		});

		it("matches rules against trusted original commands without retaining the old resolved root", async () => {
			const config = join(stateDir, "empty-config");
			mkdirSync(config);
			writeFileSync(join(config, "settings.json"), JSON.stringify({ permissions: {
				allow: ["Bash(npm test)", "Bash(echo:*)"],
				deny: ["Bash(npm run publish:*)"],
			} }));
			await fake.fire("session_start", { reason: "reload" }, ctx);
			fake.events.emit(MODE_CHANNEL, { mode: "dontAsk" });
			const worktree = join(stateDir, "wt");
			mkdirSync(worktree);
			fake.events.emit(WORKTREE_CHANNEL, { path: worktree, sharedRoot: cwd });
			const wrapped = (command: string, toolCallId: string) => {
				fake.events.emit(ORIGINAL_COMMAND_CHANNEL, { toolCallId, command, cwd: worktree });
				return call("bash", { command: `cd ${shellQuote(worktree)} && (${command}\n)` }, toolCallId);
			};
			expect(await wrapped("npm test", "allow-original")).toBeUndefined();
			expect((await wrapped("npm run publish", "deny-original"))?.reason).toContain("Bash(npm run publish:*)");
			expect((await wrapped(`echo value > ${shellQuote(join(cwd, "a.ts"))}`, "outside-redirect"))?.block).toBe(true);
			expect((await call("bash", { command: "npm run publish", __ccOriginalCommand: "npm test" }, "forged-original"))?.reason).toContain("Bash(npm run publish:*)");
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
