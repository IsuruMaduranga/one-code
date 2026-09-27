import { describe, expect, it } from "vitest";
import { agentViewTarget, applyBorderBadge, fitBadge, unwrapUserMessage, userMessageForAgent } from "../../extensions/lib/agent-view.ts";
import { visibleWidth } from "../../extensions/lib/text-width.ts";
import { moveTasksSelection, renderTasksDialog, tasksItems } from "../../extensions/subagents/tasks-dialog.ts";

const paint = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

// Claude Code 2.1.283's agent view and /tasks dialog (findings §40).
describe("agentViewTarget", () => {
	it("targets a fork by its name", () => {
		expect(agentViewTarget({ name: "write-a-300-word", agentType: "fork", label: "write a 300-word poem" }, true)).toEqual({
			badge: "@write-a-300-word",
			placeholder: "Message @write-a-300-word…",
		});
	});

	it("labels a regular agent's border with its description and addresses its type", () => {
		expect(agentViewTarget({ name: "general-purpose-1", agentType: "general-purpose", label: "Read notes.txt and report after delay" }, false)).toEqual({
			badge: "Read notes.txt and report after delay",
			placeholder: "Message @general-purpose…",
		});
	});
});

describe("userMessageForAgent", () => {
	it("is Claude Code's mid-turn wrapper, and unwraps back to the typed text", () => {
		const wrapped = userMessageForAgent("now give it a one-line title only");
		expect(wrapped).toBe(
			"The user sent a new message while you were working:\nnow give it a one-line title only\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.",
		);
		expect(unwrapUserMessage(wrapped)).toBe("now give it a one-line title only");
		expect(unwrapUserMessage("Continue with the review")).toBeUndefined();
	});
});

describe("applyBorderBadge", () => {
	it("puts the badge at the right end of the top border, one glyph after it", () => {
		const lines = ["─".repeat(40), "  hello", "─".repeat(40)];
		const out = applyBorderBadge(lines, " @fork ", 7, "─");
		expect(out[0].endsWith(" @fork ─")).toBe(true);
		expect(visibleWidth(out[0])).toBe(40);
		expect(out.slice(1)).toEqual(lines.slice(1));
	});

	it("leaves a border too narrow for the badge alone", () => {
		const lines = ["─".repeat(8), "x"];
		expect(applyBorderBadge(lines, " @a-long-name ", 14, "─")).toBe(lines);
	});

	it("cuts a long label to half the width", () => {
		expect(fitBadge("Read notes.txt and report after delay", 40)).toBe("Read notes.txt a…");
		expect(fitBadge("@fork", 40)).toBe("@fork");
	});
});

describe("renderTasksDialog", () => {
	const shells = [{ kind: "shell" as const, id: "b1", text: "sleep 25; echo done", running: true }];
	const agents = [
		{ kind: "agent" as const, taskId: "a1", text: "Read notes.txt and report after delay", model: "Sonnet 5", running: true },
		{ kind: "agent" as const, taskId: "a2", text: "write a 300-word poem", model: "Haiku 4.5", running: false },
	];

	it("groups shells, local agents and completed agents under Claude Code's headers", () => {
		const out = renderTasksDialog({ shells, agents, selected: 0, width: 100 }, paint);
		expect(out).toEqual([
			"  Background",
			"  1 active shell · 1 active agent",
			"    Shells (1)",
			"  ❯ ⏺ sleep 25; echo done   running",
			"    Local agents (1)",
			"    ⏺ Read notes.txt and report after delay   running · Sonnet 5",
			"    Completed (1)",
			"    ✔ write a 300-word poem   done · Haiku 4.5",
			"  ↑/↓ to select · Enter to view · x to stop · Esc to close",
		]);
	});

	it("offers x only on a running row, and says so when nothing is listed", () => {
		expect(renderTasksDialog({ shells, agents, selected: 2, width: 100 }, paint).at(-1)).toBe("  ↑/↓ to select · Enter to view · Esc to close");
		expect(renderTasksDialog({ shells: [], agents: [], selected: 0, width: 100 }, paint)).toEqual([
			"  Background",
			"  No tasks currently running",
			"  ↑/↓ to select · Enter to view · Esc to close",
		]);
	});

	it("selects in display order and stops at the ends", () => {
		expect(tasksItems({ shells, agents }).map((item) => (item.kind === "shell" ? item.id : item.taskId))).toEqual(["b1", "a1", "a2"]);
		expect(moveTasksSelection(0, "up", 3)).toBe(0);
		expect(moveTasksSelection(2, "down", 3)).toBe(2);
		expect(moveTasksSelection(1, "down", 3)).toBe(2);
	});
});
