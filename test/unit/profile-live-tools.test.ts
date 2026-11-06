/**
 * Text that names another tool follows the live tool set: rendered with one
 * optional tool off (lib/features.ts TOOL_FEATURES), One Code's texts never
 * name it. The golden sweep checks the same on a real frontier request
 * (test/e2e/golden-requests.mjs --sweep); this covers every tier and form.
 * The English words some tool names share ("a skill", "git workflow") are
 * listed in ENGLISH with the phrase that uses them.
 */
import { describe, expect, it } from "vitest";
import { TOOL_FEATURES } from "../../extensions/lib/features.ts";
import type { LiveTools } from "../../extensions/lib/live-tools.ts";
import type { DescriptionForm } from "../../extensions/lib/tool-variants.ts";
import { artifacts } from "../../profile/artifacts/index.ts";
import { askUser } from "../../profile/ask-user/index.ts";
import { autoMode } from "../../profile/auto-mode/index.ts";
import { notifications } from "../../profile/notifications/index.ts";
import { planMode } from "../../profile/plan-mode/index.ts";
import { shell } from "../../profile/shell/index.ts";
import { subagentModels } from "../../profile/subagent-models/index.ts";
import { subagents } from "../../profile/subagents/index.ts";
import { systemPrompt } from "../../profile/system-prompt/index.ts";
import { toolSearch } from "../../profile/tool-search/index.ts";
import { toolStyle } from "../../profile/tool-style/index.ts";
import { workflow } from "../../profile/workflow/index.ts";

/** Phrases where a tool's name is an English word, not the tool. */
const ENGLISH: Readonly<Record<string, readonly RegExp[]>> = {
	edit: [/about to edit \(an edit needs a read first\)/, /a shell edit/, /edit that file/],
	monitor: [/monitor for regressions/],
	skill: [/a skill or slash command/],
};

const FORMS: DescriptionForm[] = ["short", "long"];

/** Every text that names another tool: its label, the feature that owns it (its own tools may name each other), and the text. */
function texts(live: LiveTools): [string, string | undefined, string][] {
	const out: [string, string | undefined, string][] = [];
	const push = (label: string, owner: string | undefined, text: string) => out.push([label, owner, text]);
	for (const tier of ["frontier", "workhorse", "cheap", "tiny"] as const) {
		for (const taskTools of [true, false]) {
			push(`systemPrompt ${tier}${taskTools ? "" : " no task tools"}`, undefined, systemPrompt.lead({ tier, taskTools, tools: undefined, live }).join("\n\n"));
		}
		push(`systemPrompt tail ${tier}`, undefined, systemPrompt.tail({ tier, taskTools: true, tools: undefined, live }).join("\n\n"));
	}
	for (const form of FORMS) {
		push(`enter_plan_mode ${form}`, "plan-mode", planMode.descriptions.enter_plan_mode(form, live));
		push(`ask_user_question ${form}`, "ask-user", askUser.description(form, live));
		push(`Agent ${form}`, "subagents", subagents.agentDescription({ form, configDir: ".claude", live }));
		push(`write ${form}`, undefined, toolStyle.writeDescription(form, live));
		for (const autoModeOn of [true, false]) {
			for (const searchTools of [true, false]) push(`bash ${form}`, "bash", shell.bashDescription({ form, autoMode: autoModeOn, searchTools, live }));
		}
	}
	push("exit_plan_mode", "plan-mode", planMode.descriptions.exit_plan_mode(live));
	push("one-shot note", undefined, notifications.oneShotSession({ live }));
	push("workflow", "workflow", workflow.description({ guideline: "medium", configured: false, live }));
	push("workflow params", "workflow", JSON.stringify(workflow.params({ configDir: ".claude", live })));
	push("artifact", "artifacts", artifacts.description({ live }));
	push("tool_search", "tool-search", toolSearch.description({ live }));
	push("model menu", undefined, subagentModels.menu({ lines: [], notes: [], live }));
	push("refused model", undefined, subagentModels.refused({ model: "a/b", live }));
	for (const firm of [true, false]) push(`auto-mode note${firm ? " firm" : ""}`, undefined, autoMode.systemNote({ firm, live }));
	return out;
}

/** The places a text still names `tool`, outside the English phrases. */
function mentions(text: string, tool: string): string[] {
	let rest = text;
	for (const phrase of ENGLISH[tool] ?? []) rest = rest.replace(new RegExp(phrase.source, `${phrase.flags.replace("g", "")}g`), "");
	const found: string[] = [];
	const rx = new RegExp(`(^|[^A-Za-z_-])${tool}([^A-Za-z_-]|$)`, "g");
	for (const match of rest.matchAll(rx)) found.push(rest.slice(Math.max(0, match.index - 50), match.index + tool.length + 40).replace(/\n/g, "⏎"));
	return found;
}

describe("text naming another tool", () => {
	it("leaves out the tools of each optional feature that is off, and edit", () => {
		const leaks: string[] = [];
		// The shell features are left out: with bash off the shell texts already
		// name the shell the session has (system-prompt/low.ts shellToolPhrase).
		const cases: { feature: string; off: string[] }[] = [...new Set<string>(Object.values(TOOL_FEATURES))]
			.filter((feature) => feature !== "bash" && feature !== "powershell")
			.map((feature) => ({ feature, off: Object.keys(TOOL_FEATURES).filter((tool) => TOOL_FEATURES[tool] === feature) }));
		cases.push({ feature: "edit", off: ["edit"] });
		for (const { feature, off } of cases) {
			const live: LiveTools = { has: (name) => !off.includes(name) };
			for (const [label, owner, text] of texts(live)) {
				if (owner === feature) continue;
				for (const tool of off) for (const where of mentions(text, tool)) leaks.push(`${tool} off, ${label}: …${where}…`);
			}
		}
		expect(leaks).toEqual([]);
	});

	it("is unchanged when every tool is on", () => {
		const all: LiveTools = { has: () => true };
		expect(planMode.descriptions.exit_plan_mode(all)).toContain("ask_user_question");
		expect(askUser.description("short", all)).toContain("enter_plan_mode");
	});
});
