import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import hooksExtension from "../../extensions/hooks/index.ts";
import mcpExtension from "../../extensions/mcp/index.ts";
import { buildClaudeMdBlock, discoverContextFiles, discoverOneCodeFiles, externalInstructionIncludes, nestedInstructionFiles } from "../../extensions/lib/claude-context.ts";
import { EXTERNAL_INCLUDES_NO, EXTERNAL_INCLUDES_TITLE, EXTERNAL_INCLUDES_YES, externalIncludesDialog, persistExternalIncludesApproval, readExternalIncludesApproval } from "../../extensions/lib/claude-external-includes.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { oneCodeProjectSettingsPath } from "../../extensions/lib/one-code-settings.ts";
import { forwardSlashes } from "../../extensions/lib/paths.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { safetyControlWrite } from "../../extensions/auto-mode/safety-floor.ts";
import { startupConsentReady } from "../../extensions/lib/consent-dialogs.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

let root: string;
let cwd: string;
let home: string;
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
// An absolute @import spelled with forward slashes: the reference parser reads a backslash as an escape.
const ref = (path: string) => `@${forwardSlashes(path)}`;
beforeEach(() => {
	// Resolved natively, as the probe reports: macOS TMPDIR sits behind a symlink,
	// and Windows TEMP can be an 8.3 short name (RUNNER~1) the JS realpath keeps.
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "external-includes-")));
	cwd = join(root, "project");
	home = join(root, "home");
	mkdirSync(cwd);
	stubHome(home);
	vi.stubEnv("ONECODE_STATE_DIR", join(root, "state"));
	resetConfigModeForTest("claude-compatible");
});
afterEach(() => {
	vi.unstubAllEnvs();
	resetConfigModeForTest();
	rmSync(root, { recursive: true, force: true });
});
const opts = () => ({ cwd, home, homeClaudeDir: join(home, ".claude"), managedDir: join(root, "managed"), rule: "claude-md-and-agents-md" as const });
const fixture = (name = "CLAUDE.md") => {
	const outside = write(join(root, "shared.md"), "APPROVED EXTERNAL INSTRUCTION\n");
	write(join(cwd, name), `Project instructions.\n${ref(outside)}\n`);
	return outside;
};
const start = async (choice: string | undefined, hasUI = true) => {
	const fake = createFakePi();
	const texts: string[] = [];
	fake.events.on(REMINDER_CHANNEL, (data) => {
		const payload = data as { key?: string; text?: string };
		if (payload.key === "claude-context" && payload.text) texts.push(payload.text);
	});
	const select = vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => choice);
	const ctx = createFakeCtx({ cwd, hasUI, mode: hasUI ? "rpc" : "print", ui: { select } });
	systemReminderExtension(fake.pi as never);
	claudeContextExtension(fake.pi as never);
	await fake.fire("session_start", {}, ctx);
	await fake.fire("before_agent_start", {}, ctx);
	return { fake, ctx, select, texts };
};

