/**
 * Claude Code's tool texts, per tier and permission mode (lib/tool-variants.ts,
 * decisions/system-prompt.md "Four registers"): frontier and workhorse carry
 * the short forms, cheap and tiny the long ones, and Bash's short form drops
 * its "avoid cat/head/…" bullet when the first request is in auto mode. Each shipped text is locked by
 * its length and a hash, so an accidental edit shows up here; the wiring tests
 * check that a tool is registered again only when its text changes, which is
 * what keeps the tools array byte-stable within a session.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import askUserExtension from "../../extensions/ask-user/index.ts";
import { ASK_LONG_DESCRIPTION, ASK_SHORT_DESCRIPTION } from "../../extensions/ask-user/description.ts";
import { BASH_AVOID_SHELL_READS_LINE, BASH_LONG_DESCRIPTION, BASH_SHORT_DESCRIPTION, bashDescription } from "../../extensions/bash/description.ts";
import bashExtension from "../../extensions/bash/index.ts";
import { NOTEBOOK_EDIT_DESCRIPTION } from "../../extensions/notebook/description.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/permissions/modes.ts";
import { AGENT_HOW_AGENTS_RUN, AGENT_LONG_DESCRIPTION, AGENT_SHORT_DESCRIPTION, agentDescription } from "../../extensions/subagents/agent-description.ts";
import { TASK_CREATE_DESCRIPTION, TASK_GET_DESCRIPTION, TASK_LIST_DESCRIPTION, TASK_UPDATE_DESCRIPTION } from "../../extensions/tasks/descriptions.ts";
import toolStyleExtension from "../../extensions/tool-style/index.ts";
import { WRITE_LONG_DESCRIPTION, WRITE_SHORT_DESCRIPTION } from "../../extensions/tool-style/write-description.ts";
import { WEB_SEARCH_LONG_DESCRIPTION, WEB_SEARCH_SHORT_DESCRIPTION } from "../../extensions/web/description.ts";
import webSearchExtension from "../../extensions/web/index.ts";
import { WEB_FETCH_LONG_DESCRIPTION, WEB_FETCH_SHORT_DESCRIPTION } from "../../extensions/web-fetch/description.ts";
import webFetchExtension from "../../extensions/web-fetch/index.ts";
import { ENTER_WORKTREE_DESCRIPTION, EXIT_WORKTREE_DESCRIPTION } from "../../extensions/worktree/descriptions.ts";
import { descriptionForm, registerVariantTool } from "../../extensions/lib/tool-variants.ts";
import { CONTEXT_BASELINE_CHANNEL, CONTEXT_RESTORE_CHANNEL } from "../../extensions/lib/context-stack.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("description form by tier", () => {
	it("gives frontier and workhorse the short forms, cheap and tiny the long ones", () => {
		expect(descriptionForm("frontier")).toBe("short");
		expect(descriptionForm("workhorse")).toBe("short");
		expect(descriptionForm("cheap")).toBe("long");
		expect(descriptionForm("tiny")).toBe("long");
	});
});

describe("the shipped texts", () => {
	it.each([
		["Bash short, auto mode", bashDescription("short", true), 1021, "ffaa03fd9f7cc324"],
		["Bash short, other modes", bashDescription("short", false), 1331, "3c6af5ed508abb0f"],
		["Bash long", BASH_LONG_DESCRIPTION, 10117, "150cfe7f15de9c0f"],
		["Agent short (Claude Code's part)", AGENT_SHORT_DESCRIPTION, 1748, "6c060a75532401b1"],
		["Agent long (Claude Code's part)", AGENT_LONG_DESCRIPTION, 7006, "ca6dbca76678c21b"],
		["Write short", WRITE_SHORT_DESCRIPTION, 240, "6b258dbec215234d"],
		["Write long", WRITE_LONG_DESCRIPTION, 618, "abb9cbaad9e678a9"],
		["AskUserQuestion short", ASK_SHORT_DESCRIPTION, 1760, "28629d142d565b3f"],
		["AskUserQuestion long", ASK_LONG_DESCRIPTION, 1505, "0251bfa975d4b3f9"],
		["WebFetch long", WEB_FETCH_LONG_DESCRIPTION, 1653, "332637519274c002"],
		["WebSearch long", WEB_SEARCH_LONG_DESCRIPTION, 1473, "e552812379795d9b"],
		["NotebookEdit", NOTEBOOK_EDIT_DESCRIPTION, 803, "5a701ed8db42b168"],
		["TaskCreate", TASK_CREATE_DESCRIPTION, 2148, "031fab8e56dfee27"],
		["TaskUpdate", TASK_UPDATE_DESCRIPTION, 2245, "d0d6e2f7e19354e7"],
		["TaskGet", TASK_GET_DESCRIPTION, 733, "4158d4726eb58d59"],
		["TaskList", TASK_LIST_DESCRIPTION, 1001, "87e632e37738bf17"],
		["EnterWorktree", ENTER_WORKTREE_DESCRIPTION, 2179, "58fec66cb2bdb541"],
		["ExitWorktree", EXIT_WORKTREE_DESCRIPTION, 1773, "c559deab629a0b43"],
	])("%s", (_name, text, length, hash) => {
		expect(text.length).toBe(length);
		expect(sha(text)).toBe(hash);
	});

	it("Bash: the short form drops only the avoid-cat bullet in auto mode; the long form ignores the mode", () => {
		expect(BASH_SHORT_DESCRIPTION).toContain(BASH_AVOID_SHELL_READS_LINE);
		expect(bashDescription("short", true)).not.toContain("IMPORTANT: Avoid using this tool");
		expect(bashDescription("short", false).replace(BASH_AVOID_SHELL_READS_LINE, "")).toBe(bashDescription("short", true));
		expect(bashDescription("long", true)).toBe(bashDescription("long", false));
	});

	it("never promises a working directory that carries over between calls", () => {
		for (const text of [bashDescription("short", true), bashDescription("short", false), BASH_LONG_DESCRIPTION]) {
			expect(text).not.toMatch(/working directory persists/i);
			expect(text).toMatch(/starts in the session's working directory/);
		}
	});

	it("Agent: One Code's paragraph follows Claude Code's text in both forms", () => {
		expect(agentDescription("short")).toBe(`${AGENT_SHORT_DESCRIPTION}\n\n${AGENT_HOW_AGENTS_RUN}`);
		expect(agentDescription("long")).toBe(`${AGENT_LONG_DESCRIPTION.trimEnd()}\n\n${AGENT_HOW_AGENTS_RUN}`);
		expect(AGENT_HOW_AGENTS_RUN).toContain("task_output");
		expect(AGENT_HOW_AGENTS_RUN).toContain('`action: "list"`');
	});

	it("names One Code's tools, not Claude Code's", () => {
		const texts = [bashDescription("short", false), BASH_LONG_DESCRIPTION, WRITE_SHORT_DESCRIPTION, WRITE_LONG_DESCRIPTION, ASK_SHORT_DESCRIPTION, WEB_FETCH_LONG_DESCRIPTION, TASK_CREATE_DESCRIPTION, TASK_UPDATE_DESCRIPTION, TASK_LIST_DESCRIPTION, ENTER_WORKTREE_DESCRIPTION, EXIT_WORKTREE_DESCRIPTION];
		for (const text of texts) {
			expect(text).not.toMatch(/\b(Monitor|TaskCreate|TaskUpdate|TaskGet|TaskList|EnterPlanMode|ExitPlanMode|EnterWorktree|ExitWorktree|WebFetch)\b/);
			expect(text).not.toMatch(/\bUse (Read|Edit|Write)\b|the (Read|Edit|Write|Bash) tool\b/);
		}
	});
});

/** A stand-in session model; CC_PROMPT_TIER picks the tier. */
const someModel = { provider: "openai", id: "gpt-test", name: "gpt-test", input: ["text"], cost: { input: 1, output: 4 } };

