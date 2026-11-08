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
import type { ShellBlock } from "../../extensions/lib/shell-text.ts";
import type { FixPromptInput } from "../../extensions/doctor/text.ts";
import { profile } from "../index.ts";
import { PROMPT_TIERS } from "../../extensions/lib/model-tier.ts";

/** Phrases where a tool's name is an English word, not the tool. */
const ENGLISH: Readonly<Record<string, readonly RegExp[]>> = {
	edit: [/about to edit \(an edit needs a read first\)/, /a shell edit/, /edit that file/, /write or edit any files/, /allowed to edit/, /the only file you can edit/],
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

/** Every text that names another tool: its label, the feature that owns it (its own tools may name each other), and the text. */
function texts(live: LiveTools): [string, string | undefined, string][] {
	const t = profile.text({ live });
	const { systemPrompt, planMode, askUser, subagents, toolStyle, shell, notifications, workflow, artifacts, toolSearch, subagentModels, autoMode, permissions, webFetch } = t as Required<typeof t>;
	const out: [string, string | undefined, string][] = [];
	const push = (label: string, owner: string | undefined, text: string) => out.push([label, owner, text]);
	for (const tier of PROMPT_TIERS) {
		for (const taskTools of [true, false]) {
			push(`systemPrompt ${tier}${taskTools ? "" : " no task tools"}`, undefined, systemPrompt.lead({ tier, taskTools: taskTools && live.has("task_create"), tools: undefined }).join("\n\n"));
		}
		push(`systemPrompt tail ${tier}`, undefined, systemPrompt.tail({ tier, taskTools: live.has("task_create"), tools: undefined }).join("\n\n"));
	}
	for (const form of FORMS) {
		push(`enter_plan_mode ${form}`, "plan-mode", planMode.descriptions.enter_plan_mode(form));
		push(`ask_user_question ${form}`, "ask-user", askUser.description(form));
		push(`Agent ${form}`, "subagents", subagents.agentDescription({ form, configDir: ".claude" }));
		push(`write ${form}`, undefined, toolStyle.writeDescription(form));
		for (const autoModeOn of [true, false]) {
			for (const searchTools of [true, false]) push(`bash ${form}`, "bash", shell.bashDescription({ form, autoMode: autoModeOn, searchTools }));
		}
	}
	push("exit_plan_mode", "plan-mode", planMode.descriptions.exit_plan_mode);
	push("one-shot note", undefined, notifications.oneShotSession);
	push("workflow", "workflow", workflow.description({ guideline: "medium", configured: false }));
	push("workflow params", "workflow", JSON.stringify(workflow.params({ configDir: ".claude" })));
	push("artifact", "artifacts", artifacts.description);
	push("tool_search", "tool-search", toolSearch.description);
	push("model menu", undefined, subagentModels.menu({ lines: [], notes: [] }));
	push("refused model", undefined, subagentModels.refused({ model: "a/b" }));
	for (const firm of [true, false]) push(`auto-mode note${firm ? " firm" : ""}`, undefined, autoMode.systemNote({ firm }));

	// Results, refusals and notes: sent whenever their own feature is on.
	const blocks: ShellBlock[] = [
		{ kind: "sleep", shown: "sleep 30", sleepName: "sleep", untilExample: "until test -f x; do sleep 2; done" },
		{ kind: "pollingLoop", command: "while true; do sleep 5; done" },
		{ kind: "detach", via: "`nohup`" },
		{ kind: "editor", command: "vim" },
		{ kind: "watch" },
		{ kind: "rebaseInteractive", shell: "bash" },
		{ kind: "addInteractive" },
		{ kind: "consolePrompt", command: "Read-Host" },
	];
	for (const block of blocks) push(`shell blocked ${block.kind}`, "bash", shell.blocked(block));
	push("shell background started", "bash", shell.backgroundStarted({ label: "Bash", id: "b1", description: "d", logPath: "/l" }));
	for (const edition of ["core", "desktop", "unknown"] as const) push(`powershell ${edition}`, "bash", shell.powershellDescription({ edition }));
	const runs = [{ name: "a", taskId: "t1" }];
	push("Agent launched", "subagents", subagents.launched({ lines: ["x"] }));
	push("Agent inline report", "subagents", subagents.inlineReport({ name: "a", taskId: "t1", note: "n" }));
	push("SendMessage next turn", "subagents", subagents.nextTurn({ name: "a" }));
	push("SendMessage to resident", "subagents", subagents.sentToResident({ name: "a", taskId: "t1" }));
	push("SendMessage sent", "subagents", subagents.sent({ name: "a", taskId: "t1" }));
	push("pending claim", "subagents", subagents.pendingClaim({ runs }));
	push("running after compaction", "subagents", subagents.runningAfterCompaction({ runs }));
	push("plan mode entered", "plan-mode", planMode.entered("/p.md"));
	for (const planExists of [true, false]) push("plan mode reminder", "plan-mode", planMode.reminder({ planFile: "/p.md", planExists }));
	push("plan mode refusal", undefined, permissions.refused({ kind: "planMode" }));
	push("web_fetch failed", "web-fetch", webFetch.failed({ url: "u", failure: { kind: "httpStatus", status: 500, statusText: "x" } }));
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

	it("leaves ask_user_question out of the /doctor fix prompt when it is off", () => {
		// The prompt also names skill and Agent calls as transcript shapes to count, not as tools to call.
		const off = profile.text({ live: { has: (tool) => tool !== "ask_user_question" } });
		expect(off.doctor?.fixPrompt(FIX_INPUT)).not.toContain("ask_user_question");
		expect(profile.text({ live: { has: () => true } }).doctor?.fixPrompt(FIX_INPUT)).toContain("with the `ask_user_question` tool");
	});

	it("is unchanged when every tool is on", () => {
		const all = profile.text({ live: { has: () => true } });
		expect(all.planMode?.descriptions.exit_plan_mode).toContain("ask_user_question");
		expect(all.askUser?.description("short")).toContain("enter_plan_mode");
	});
});