describe("external instruction include approval", () => {
	it("asks at startup and includes the outside file after approval", async () => {
		write(join(cwd, "CLAUDE.md"), "Project instructions.\n@../shared.md\n");
		write(join(root, "shared.md"), "APPROVED EXTERNAL INSTRUCTION\n");
		const { select, texts } = await start(EXTERNAL_INCLUDES_YES);
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0][0]).toBe(externalIncludesDialog([join(root, "shared.md")], home));
		expect(select.mock.calls[0][1]).toEqual([EXTERNAL_INCLUDES_NO, EXTERNAL_INCLUDES_YES]);
		expect(texts.at(-1)).toContain("APPROVED EXTERNAL INSTRUCTION");
		expect(readExternalIncludesApproval(cwd, home)).toEqual({ approved: true, warningShown: true });
	});

	it.each([EXTERNAL_INCLUDES_NO, undefined, "unrecognized reply"])("remembers a no/Esc, never treats %s as approval", async (choice) => {
		fixture();
		const run = await start(choice);
		expect(run.texts.join("\n")).not.toContain("APPROVED EXTERNAL INSTRUCTION");
		expect(readExternalIncludesApproval(cwd, home)).toEqual({ approved: false, warningShown: true });
		const next = await start(EXTERNAL_INCLUDES_YES);
		expect(next.select).not.toHaveBeenCalled();
		expect(next.texts.join("\n")).not.toContain("APPROVED EXTERNAL INSTRUCTION");
	});

	it("honors persisted approval without a UI, including imports added later", async () => {
		fixture();
		await start(EXTERNAL_INCLUDES_YES);
		write(join(root, "later.md"), "LATER EXTERNAL INSTRUCTION");
		write(join(cwd, "CLAUDE.local.md"), "@../later.md");
		const { select, texts } = await start(EXTERNAL_INCLUDES_NO, false);
		expect(select).not.toHaveBeenCalled();
		expect(texts.at(-1)).toContain("APPROVED EXTERNAL INSTRUCTION");
		expect(texts.at(-1)).toContain("LATER EXTERNAL INSTRUCTION");
	});

	it("does not ask or persist a decision without a UI", async () => {
		fixture();
		const { select, texts } = await start(EXTERNAL_INCLUDES_YES, false);
		expect(select).not.toHaveBeenCalled();
		expect(texts.join("\n")).not.toContain("APPROVED EXTERNAL INSTRUCTION");
		expect(existsSync(oneCodeProjectSettingsPath(cwd, home))).toBe(false);
	});

	it("ignores approval keys in every project-controlled settings file", async () => {
		fixture();
		const forged = JSON.stringify({ hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true });
		for (const path of [".claude/settings.json", ".claude/settings.local.json", ".onecode/settings.json", "settings.json"]) write(join(cwd, path), forged);
		const { select, texts } = await start(EXTERNAL_INCLUDES_NO);
		expect(select).toHaveBeenCalledOnce();
		expect(texts.join("\n")).not.toContain("APPROVED EXTERNAL INSTRUCTION");
	});

	it("leaves the no-external-import prefix byte-identical and never opens a dialog", async () => {
		write(join(cwd, "CLAUDE.md"), "Root bytes.\n@inside.md\n");
		write(join(cwd, "inside.md"), "Inside bytes.\n");
		const before = buildClaudeMdBlock({ contextFiles: discoverContextFiles(opts()) });
		const { select, texts } = await start(EXTERNAL_INCLUDES_YES);
		expect(select).not.toHaveBeenCalled();
		expect(texts).toEqual([before]);
		expect(existsSync(oneCodeProjectSettingsPath(cwd, home))).toBe(false);
	});

	it.each(["new", "reload", "resume", "fork"])("does not turn %s into another startup approval opportunity", async (reason) => {
		const { fake, ctx, select } = await start(EXTERNAL_INCLUDES_YES);
		fixture();
		await fake.fire("session_start", { reason }, ctx);
		await fake.fire("before_agent_start", {}, ctx);
		expect(select).not.toHaveBeenCalled();
		expect(existsSync(oneCodeProjectSettingsPath(cwd, home))).toBe(false);
	});

	it("opens the RPC dialog without awaiting session_start, but holds the first turn", async () => {
		fixture();
		let answer!: (choice: string) => void;
		const select = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
		const fake = createFakePi();
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc", ui: { select } });
		await fake.fire("session_start", {}, ctx);
		let sent = false;
		const pending = fake.fire("turn_start", {}, ctx).then(() => { sent = true; });
		await Promise.resolve();
		expect(select).toHaveBeenCalledOnce();
		expect(sent).toBe(false);
		answer(EXTERNAL_INCLUDES_YES);
		await pending;
		expect(sent).toBe(true);
	});

	it("treats a dialog that fails as no answer and still runs the turn", async () => {
		fixture();
		const fake = createFakePi();
		claudeContextExtension(fake.pi as never);
		const select = vi.fn(async (): Promise<string> => { throw new Error("dialog failed"); });
		const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc", ui: { select } });
		await fake.fire("session_start", {}, ctx);
		await expect(fake.fire("before_agent_start", {}, ctx)).resolves.toBeDefined();
		await expect(fake.fire("turn_start", {}, ctx)).resolves.toBeDefined();
		expect(select).toHaveBeenCalledOnce();
		expect(readExternalIncludesApproval(cwd, home)).toEqual({ approved: false, warningShown: false });
	});

	it.each(["session_shutdown", "session_start"])("ignores a stale approval after %s", async (event) => {
		fixture();
		let answer!: (choice: string) => void;
		const select = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
		const fake = createFakePi();
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc", ui: { select } });
		await fake.fire("session_start", {}, ctx);
		startupConsentReady(fake.events);
		await Promise.resolve();
		await fake.fire(event, {}, createFakeCtx({ cwd }));
		answer(EXTERNAL_INCLUDES_YES);
		await Promise.resolve();
		expect(readExternalIncludesApproval(cwd, home)).toEqual({ approved: false, warningShown: false });
	});

	it("does not overwrite the external-import dialog with a startup hook consent dialog", async () => {
		fixture();
		write(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo fixture" }] }] } }));
		write(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "must-not-be-started" } } }));
		const fake = createFakePi();
		claudeContextExtension(fake.pi as never);
		hooksExtension(fake.pi as never);
		mcpExtension(fake.pi as never);
		let active = 0;
		let maximum = 0;
		const shown: string[] = [];
		const select = (title: string) => new Promise<string | undefined>((resolve) => {
			shown.push(title);
			maximum = Math.max(maximum, ++active);
			setImmediate(() => { active--; resolve(undefined); });
		});
		const ctx = createFakeCtx({ cwd, hasUI: true, mode: "tui", ui: { select, confirm: async (title: string) => (await select(title)) === "Yes" } });
		await fake.fire("session_start", {}, ctx);
		// Decline all prompts, as a person would; only one may be visible at a time.
		await fake.fire("before_agent_start", {}, ctx);
		expect(maximum).toBe(1);
		expect(shown[0]).not.toContain(EXTERNAL_INCLUDES_TITLE);
		expect(shown[1]).toContain("MCP");
		expect(shown[2]).toContain(EXTERNAL_INCLUDES_TITLE);
	});

	it("does not publish a waiting first turn after session shutdown", async () => {
		fixture();
		vi.stubEnv("GIT_AUTHOR_EMAIL", "fixture@example.test");
		let answer!: (choice: string) => void;
		const fake = createFakePi();
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc", ui: { select: () => new Promise<string>((resolve) => { answer = resolve; }) } });
		await fake.fire("session_start", {}, ctx);
		const turn = fake.fire("turn_start", {}, ctx);
		await Promise.resolve();
		await fake.fire("session_shutdown", {}, ctx);
		const emitted: unknown[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => emitted.push(data));
		answer(EXTERNAL_INCLUDES_YES);
		await turn;
		expect(emitted).toEqual([]);
	});

	it("does not open config after a shutdown while waiting for startup consent", async () => {
		fixture();
		const fake = createFakePi();
		claudeContextExtension(fake.pi as never);
		const select = vi.fn(async (title: string): Promise<string | undefined> => title.startsWith(EXTERNAL_INCLUDES_TITLE) ? new Promise(() => {}) : undefined);
		const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc", ui: { select } });
		await fake.fire("session_start", {}, ctx);
		const command = fake.commands.get("config")!.handler("", ctx as never);
		await Promise.resolve();
		await fake.fire("session_shutdown", {}, ctx);
		await command;
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("config can enable after a no without rewriting a sent prefix, and disable without a new approval", async () => {
		fixture();
		const { fake, ctx, select, texts } = await start(EXTERNAL_INCLUDES_NO);
		await fake.fire("turn_start", {}, ctx);
		const messages = [{ role: "user", content: [{ type: "text", text: "first prompt" }], timestamp: 1 }];
		const first = await fake.fireOne("context", { messages }, ctx);
		const startupCount = texts.length;
		select.mockImplementation(async (title, options) => title.startsWith(EXTERNAL_INCLUDES_TITLE) ? EXTERNAL_INCLUDES_YES : options[0]);
		await fake.commands.get("config")!.handler("", ctx as never);
		expect(readExternalIncludesApproval(cwd, home).approved).toBe(true);
		expect(texts).toHaveLength(startupCount);
		const next = await fake.fireOne("context", { messages }, ctx);
		expect(JSON.stringify((next as { messages: unknown[] }).messages[0])).toContain(ref(join(root, "shared.md")));
		expect(JSON.stringify(first)).not.toContain("APPROVED EXTERNAL INSTRUCTION");
		expect(JSON.stringify(next)).not.toContain("APPROVED EXTERNAL INSTRUCTION");
		write(join(cwd, "nested", "CLAUDE.md"), "@../../shared.md");
		const emitted: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => { const text = (data as { text?: string }).text; if (text) emitted.push(text); });
		await fake.fire("tool_result", { toolName: "read", input: { path: "nested/file.ts" }, isError: false }, ctx);
		expect(emitted.join("\n")).toContain("APPROVED EXTERNAL INSTRUCTION");
		const calls = select.mock.calls.length;
		await fake.commands.get("config")!.handler("", ctx as never);
		expect(select.mock.calls.length - calls).toBe(1);
		expect(readExternalIncludesApproval(cwd, home).approved).toBe(false);
	});
});

