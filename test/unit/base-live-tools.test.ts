/**
 * The base's own words that name another tool follow the live tool set:
 * rendered with one optional tool off (lib/profile/features.ts TOOL_FEATURES),
 * they never name it. A profile's words are checked by the profile's own test
 * (One Code's: profile/test/profile-live-tools.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { LiveTools } from "../../extensions/lib/profile/live-tools.ts";
import type { ShellBlock } from "../../extensions/lib/shell-run/shell-text.ts";
import { notificationText } from "../../extensions/lib/notify/notifications-text.ts";
import { webFetchResultWords } from "../../extensions/tools/web-fetch/text.ts";
import { shellResultWords } from "../../extensions/lib/shell-run/shell-text.ts";
import { planModeResultWords } from "../../extensions/safety/plan-mode/text.ts";
import { subagentResultWords } from "../../extensions/lib/agents/subagent-text.ts";
import { permissionWords } from "../../extensions/lib/rules/permission-text.ts";
import { subagentModelWords } from "../../extensions/lib/models/subagent-model-text.ts";
import { profile } from "../../profile/index.ts";
import { ALL_LIVE } from "./helpers/live.ts";
import { type EnglishPhrases, type NamedText, toolLeaks } from "./helpers/tool-mentions.ts";

/** Phrases where a tool's name is an English word, not the tool. */
const ENGLISH: EnglishPhrases = { edit: [/write or edit any files/] };

function texts(live: LiveTools): NamedText[] {
	// The base's words take the profile's part where a sentence names another product.
	const t = profile.text({ live });
	const subagentModels = subagentModelWords(live, t.subagentModels!);
	const permissions = permissionWords(live);
	const notifications = notificationText(live, t.notifications);
	const out: NamedText[] = [];
	const push = (label: string, owner: string | undefined, text: string) => out.push([label, owner, text]);
	push("one-shot note", undefined, notifications.oneShotSession);
	push("model menu", undefined, subagentModels.menu({ lines: [], notes: [] }));
	push("refused model", undefined, subagentModels.refused({ model: "a/b" }));
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
	for (const block of blocks) push(`shell blocked ${block.kind}`, "bash", shellResultWords(live).blocked(block));
	push("shell background started", "bash", shellResultWords(live).backgroundStarted({ label: "Bash", id: "b1", description: "d", logPath: "/l" }));
	const runs = [{ name: "a", taskId: "t1" }];
	push("Agent launched", "subagents", subagentResultWords(live).launched({ lines: ["x"] }));
	push("Agent inline report", "subagents", subagentResultWords(live).inlineReport({ name: "a", taskId: "t1", note: "n" }));
	push("SendMessage next turn", "subagents", subagentResultWords(live).nextTurn({ name: "a" }));
	push("SendMessage to resident", "subagents", subagentResultWords(live).sentToResident({ name: "a", taskId: "t1" }));
	push("SendMessage sent", "subagents", subagentResultWords(live).sent({ name: "a", taskId: "t1" }));
	push("pending claim", "subagents", subagentResultWords(live).pendingClaim({ runs }));
	push("running after compaction", "subagents", subagentResultWords(live).runningAfterCompaction({ runs }));
	push("plan mode entered", "plan-mode", planModeResultWords(live).entered("/p.md"));
	push("plan mode refusal", undefined, permissions.refused({ kind: "planMode" }));
	push("web_fetch failed", "web-fetch", webFetchResultWords(live).failed({ url: "u", failure: { kind: "httpStatus", status: 500, statusText: "x" } }));
	return out;
}

describe("the base's words naming another tool", () => {
	it("leave out the tools of each optional feature that is off, and edit", () => {
		expect(toolLeaks(texts, ENGLISH)).toEqual([]);
	});

	it("name the tools when every one is on", () => {
		const all = texts(ALL_LIVE).map(([, , text]) => text).join("\n");
		for (const tool of ["task_output", "monitor", "SendMessage"]) expect(all, tool).toContain(tool);
	});
});
