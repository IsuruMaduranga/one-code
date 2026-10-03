/**
 * The plan-mode tools' texts: Claude Code's EnterPlanMode description on
 * frontier and workhorse models and One Code's on cheap and tiny ones, Claude
 * Code's ExitPlanMode description, and its enter, approve and reject results.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { userDenialText } from "../../extensions/lib/user-denial.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/permissions/modes.ts";
import planModeExtension from "../../extensions/plan-mode/index.ts";
import {
	approvedPlanText,
	ENTER_PLAN_MODE_DESCRIPTION,
	ENTER_PLAN_MODE_DESCRIPTION_WEAK,
	enteredPlanModeText,
	enterPlanModeDescription,
	EXIT_PLAN_MODE_DESCRIPTION,
	exitedPlanModeText,
} from "../../extensions/plan-mode/texts.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const OPUS = { provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages" };
const HAIKU = { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" };

describe("plan-mode tool descriptions", () => {
	it("enter_plan_mode carries Claude Code's description on frontier and workhorse, One Code's on cheap and tiny", () => {
		expect(enterPlanModeDescription("frontier")).toBe(ENTER_PLAN_MODE_DESCRIPTION);
		expect(enterPlanModeDescription("workhorse")).toBe(ENTER_PLAN_MODE_DESCRIPTION);
		expect(enterPlanModeDescription("cheap")).toBe(ENTER_PLAN_MODE_DESCRIPTION_WEAK);
		expect(enterPlanModeDescription("tiny")).toBe(ENTER_PLAN_MODE_DESCRIPTION_WEAK);
	});

	it("Claude Code's enter_plan_mode text prefers plan mode, with One Code's tool names", () => {
		const text = ENTER_PLAN_MODE_DESCRIPTION;
		expect(
			text.startsWith(
				"Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n## When to Use This Tool\n\n**Prefer using enter_plan_mode** for implementation tasks unless they're simple.",
			),
		).toBe(true);
		expect(text).toContain("   - If you would use ask_user_question to clarify the approach, use enter_plan_mode instead\n");
		expect(text).toContain("1. Thoroughly explore the codebase using `find`, `grep`, and read\n");
		expect(text).toContain("6. Exit plan mode with exit_plan_mode when ready to implement\n");
		expect(text.endsWith("- Users appreciate being consulted before significant changes are made to their codebase\n")).toBe(true);
		for (const name of ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "Glob", "Grep"]) expect(text).not.toContain(name);
		expect(text).toHaveLength(4017);
	});

	it("One Code's text for weak models still says most tasks do not need plan mode", () => {
		expect(ENTER_PLAN_MODE_DESCRIPTION_WEAK).toContain("Most tasks do not need it.");
	});

	it("exit_plan_mode carries Claude Code's description with One Code's tool names", () => {
		const text = EXIT_PLAN_MODE_DESCRIPTION;
		expect(
			text.startsWith(
				"Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\n\n## How This Tool Works\n- You should have already written your plan to the plan file specified in the plan mode system message\n",
			),
		).toBe(true);
		expect(text).toContain(
			'**Important:** Do NOT use ask_user_question to ask "Is this plan okay?" or "Should I proceed?" - that\'s exactly what THIS tool does. exit_plan_mode inherently requests user approval of your plan.\n',
		);
		expect(text).not.toContain("AskUserQuestion");
		expect(text).toHaveLength(1857);
	});
});

describe("plan-mode results", () => {
	it("enter_plan_mode returns Claude Code's text and names the plan file", () => {
		expect(enteredPlanModeText("/p/plan.md")).toBe(
			"Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.\n\nIn plan mode, you should:\n1. Thoroughly explore the codebase to understand existing patterns\n2. Identify similar features and architectural approaches\n3. Consider multiple approaches and their trade-offs\n4. Use ask_user_question if you need to clarify the approach\n5. Design a concrete implementation strategy\n6. When ready, use exit_plan_mode to present your plan for approval\n\nRemember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.\n\nYour plan file is /p/plan.md, the one file you may write: build your plan there.",
		);
	});

	it("an approval tells the model to start coding and repeats the plan", () => {
		expect(approvedPlanText("/p/plan.md", "# Plan\n\n1. do it\n")).toBe(
			"User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: /p/plan.md\nYou can refer back to it if needed during implementation.\n\n## Approved Plan:\n# Plan\n\n1. do it\n",
		);
		expect(exitedPlanModeText("/p/plan.md")).toBe(
			"## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions. The plan file is located at /p/plan.md if you need to reference it.",
		);
	});

	it("a rejection is Claude Code's denial text, with the user's words when they typed some", () => {
		expect(userDenialText()).toBe(
			"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.",
		);
		expect(userDenialText("  Use tabs.  ")).toBe(
			"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nUse tabs.\n\nNote: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.",
		);
		expect(userDenialText("   ")).toBe(userDenialText());
	});
});

describe("plan-mode wiring of the texts", () => {
	let fake: FakePi;
	let stateDir: string;
	const reminders: Array<{ key?: string; text?: string; placement?: string }> = [];

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "plan-mode-texts-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		vi.stubEnv("CC_PROMPT_TIER", "");
		fake = createFakePi();
		reminders.length = 0;
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		planModeExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("re-registers enter_plan_mode with the session model's tier text, and only when that text changes", async () => {
		const register = vi.spyOn(fake.pi as { registerTool: (tool: unknown) => void }, "registerTool");
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: stateDir, model: OPUS }));
		expect(fake.tools.get("enter_plan_mode")!.description).toBe(ENTER_PLAN_MODE_DESCRIPTION);
		// The load-time registration already carried the frontier text: nothing re-registered.
		expect(register).not.toHaveBeenCalled();

		await fake.fireOne("model_select", { model: HAIKU }, createFakeCtx({ cwd: stateDir, model: HAIKU }));
		expect(fake.tools.get("enter_plan_mode")!.description).toBe(ENTER_PLAN_MODE_DESCRIPTION_WEAK);
		expect(register).toHaveBeenCalledTimes(1);

		await fake.fireOne("model_select", { model: HAIKU }, createFakeCtx({ cwd: stateDir, model: HAIKU }));
		expect(register).toHaveBeenCalledTimes(1);
	});

	it("freezes the Plan File Info line at entry, so the standing block does not change once the plan is written", async () => {
		const ctx = createFakeCtx({ cwd: stateDir });
		await fake.fireOne("session_start", {}, ctx);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const first = reminders.find((r) => r.key === "permission-mode")!.text!;
		expect(first).toContain("No plan file exists yet.");

		const entered = (await fake.tools.get("enter_plan_mode")!.execute("t1", {}, undefined, undefined, ctx)) as { details: { planFilePath: string } };
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(entered.details.planFilePath, "# Plan\n");
		reminders.length = 0;
		await fake.fireOne("before_agent_start", {}, ctx);
		expect(reminders.find((r) => r.key === "permission-mode")!.text).toBe(first);

		// A later plan-mode run sees the file and says so.
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "default", paused: false });
		reminders.length = 0;
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		expect(reminders.find((r) => r.key === "permission-mode")!.text).toContain(`A plan file already exists at ${entered.details.planFilePath}.`);
	});

	type ViewerComponent = { render: (width: number) => string[]; handleInput: (data: string) => void };
	type ViewerFactory = (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => ViewerComponent;
	const answer = (key: string) =>
		vi.fn(async (factory: ViewerFactory) => {
			let picked: unknown;
			const component = factory({ requestRender: () => {} }, {}, {}, (v) => (picked = v));
			component.render(120);
			component.handleInput(key);
			return picked;
		});

	const planned = async (custom: ReturnType<typeof answer>) => {
		const ctx = createFakeCtx({ cwd: stateDir, hasUI: true, modelRegistry: { getAvailable: () => [] }, ui: { custom } });
		await fake.fireOne("session_start", {}, ctx);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false });
		const entered = (await fake.tools.get("enter_plan_mode")!.execute("t1", {}, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			details: { planFilePath: string };
		};
		expect(entered.content[0].text).toBe(enteredPlanModeText(entered.details.planFilePath));
		mkdirSync(join(stateDir, "plans"), { recursive: true });
		writeFileSync(entered.details.planFilePath, "# Plan\n\n1. do it\n");
		reminders.length = 0;
		const result = (await fake.tools.get("exit_plan_mode")!.execute("t2", {}, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		return { result, path: entered.details.planFilePath };
	};

	it("an approval returns Claude Code's text with the plan and queues the exited-plan-mode reminder", async () => {
		const { result, path } = await planned(answer("\r"));
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toBe(approvedPlanText(path, "# Plan\n\n1. do it\n"));
		expect(reminders.map((r) => r.text)).toContain(exitedPlanModeText(path));
	});

	it("keeping on planning returns Claude Code's rejection as an error", async () => {
		const { result } = await planned(answer("\x1b"));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe(userDenialText());
		expect(reminders.map((r) => r.text)).not.toContain(expect.stringContaining("## Exited Plan Mode"));
	});
});