describe("startup probe and approved readers", () => {
	it.each(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/AGENTS.md", ".claude/rules/always.md"])("detects and admits external imports from %s only with consent", (name) => {
		const outside = fixture(name);
		expect(externalInstructionIncludes(opts())).toEqual([outside]);
		expect(JSON.stringify(discoverContextFiles(opts()))).not.toContain("APPROVED EXTERNAL INSTRUCTION");
		expect(JSON.stringify(discoverContextFiles({ ...opts(), includeExternal: true }))).toContain("APPROVED EXTERNAL INSTRUCTION");
	});

	it.each(["@../shared\\ notes.md", "@../shared\\ notes.md#instructions"])("loads a detected external import after approval: %s", (ref) => {
		const outside = write(join(root, "shared notes.md"), "VALID EXTERNAL IMPORT");
		write(join(cwd, "CLAUDE.md"), ref);
		expect(externalInstructionIncludes(opts())).toEqual([outside]);
		expect(JSON.stringify(discoverContextFiles({ ...opts(), includeExternal: true }))).toContain("VALID EXTERNAL IMPORT");
	});

	it("confines a project ONECODE.md's imports to the project until approved, and asks about them", () => {
		const outside = write(join(root, "shared.md"), "ONECODE EXTERNAL SECRET\n");
		const personal = write(join(home, "personal.md"), "ONECODE HOME SECRET\n");
		write(join(cwd, "ONECODE.md"), "Project One Code.\n@../shared.md\n@~/personal.md\n@inside.md\n");
		write(join(cwd, "inside.md"), "INSIDE ONECODE IMPORT\n");
		const state = join(root, "state");
		const oneCode = (includeExternal?: boolean) => JSON.stringify(discoverOneCodeFiles({ cwd, homeOneCodeDir: state, home, includeExternal }));
		expect(oneCode()).toContain("INSIDE ONECODE IMPORT");
		expect(oneCode()).not.toContain("ONECODE EXTERNAL SECRET");
		expect(oneCode()).not.toContain("ONECODE HOME SECRET");
		expect(oneCode(true)).toContain("ONECODE EXTERNAL SECRET");
		expect(oneCode(true)).toContain("ONECODE HOME SECRET");
		expect(externalInstructionIncludes(opts())).toEqual([outside, personal]);
		// The user's own global ONECODE.md is not project-controlled: its imports load and never ask.
		write(join(state, "ONECODE.md"), `@${write(join(root, "global-import.md"), "GLOBAL ONECODE IMPORT")}`);
		expect(oneCode()).toContain("GLOBAL ONECODE IMPORT");
		expect(externalInstructionIncludes(opts())).toEqual([outside, personal]);
		// A nested ONECODE.md attached on a read follows the same consent.
		write(join(cwd, "nested", "ONECODE.md"), "@../../shared.md");
		const nested = { ...opts(), filePath: join(cwd, "nested", "file.ts") };
		expect(JSON.stringify(nestedInstructionFiles(nested))).not.toContain("ONECODE EXTERNAL SECRET");
		expect(JSON.stringify(nestedInstructionFiles({ ...nested, includeExternal: true }))).toContain("ONECODE EXTERNAL SECRET");
	});

	it("asks before a project ONECODE.md loads an outside file into its block", async () => {
		write(join(root, "shared.md"), "ONECODE EXTERNAL SECRET\n");
		write(join(cwd, "ONECODE.md"), "Project One Code.\n@../shared.md\n");
		for (const choice of [EXTERNAL_INCLUDES_NO, EXTERNAL_INCLUDES_YES]) {
			rmSync(join(root, "state"), { recursive: true, force: true });
			const fake = createFakePi();
			const texts: string[] = [];
			fake.events.on(REMINDER_CHANNEL, (data) => {
				const payload = data as { key?: string; text?: string };
				if (payload.key === "one-code-context" && payload.text) texts.push(payload.text);
			});
			const select = vi.fn(async () => choice);
			const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc", ui: { select } });
			systemReminderExtension(fake.pi as never);
			claudeContextExtension(fake.pi as never);
			await fake.fire("session_start", {}, ctx);
			await fake.fire("before_agent_start", {}, ctx);
			expect(select).toHaveBeenCalledOnce();
			expect(texts.at(-1)?.includes("ONECODE EXTERNAL SECRET")).toBe(choice === EXTERNAL_INCLUDES_YES);
		}
	});

	it("reads an import that ends a sentence the same way with and without approval", () => {
		const outside = write(join(root, "shared.md"), "APPROVED EXTERNAL INSTRUCTION\n");
		write(join(cwd, "docs", "x.md"), "INSIDE PUNCTUATED IMPORT\n");
		write(join(cwd, "CLAUDE.md"), "See @docs/x.md.\nAlso @../shared.md, please.\n");
		expect(JSON.stringify(discoverContextFiles(opts()))).toContain("INSIDE PUNCTUATED IMPORT");
		expect(externalInstructionIncludes(opts())).toEqual([outside]);
		const approved = JSON.stringify(discoverContextFiles({ ...opts(), includeExternal: true }));
		expect(approved).toContain("INSIDE PUNCTUATED IMPORT");
		expect(approved).toContain("APPROVED EXTERNAL INSTRUCTION");
	});

	it("treats a .claude/CLAUDE.md linked to a file outside the project as an external include", () => {
		const outside = write(join(root, "outside", "secret.md"), "LINKED DOT CLAUDE SECRET");
		mkdirSync(join(cwd, ".claude"));
		symlinkSync(outside, join(cwd, ".claude", "CLAUDE.md"));
		expect(externalInstructionIncludes(opts())).toEqual([outside]);
		expect(JSON.stringify(discoverContextFiles(opts()))).not.toContain("LINKED DOT CLAUDE SECRET");
		expect(JSON.stringify(discoverContextFiles({ ...opts(), includeExternal: true }))).toContain("LINKED DOT CLAUDE SECRET");
		// A link that stays inside the project is the project's own file.
		rmSync(join(cwd, ".claude", "CLAUDE.md"));
		symlinkSync(write(join(cwd, "docs", "rules.md"), "LINKED INSIDE RULES"), join(cwd, ".claude", "CLAUDE.md"));
		expect(externalInstructionIncludes(opts())).toEqual([]);
		expect(JSON.stringify(discoverContextFiles(opts()))).toContain("LINKED INSIDE RULES");
	});

	it("checks a linked instruction file's extension against the file it points to", () => {
		mkdirSync(join(cwd, ".claude"));
		symlinkSync(write(join(cwd, "image.png"), "NOT A TEXT INSTRUCTION"), join(cwd, ".claude", "CLAUDE.md"));
		expect(JSON.stringify(discoverContextFiles({ ...opts(), includeExternal: true }))).not.toContain("NOT A TEXT INSTRUCTION");
	});

	it("detects transitive external imports, home imports and in-project symlinks to outside files", () => {
		const outside = write(join(root, "shared.md"), "External");
		const global = write(join(home, "personal.md"), "Personal");
		symlinkSync(outside, join(cwd, "alias.md"));
		write(join(cwd, "CLAUDE.md"), "@inside.md @alias.md @~/personal.md");
		write(join(cwd, "inside.md"), "@../shared.md");
		expect(externalInstructionIncludes(opts())).toEqual([outside, global]);
	});

	it("does not prompt for global user imports, missing/empty/oversized/non-text targets, or code examples", () => {
		write(join(home, ".claude", "CLAUDE.md"), ref(write(join(root, "global.md"), "User instruction")));
		write(join(root, "empty.md"), "  \n");
		write(join(root, "huge.md"), "x".repeat(4_194_305));
		write(join(root, "image.png"), "not a text instruction");
		write(join(root, "code.md"), "Do not import this example");
		write(join(cwd, "CLAUDE.md"), "@../missing.md @../empty.md @../huge.md @../image.png\n`@../code.md`\n```\n@../code.md\n```\n");
		expect(externalInstructionIncludes(opts())).toEqual([]);
	});

	it("approval never admits an external target the reference parser rejects", () => {
		write(join(root, "image.png"), "NOT A TEXT INSTRUCTION");
		write(join(cwd, "CLAUDE.md"), "@../image.png");
		expect(externalInstructionIncludes(opts())).toEqual([]);
		expect(JSON.stringify(discoverContextFiles({ ...opts(), includeExternal: true }))).not.toContain("NOT A TEXT INSTRUCTION");
		write(join(cwd, "nested", "CLAUDE.md"), "@../../image.png");
		expect(JSON.stringify(nestedInstructionFiles({ ...opts(), filePath: join(cwd, "nested", "file.ts"), includeExternal: true }))).not.toContain("NOT A TEXT INSTRUCTION");
	});

	it("excludes conditional rules from the startup warning; remembered consent covers them on read", () => {
		const outside = fixture(".claude/rules/conditional.md");
		write(join(cwd, ".claude/rules/conditional.md"), `---\npaths: '*.ts'\n---\n${ref(outside)}`);
		// The imported file needs the same condition, otherwise it is an unconditional startup record (CC).
		write(outside, "---\npaths: '*.ts'\n---\nAPPROVED EXTERNAL INSTRUCTION");
		expect(externalInstructionIncludes(opts())).toEqual([]);
		const nested = { ...opts(), filePath: join(cwd, "file.ts") };
		expect(JSON.stringify(nestedInstructionFiles(nested))).not.toContain("APPROVED EXTERNAL INSTRUCTION");
		expect(JSON.stringify(nestedInstructionFiles({ ...nested, includeExternal: true }))).toContain("APPROVED EXTERNAL INSTRUCTION");
	});

	it("detects managed external imports and linked rule files/directories, not a root CLAUDE.md symlink", () => {
		const outside = write(join(root, "outside", "linked.md"), "External rule");
		mkdirSync(join(cwd, ".claude", "rules"), { recursive: true });
		symlinkSync(dirname(outside), join(cwd, ".claude", "rules", "linked"));
		expect(externalInstructionIncludes(opts())).toEqual([outside]);
		expect(JSON.stringify(discoverContextFiles(opts()))).not.toContain("External rule");
		expect(JSON.stringify(discoverContextFiles({ ...opts(), includeExternal: true }))).toContain("External rule");
		rmSync(join(cwd, ".claude"), { recursive: true });
		symlinkSync(outside, join(cwd, "CLAUDE.md"));
		expect(externalInstructionIncludes(opts())).toEqual([]);
		write(join(root, "managed", "CLAUDE.md"), ref(outside));
		expect(externalInstructionIncludes(opts())).toEqual([outside]);
	});

	it("retains independent-mode exclusions even after approval", () => {
		resetConfigModeForTest("independent");
		const outside = write(join(root, ".claude", "hidden.md"), `CLAUDE SECRET\n${ref(write(join(root, "transitive.md"), "HIDDEN TRANSITIVE RULE"))}`);
		write(join(cwd, "AGENTS.md"), ref(outside));
		expect(externalInstructionIncludes({ ...opts(), rule: "agents-md" })).toEqual([]);
		expect(JSON.stringify(discoverContextFiles({ ...opts(), rule: "agents-md", includeExternal: true }))).not.toContain("CLAUDE SECRET");
		expect(JSON.stringify(discoverContextFiles({ ...opts(), rule: "agents-md", includeExternal: true }))).not.toContain("HIDDEN TRANSITIVE RULE");
	});
});