async function switchTier(fake: FakePi, tier: string) {
	vi.stubEnv("CC_PROMPT_TIER", tier);
	await fake.fire("model_select", { type: "model_select", model: someModel, previousModel: undefined, source: "set" });
}

/** Counts registrations per tool name, so a test sees a re-registration. */
function countRegistrations(fake: FakePi): Map<string, number> {
	const counts = new Map<string, number>();
	const register = fake.pi.registerTool as (tool: { name: string }) => void;
	fake.pi.registerTool = (tool: { name: string }) => {
		counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
		register(tool);
	};
	return counts;
}

describe("switching forms mid-session", () => {
	it.each([["plan", "auto"], ["auto", "plan"]])("bash keeps its request prefix on a %s → %s switch", async (from, to) => {
		const fake = createFakePi();
		const counts = countRegistrations(fake);
		bashExtension(fake.pi as never);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: from, paused: false });
		await fake.fire("session_start", {}, createFakeCtx({ model: someModel }));
		await fake.fire("turn_start", {}, createFakeCtx({ model: someModel }));
		const before = fake.tools.get("bash")!;
		const registrations = counts.get("bash");
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: to, paused: false });
		await fake.fire("before_agent_start", {}, createFakeCtx({ model: someModel }));
		expect(fake.tools.get("bash")).toBe(before);
		expect(counts.get("bash")).toBe(registrations);
	});

	it("bash restores the first-request variant when resuming into a different live permission mode", async () => {
		vi.stubEnv("CC_PROMPT_TIER", "workhorse");
		const initial = createFakePi();
		const baselines: Record<string, unknown> = {};
		initial.events.on(CONTEXT_BASELINE_CHANNEL, (data) => {
			const baseline = data as { key: string; value: unknown };
			baselines[baseline.key] = baseline.value;
		});
		bashExtension(initial.pi as never);
		initial.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		await initial.fire("session_start", {}, createFakeCtx({ model: someModel }));
		await initial.fire("turn_start", {}, createFakeCtx({ model: someModel }));
		const before = initial.tools.get("bash")!.description;

		const resumed = createFakePi();
		const counts = countRegistrations(resumed);
		resumed.events.on(CONTEXT_RESTORE_CHANNEL, (data) => Object.assign(data as object, { restored: { version: 1, stack: [], sticky: [], baselines } }));
		bashExtension(resumed.pi as never);
		resumed.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "auto", paused: false });
		await resumed.fire("session_start", {}, createFakeCtx({ model: someModel }));
		await resumed.fire("turn_start", {}, createFakeCtx({ model: someModel }));
		expect(resumed.tools.get("bash")!.description).toBe(before);
		// A temporary auto registration followed by restoring plan would still
		// move bash to the end of pi's tool list, invalidating the prefix.
		expect(counts.get("bash")).toBe(1);
	});

	it("bash follows the tier and the initial permission mode, and re-registers only on a change", async () => {
		const fake = createFakePi();
		const counts = countRegistrations(fake);
		bashExtension(fake.pi as never);
		expect(fake.tools.get("bash")!.description).toBe(bashDescription("short", false));

		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "auto", paused: false });
		expect(fake.tools.get("bash")!.description).toBe(bashDescription("short", true));
		// The badge re-announces the mode on every turn: no new registration.
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "auto", paused: false });
		await switchTier(fake, "frontier");
		expect(counts.get("bash")).toBe(2);

		await switchTier(fake, "cheap");
		expect(fake.tools.get("bash")!.description).toBe(BASH_LONG_DESCRIPTION);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "default", paused: false });
		expect(counts.get("bash")).toBe(3);

		await switchTier(fake, "workhorse");
		expect(fake.tools.get("bash")!.description).toBe(bashDescription("short", false));
	});

	it("the form is applied at session start from the session's model", async () => {
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		vi.stubEnv("CC_PROMPT_TIER", "tiny");
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, createFakeCtx({ model: someModel }));
		expect(fake.tools.get("bash")!.description).toBe(BASH_LONG_DESCRIPTION);
	});

	it.each([
		["ask_user_question", askUserExtension, ASK_SHORT_DESCRIPTION, ASK_LONG_DESCRIPTION],
		["web_fetch", webFetchExtension, WEB_FETCH_SHORT_DESCRIPTION, WEB_FETCH_LONG_DESCRIPTION],
		["web_search", webSearchExtension, WEB_SEARCH_SHORT_DESCRIPTION, WEB_SEARCH_LONG_DESCRIPTION],
		["write", toolStyleExtension, WRITE_SHORT_DESCRIPTION, WRITE_LONG_DESCRIPTION],
	] as const)("%s carries the short form, then the long one on a cheap model", async (name, extension, short, long) => {
		const fake = createFakePi();
		(extension as (pi: never) => void)(fake.pi as never);
		expect(fake.tools.get(name)!.description).toBe(short);
		await switchTier(fake, "cheap");
		expect(fake.tools.get(name)!.description).toBe(long);
		await switchTier(fake, "frontier");
		expect(fake.tools.get(name)!.description).toBe(short);
	});

	it("tool-style leaves read and edit with pi's own descriptions", async () => {
		const fake = createFakePi();
		toolStyleExtension(fake.pi as never);
		const before = { read: fake.tools.get("read")!.description, edit: fake.tools.get("edit")!.description };
		await switchTier(fake, "tiny");
		expect(fake.tools.get("read")!.description).toBe(before.read);
		expect(fake.tools.get("edit")!.description).toBe(before.edit);
		expect(before.read).toMatch(/^Read the contents of a file/);
	});

	it("registerVariantTool keeps the rest of the definition", () => {
		const fake = createFakePi();
		const execute = vi.fn();
		const set = registerVariantTool<string>(fake.pi as never, "a", (v: string) => ({ name: "probe", label: "Probe", description: v, parameters: {} as never, execute }) as never);
		set("b");
		expect(fake.tools.get("probe")!.description).toBe("b");
		expect(fake.tools.get("probe")!.execute).toBe(execute);
	});
});
