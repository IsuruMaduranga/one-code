/**
 * agents/subagents/result-display.ts and lib/ui/tui-render.ts
 * withResultDisplay: a background Agent launch and a message sent to a running
 * agent show Claude Code's short line in the transcript, never the
 * instructions their text gives the model. A report still shows as text.
 */
import { describe, expect, it } from "vitest";
import { agentResultDisplay, sendMessageResultDisplay } from "../../extensions/agents/subagents/result-display.ts";
import { withResultDisplay } from "../../extensions/lib/ui/tui-render.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const lines = ["⏳ explore-1 (task b90a3848) running in background — output file: /tmp/out.log"];
const launch = { background: true, agentRuns: [{ name: "explore-1" }], lines };

describe("agentResultDisplay", () => {
	it("shows a background launch as Claude Code's one line, with the launch lines and the prompt when expanded", () => {
		expect(agentResultDisplay(launch, { expanded: false, prompt: "Trace the check", expandHint: "ctrl+o to expand" })).toBe("Backgrounded agent (↓ to manage · ctrl+o to expand)");
		// The launch lines alone are worth expanding for; with nothing to expand there is no hint.
		expect(agentResultDisplay(launch, { expanded: false, expandHint: "ctrl+o to expand" })).toBe("Backgrounded agent (↓ to manage · ctrl+o to expand)");
		expect(agentResultDisplay({ background: true }, { expanded: false, expandHint: "ctrl+o to expand" })).toBe("Backgrounded agent (↓ to manage)");
		expect(agentResultDisplay(launch, { expanded: false, prompt: "Trace the check", expandHint: null })).toBe("Backgrounded agent (↓ to manage)");
		expect(agentResultDisplay(launch, { expanded: true, prompt: "  Trace the check\n" , expandHint: "ctrl+o to expand" })).toBe(`Backgrounded agent\n${lines[0]}\n\nTrace the check`);
	});

	it("leaves every other Agent result to the usual renderer", () => {
		expect(agentResultDisplay({ agentRuns: [{ name: "explore-1" }] }, { expanded: false, expandHint: null })).toBeUndefined();
		expect(agentResultDisplay(undefined, { expanded: true, expandHint: null })).toBeUndefined();
	});
});

describe("sendMessageResultDisplay", () => {
	it("shows a message whose reply comes later as one status line", () => {
		expect(sendMessageResultDisplay({ agentRuns: [{ name: "explore-1" }], pending: true })).toBe("Message sent to explore-1");
		expect(sendMessageResultDisplay({ agentRuns: [{ name: "explore-1" }], pending: true, steered: true })).toBe("Message queued for explore-1");
	});

	it("leaves a one-shot reply, which is a report, and a refusal to the usual renderer", () => {
		expect(sendMessageResultDisplay({ agentRuns: [{ name: "explore-1" }] })).toBeUndefined();
		expect(sendMessageResultDisplay({})).toBeUndefined();
	});
});

describe("withResultDisplay", () => {
	const usual = { renderResult: (_result: unknown, _options: unknown, _theme: unknown, _context: unknown) => ({ render: (_width: number) => ["usual"], invalidate: () => {} }) };
	const render = (details: unknown, isError = false, expanded = false) =>
		withResultDisplay(usual, (result, open) => agentResultDisplay(result.details, { expanded: open, prompt: "Trace the check", expandHint: "ctrl+o to expand" }))
			.renderResult({ content: [{ type: "text", text: "The agent is working in the background. You will be notified…" }], details }, { expanded, isPartial: false }, plain, { isError })
			.render(120);

	it("draws the display line under the elbow and none of the model's text", () => {
		const out = render(launch).join("\n");
		expect(out).toContain("⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)");
		expect(out).not.toContain("notified");
	});

	it("hands an error, or a result with no display line, to the tool's own renderer", () => {
		expect(render(launch, true)).toEqual(["usual"]);
		expect(render({})).toEqual(["usual"]);
	});
});