describe("durable approval and dialog fidelity", () => {
	it("shares the repo answer across subdirectories and linked worktrees, not unrelated projects", () => {
		mkdirSync(join(cwd, ".git", "worktrees", "linked"), { recursive: true });
		const linked = join(root, "linked");
		write(join(linked, ".git"), `gitdir: ${join(cwd, ".git", "worktrees", "linked")}\n`);
		write(join(cwd, ".git", "worktrees", "linked", "gitdir"), `${join(linked, ".git")}\n`);
		persistExternalIncludesApproval(cwd, home, true);
		expect(readExternalIncludesApproval(join(cwd, "src"), home).approved).toBe(true);
		expect(readExternalIncludesApproval(linked, home).approved).toBe(true);
		expect(readExternalIncludesApproval(root, home).approved).toBe(false);
		persistExternalIncludesApproval(linked, home, false);
		expect(readExternalIncludesApproval(cwd, home)).toEqual({ approved: false, warningShown: true });
	});

	it("keys the answer by the exact project root, not the settings file's lossy slug", () => {
		const dashed = join(root, "my-app");
		const underscored = join(root, "my_app");
		mkdirSync(dashed);
		mkdirSync(underscored);
		const path = oneCodeProjectSettingsPath(dashed, home);
		expect(oneCodeProjectSettingsPath(underscored, home)).toBe(path);
		persistExternalIncludesApproval(dashed, home, true);
		expect(readExternalIncludesApproval(dashed, home)).toEqual({ approved: true, warningShown: true });
		expect(readExternalIncludesApproval(underscored, home)).toEqual({ approved: false, warningShown: false });
		persistExternalIncludesApproval(underscored, home, false);
		expect(readExternalIncludesApproval(dashed, home)).toEqual({ approved: false, warningShown: false });
		// An answer recorded without its root cannot say which project gave it: ask again.
		write(path, JSON.stringify({ hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true }));
		expect(readExternalIncludesApproval(dashed, home)).toEqual({ approved: false, warningShown: false });
	});

	it("uses the same project consent when the checkout is entered through a symlink", () => {
		mkdirSync(join(cwd, ".git"));
		const alias = join(root, "alias");
		symlinkSync(cwd, alias);
		persistExternalIncludesApproval(alias, home, true);
		expect(readExternalIncludesApproval(cwd, home)).toEqual({ approved: true, warningShown: true });
		persistExternalIncludesApproval(cwd, home, false);
		expect(readExternalIncludesApproval(alias, home)).toEqual({ approved: false, warningShown: true });
		expect(safetyControlWrite({ cwd: alias, home, toolName: "write", input: { path: oneCodeProjectSettingsPath(cwd, home) } })).toBeDefined();
	});

	it("round-trips other keys, treats malformed/non-boolean values as no approval, and never writes Claude state", () => {
		const path = oneCodeProjectSettingsPath(cwd, home);
		write(path, JSON.stringify({ unrelated: 7, hasClaudeMdExternalIncludesApproved: "true" }));
		expect(readExternalIncludesApproval(cwd, home).approved).toBe(false);
		persistExternalIncludesApproval(cwd, home, true);
		expect(JSON.parse(readFileSync(path, "utf8")).unrelated).toBe(7);
		expect(existsSync(join(home, ".claude.json"))).toBe(false);
		expect(existsSync(join(home, ".claude"))).toBe(false);
		write(path, "invalid JSON");
		expect(readExternalIncludesApproval(cwd, home).approved).toBe(false);
		expect(() => persistExternalIncludesApproval(cwd, home, true)).toThrow();
	});

	it("keeps the approval file behind the gate-control safety floor", () => {
		const path = oneCodeProjectSettingsPath(cwd, home);
		for (const toolName of ["write", "edit"]) expect(safetyControlWrite({ cwd, home, toolName, input: { path } })).toBeDefined();
		expect(safetyControlWrite({ cwd, home, toolName: "bash", input: { command: `echo '{}' > '${path}'` } })).toBeDefined();
	});

	it("uses the exact dialog copy and the eight/six-path preview cap", () => {
		const paths = Array.from({ length: 9 }, (_, i) => join(home, `rule-${i}.md`));
		const text = externalIncludesDialog(paths, home);
		expect(text).toBe([
			"Allow external CLAUDE.md file imports?",
			"This project's CLAUDE.md or .claude/rules imports files outside the current working directory. Never allow this for third-party repositories.",
			"External imports:\n" + Array.from({ length: 6 }, (_, i) => `  ~/rule-${i}.md`).join("\n") + "\n  … +3 imports not shown.\n  Yes covers those too, plus any this project adds later.",
			"Important: Only use One Code with files you trust. Accessing untrusted files may pose security risks.",
		].join("\n\n"));
		expect(externalIncludesDialog(paths.slice(0, 8), home)).toContain("~/rule-7.md");
		expect(externalIncludesDialog(paths.slice(0, 8), home)).not.toContain("not shown");
	});
});
