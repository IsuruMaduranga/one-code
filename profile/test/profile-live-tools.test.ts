/**
 * Text that names another tool follows the live tool set: rendered with one
 * optional tool off (lib/profile/features.ts TOOL_FEATURES), One Code's texts never
 * name it. The golden sweep checks the same on a real frontier request
 * (test/e2e/golden-requests.mjs --sweep); this covers every tier and form.
 * The English words some tool names share ("a skill", "git workflow") are
 * listed in ENGLISH with the phrase that uses them. The base's own words:
 * test/unit/base-live-tools.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { LiveTools } from "../../extensions/lib/profile/live-tools.ts";
import type { DescriptionForm } from "../../extensions/lib/profile/tool-variants.ts";
import type { FixPromptInput } from "../../extensions/commands/doctor/text.ts";
import { profile } from "../index.ts";
import { PROMPT_TIERS } from "../../extensions/lib/models/model-tier.ts";
import { type EnglishPhrases, type NamedText, stalePassages, toolLeaks } from "../../test/unit/helpers/tool-mentions.ts";

/** Phrases where a tool's name is an English word, not the tool. */
const ENGLISH: EnglishPhrases = {
	edit: [/about to edit \(an edit needs a read first\)/, /a shell edit/, /edit that file/, /write or edit any files/, /allowed to edit/, /the only file you can edit/],
	// The PowerShell description compares its syntax with the bash language.
	bash: [/work like bash/, /works similarly to bash/, /or bash `export`/],
	monitor: [/monitor for regressions/],
	skill: [/a skill or slash command/],
	workflow: [/through this workflow/],
};

const FORMS: DescriptionForm[] = ["short", "long"];

const FIX_INPUT: FixPromptInput = {
	reportText: "report",
	install: "app",
	productVersion: "1.0.0",
	sessionsDir: "/s",
	sessionDir: "/s/p",
	productSettingsPath: "/u.json",
	productProjectSettingsPath: "/p.json",
	decisionLogEnabled: false,
	modeCycleKey: "shift+tab",
	upgradeCommands: { npm: "npm i", brew: "brew upgrade", "pi-package": "pi update" },
};

/** Every text of One Code's that names another tool. */
function texts(live: LiveTools): NamedText[] {
	const t = profile.text({ live });
	const { systemPrompt, planMode, askUser, subagents, toolStyle, shell, workflow, artifacts, toolSearch, permissions: autoMode, background } = t as Required<typeof t>;
	const out: NamedText[] = [];
	const push = (label: string, owner: string | undefined, text: string, tool?: string) => out.push([label, owner, text, tool]);
	for (const tier of PROMPT_TIERS) {
		for (const taskTools of [true, false]) {
			push(`systemPrompt ${tier}${taskTools ? "" : " no task tools"}`, undefined, systemPrompt.lead({ tier, taskTools: taskTools && live.has("task_create"), tools: undefined }).join("\n\n"));
		}
		push(`systemPrompt tail ${tier}`, undefined, systemPrompt.tail({ tier, taskTools: live.has("task_create"), tools: undefined }).join("\n\n"));
	}
	for (const form of FORMS) {
		push(`enter_plan_mode ${form}`, "plan-mode", planMode.descriptions.enter_plan_mode(form), "enter_plan_mode");
		push(`ask_user_question ${form}`, "ask-user", askUser.description(form), "ask_user_question");
		push(`Agent ${form}`, "subagents", subagents.agentDescription({ form, configDir: ".claude" }), "Agent");
		push(`write ${form}`, undefined, toolStyle.writeDescription(form));
		for (const autoModeOn of [true, false]) {
			for (const searchTools of [true, false]) push(`bash ${form}`, "bash", shell.bashDescription({ form, autoMode: autoModeOn, searchTools }), "bash");
		}
	}
	push("exit_plan_mode", "plan-mode", planMode.descriptions.exit_plan_mode, "exit_plan_mode");
	push("workflow", "workflow", workflow.description({ guideline: "medium", configured: false }), "workflow");
	push("workflow params", "workflow", JSON.stringify(workflow.params({ configDir: ".claude" })), "workflow");
	push("artifact", "artifacts", artifacts.description, "artifact");
	push("tool_search", "tool-search", toolSearch.description);
	push("monitor", "background", background.monitor.description, "monitor");
	push("task_output", "background", background.tasks.outputDescription, "task_output");
	for (const firm of [true, false]) push(`auto-mode note${firm ? " firm" : ""}`, undefined, autoMode.autoModeNote({ firm }));

	for (const edition of ["core", "desktop", "unknown"] as const) push(`powershell ${edition}`, "bash", shell.powershellDescription({ edition }), "powershell");
	for (const planExists of [true, false]) push("plan mode reminder", "plan-mode", planMode.reminder({ planFile: "/p.md", planExists }));
	return out;
}

describe("text naming another tool", () => {
	it("leaves out the tools of each optional feature that is off, and edit", () => {
		expect(toolLeaks(texts, ENGLISH)).toEqual([]);
	});

	it("has every passage its tables cut", () => {
		expect(stalePassages(texts)).toEqual([]);
	});

	it("leaves ask_user_question out of the /doctor fix prompt when it is off", () => {
		// The prompt also names skill and Agent calls as transcript shapes to count, not as tools to call.
		const off = profile.text({ live: { has: (tool) => tool !== "ask_user_question" } });
		expect(off.doctor?.fixPrompt(FIX_INPUT)).not.toContain("ask_user_question");
		expect(profile.text({ live: { has: () => true } }).doctor?.fixPrompt(FIX_INPUT)).toContain("with the `ask_user_question` tool");
	});

	it("gives a session without bash no auto-mode note, which is about working through bash", () => {
		const off = profile.text({ live: { has: (tool) => tool !== "bash" } });
		for (const firm of [true, false]) expect(off.permissions?.autoModeNote({ firm })).toBe("");
		expect(off.background?.tasks.outputDescription).toContain("(monitor or background subagent)");
	});

	it("is unchanged when every tool is on", () => {
		const all = profile.text({ live: { has: () => true } });
		expect(all.planMode?.descriptions.exit_plan_mode).toContain("ask_user_question");
		expect(all.askUser?.description("short")).toContain("enter_plan_mode");
	});
});
