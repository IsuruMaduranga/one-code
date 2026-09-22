import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMessage, frameForDelivery, handBackPointer, taskNotification } from "../../extensions/lib/notifications.ts";
import {
	bulletColor,
	callLine,
	ccToolRenderers,
	formatFireTime,
	scheduledTaskComponent,
	collapseLines,
	customMessageText,
	linesComponent,
	notificationBody,
	notificationComponent,
	resultLines,
	SPINNER_COLORS,
	SPINNER_INTERVAL_MS,
	spinnerBulletColor,
	panelTopRule,
	searchBoxLines,
	summarizeArgs,
	textContent,
	truncateLine,
	type ThemeLike,
	stripHarnessText,
	stripReminderBlocks,
} from "../../extensions/lib/tui-render.ts";

/** Theme stub that tags text with the color name so assertions can see it. */
const theme: ThemeLike = {
	fg: (color, text) => `<${color}>${text}</>`,
	bold: (text) => `<b>${text}</b>`,
	italic: (text) => `<i>${text}</i>`,
};

describe("summarizeArgs", () => {
	it("prefers well-known primary keys over declaration order", () => {
		expect(summarizeArgs({ max_results: 5, query: "select:task_output" })).toBe("select:task_output");
		expect(summarizeArgs({ block: true, task_id: "abc123" })).toBe("abc123");
	});

	it("falls back to the first string value, flattening whitespace", () => {
		expect(summarizeArgs({ other: "line one\n  line two" })).toBe("line one line two");
	});

	it("handles absent/partial args from streaming tool calls", () => {
		expect(summarizeArgs(undefined)).toBe("");
		expect(summarizeArgs({})).toBe("");
		expect(summarizeArgs(null)).toBe("");
		expect(summarizeArgs("plain")).toBe("plain");
	});

	it("caps the summary length", () => {
		const summary = summarizeArgs({ command: "x".repeat(300) });
		expect(summary.length).toBeLessThanOrEqual(96);
		expect(summary.endsWith("…")).toBe(true);
	});
});

describe("collapseLines", () => {
	const text = ["1", "2", "3", "4", "5", "6", "7"].join("\n");

	it("collapses beyond the limit and reports the hidden count", () => {
		expect(collapseLines(text, false, 5)).toEqual({ lines: ["1", "2", "3", "4", "5"], hidden: 2 });
	});

	it("shows everything when expanded or short", () => {
		expect(collapseLines(text, true, 5).hidden).toBe(0);
		expect(collapseLines("a\nb", false, 5)).toEqual({ lines: ["a", "b"], hidden: 0 });
	});
});

describe("callLine / resultLines", () => {
	it("colors the bullet by status", () => {
		expect(bulletColor(true, false)).toBe("muted");
		expect(bulletColor(false, false)).toBe("success");
		expect(bulletColor(false, true)).toBe("error");
		expect(callLine(theme, "Skill", "code-review", false, false)).toBe("<success>●</> <b>Skill</b>(<muted>code-review</>)");
		expect(callLine(theme, "Skill", "", false, false)).toBe("<success>●</> <b>Skill</b>");
	});

	it("draws the elbow on the first line and a trailer when collapsed", () => {
		const lines = resultLines(theme, "a\nb\nc", false, false, 2);
		expect(lines[0]).toBe("  ⎿  <muted>a</>");
		expect(lines[1]).toBe("     <muted>b</>");
		expect(lines[2]).toContain("+1 lines");
		expect(lines[2]).toContain("ctrl+o");
	});

	it("uses the error color for failed results", () => {
		expect(resultLines(theme, "boom", false, true)[0]).toBe("  ⎿  <error>boom</>");
	});

	it("paints the bullet with the override color when given one", () => {
		expect(callLine(theme, "Bash", "ls", true, false, "accent")).toBe("<accent>●</> <b>Bash</b>(<muted>ls</>)");
	});
});

describe("spinnerBulletColor (running-call pulse)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("pulses through the frames and repaints while the call is in flight", () => {
		const invalidate = vi.fn();
		const context = { isPartial: true, invalidate, state: {} };

		expect(spinnerBulletColor(context)).toBe(SPINNER_COLORS[0]);
		// A single interval drives the pulse; subsequent calls don't stack timers.
		expect(spinnerBulletColor(context)).toBe(SPINNER_COLORS[0]);

		vi.advanceTimersByTime(SPINNER_INTERVAL_MS);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(spinnerBulletColor(context)).toBe(SPINNER_COLORS[1]);

		vi.advanceTimersByTime(SPINNER_INTERVAL_MS * SPINNER_COLORS.length);
		expect(spinnerBulletColor(context)).toBe(SPINNER_COLORS[1]); // wrapped full cycle
	});

	it("stops the timer and drops to the static bullet once the call ends", () => {
		const invalidate = vi.fn();
		const state: { ccSpinner?: { frame: number; timer: ReturnType<typeof setInterval> | undefined } } = {};
		expect(spinnerBulletColor({ isPartial: true, invalidate, state })).toBe(SPINNER_COLORS[0]);

		expect(spinnerBulletColor({ isPartial: false, invalidate, state })).toBeUndefined();
		invalidate.mockClear();
		vi.advanceTimersByTime(SPINNER_INTERVAL_MS * 3);
		expect(invalidate).not.toHaveBeenCalled(); // interval was cleared
	});

	it("degrades to no animation without persistent state or a repaint hook", () => {
		expect(spinnerBulletColor({ isPartial: true, invalidate: () => {}, state: undefined })).toBeUndefined();
		expect(spinnerBulletColor({ isPartial: true, state: {} })).toBeUndefined();
	});
});

describe("ccToolRenderers", () => {
	const renderers = ccToolRenderers<{ query?: string }>("Tool Search");
	const context = { args: { query: "select:a" }, isPartial: false, isError: false };

	it("renders the call line via renderCall", () => {
		const component = renderers.renderCall({ query: "select:a" }, theme, context);
		expect(component.render(120)).toEqual(["<success>●</> <b>Tool Search</b>(<muted>select:a</>)"]);
	});

	it("renders result text collapsed with the shared logic", () => {
		const result = { content: [{ type: "text", text: "1\n2\n3\n4\n5\n6\n7" }] };
		const lines = renderers.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(120);
		expect(lines[0]).toBe("  ⎿  <muted>1</>");
		expect(lines[5]).toContain("+2 lines");
	});

	it("hides the result block when the tool yields no text", () => {
		const component = renderers.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, context);
		expect(component.render(120)).toEqual([]);
	});

	it("a throwing custom title falls back to the generic summary", () => {
		const custom = ccToolRenderers<{ query?: string }>("X", {
			title: () => {
				throw new Error("bad");
			},
		});
		expect(custom.renderCall({ query: "q" }, theme, context).render(120)[0]).toContain("(<muted>q</>)");
	});

	it("truncates every rendered line to the terminal width", () => {
		const result = { content: [{ type: "text", text: "y".repeat(500) }] };
		const lines = renderers.renderResult(result, { expanded: true, isPartial: false }, theme, context).render(40);
		for (const line of lines) {
			let visible = 0;
			for (const chunk of line.split(/\x1b\[[0-9;]*m/)) visible += chunk.length;
			expect(visible).toBeLessThanOrEqual(40);
		}
	});
});

describe("notificationBody / notificationComponent", () => {
	const framed = [
		"<task-notification>",
		"<task-id>abc</task-id>",
		"<status>completed</status>",
		'<summary>Background command "build" completed (exit code 0)</summary>',
		"<result>build ok\nall green</result>",
		"</task-notification>",
	].join("\n");

	it("reduces the wire frame to its summary and body for display", () => {
		expect(notificationBody(framed)).toBe('Background command "build" completed (exit code 0)\nbuild ok\nall green');
		expect(notificationBody("plain text")).toBe("plain text");
	});

	it("collapses to a single headline with an expand hint", () => {
		const lines = notificationComponent(theme, framed, false).render(200);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('Background command "build" completed (exit code 0)');
		expect(lines[0]).toContain("ctrl+o");
	});

	it("shows the full body when expanded", () => {
		const lines = notificationComponent(theme, framed, true).render(200);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.at(-1)).toContain("all green");
	});
});

describe("notificationComponent: agent messages, Claude Code's transcript look", () => {
	const report = agentMessage({ from: "a94a90cbdda8038c4", body: "ALTITUDE review — 3 findings.\n\n1. first", handBack: true });
	const pointer = taskNotification({ kind: "agent", taskId: "a94a90cbdda8038c4", status: "completed", summary: 'Agent "explore-2" finished', result: handBackPointer("a94a90cbdda8038c4", false) });
	const wire = frameForDelivery(`${report}\n\n${pointer}`, "mid-turn");

	it("collapses a hand-back to `› Message from @ID` with the expand hint, and hides the pointer", () => {
		const lines = notificationComponent(theme, wire, false).render(200);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("› Message from @a94a90cbdda8038c4");
		expect(lines[0]).toContain("ctrl+o");
		expect(lines[0]).not.toContain("finished");
	});

	it("expands to the header, the preamble and the indented report, guard and pointer hidden", () => {
		const lines = notificationComponent(theme, wire, true).render(400);
		expect(lines[0]).toContain("› Message from a94a90cbdda8038c4");
		expect(lines[0]).not.toContain("@");
		expect(lines[1]).toContain("<muted>  [Subagent hand-back] The text below");
		// The long preamble wraps at this width; the report lines keep their own two-space indent under the body indent.
		expect(lines.some((l) => l.includes("<muted>    ALTITUDE review — 3 findings."))).toBe(true);
		expect(lines.at(-1)).toContain("<muted>    1. first");
		expect(lines.join("\n")).not.toContain("permission laundering");
		expect(lines.join("\n")).not.toContain("SubagentHandback");
		expect(lines.join("\n")).not.toContain("SYSTEM NOTIFICATION");
	});

	it("a coalesced message collapses to one line per frame, each with its own hint", () => {
		const a = taskNotification({ kind: "shell", taskId: "1", status: "completed", summary: "one done", result: "out A\nout A2" });
		const b = taskNotification({ kind: "shell", taskId: "2", status: "completed", summary: "two done" });
		const lines = notificationComponent(theme, frameForDelivery(`${a}\n\n${b}`, "mid-turn"), false).render(200);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("one done");
		expect(lines[0]).toContain("(+2 lines, ctrl+o to expand)");
		expect(lines[1]).toContain("two done");
		expect(lines[1]).not.toContain("ctrl+o");
	});

	it("keeps the ✳ summary line for a task notification and shows its body when expanded", () => {
		const shell = frameForDelivery(taskNotification({ kind: "shell", taskId: "b1", status: "completed", summary: 'Background command "build" completed (exit code 0)' }), "opens-turn");
		expect(notificationComponent(theme, shell, false).render(200)).toEqual([expect.stringContaining('✳</> <muted><i>Background command "build" completed (exit code 0)')]);
	});
});

describe("notificationComponent wraps long body lines instead of cutting them", () => {
	it("splits the preamble across lines at a narrow width, continuation at column 0", () => {
		// A plain theme: the tagging stub's `<muted>` markers would count as columns.
		const plain: ThemeLike = { fg: (_c, t) => t, bold: (t) => t, italic: (t) => t };
		const report = agentMessage({ from: "a1", body: "r", handBack: true });
		const lines = notificationComponent(plain, report, true).render(60);
		expect(lines.length).toBeGreaterThan(4);
		expect(lines.every((l) => l.length <= 60)).toBe(true);
		expect(lines.join("")).toContain("The report follows:");
		expect(lines.some((l) => l.endsWith("…"))).toBe(false);
		expect(lines.at(-1)).toBe("    r");
	});
});

describe("scheduledTaskComponent", () => {
	const firedAt = new Date(2026, 8, 11, 12, 3).getTime();

	it("formats the fire time the way Claude Code's line does", () => {
		expect(formatFireTime(firedAt)).toBe("Sep 11 12:03pm");
		expect(formatFireTime(new Date(2026, 0, 2, 0, 7).getTime())).toBe("Jan 2 12:07am");
		expect(formatFireTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe("Dec 31 11:59pm");
	});

	it("collapses to the Running scheduled task line and expands to the prompt", () => {
		const collapsed = scheduledTaskComponent(theme, "check the build\nthen report", firedAt, false).render(200);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("✻");
		expect(collapsed[0]).toContain("Running scheduled task (Sep 11 12:03pm)");
		expect(collapsed[0]).not.toContain("check the build");
		const expanded = scheduledTaskComponent(theme, "check the build\nthen report", firedAt, true).render(200);
		expect(expanded).toHaveLength(3);
		expect(expanded[1]).toContain("check the build");
		expect(expanded[2]).toContain("then report");
	});
});

describe("customMessageText / textContent", () => {
	it("reads string and block-array content", () => {
		expect(customMessageText("hi")).toBe("hi");
		expect(customMessageText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\n\nb");
	});

	it("joins a tool result's text blocks", () => {
		expect(textContent({ content: [{ type: "text", text: " out " }] })).toBe("out");
		expect(textContent({ content: [] })).toBe("");
	});
});

describe("truncateLine", () => {
	it("keeps short and ANSI-painted lines intact", () => {
		expect(truncateLine("short", 80)).toBe("short");
		expect(truncateLine("\x1b[31mred\x1b[0m", 80)).toBe("\x1b[31mred\x1b[0m");
	});

	it("cuts overwide lines without splitting escapes", () => {
		const cut = truncateLine(`\x1b[31m${"x".repeat(100)}\x1b[0m`, 20);
		expect(cut.endsWith("\x1b[0m…")).toBe(true);
		let visible = 0;
		for (const chunk of cut.split(/\x1b\[[0-9;]*m/)) visible += chunk.length;
		expect(visible).toBeLessThanOrEqual(20);
	});

	it("keeps a painted line whose raw length exceeds the width but visible width fits", () => {
		// 20 visible chars + escapes that push raw length past width 25.
		const painted = `\x1b[31m\x1b[1m${"x".repeat(20)}\x1b[0m`;
		expect(painted.length).toBeGreaterThan(25);
		expect(truncateLine(painted, 25)).toBe(painted);
	});
});

describe("linesComponent memoization", () => {
	it("builds once per width and serves repeat frames from cache", () => {
		const build = vi.fn((width: number) => [`w${width}`]);
		const component = linesComponent(build);
		expect(component.render(80)).toEqual(["w80"]);
		expect(component.render(80)).toEqual(["w80"]);
		expect(component.render(80)).toEqual(["w80"]);
		expect(build).toHaveBeenCalledTimes(1);
		component.render(120);
		component.render(80);
		expect(build).toHaveBeenCalledTimes(2); // new width builds; old width still cached
	});

	it("invalidate clears the cache so a theme swap repaints", () => {
		const build = vi.fn((width: number) => [`w${width}`]);
		const component = linesComponent(build);
		component.render(80);
		component.invalidate?.();
		component.render(80);
		expect(build).toHaveBeenCalledTimes(2);
	});
});

describe("elbowIndent / ccWrapBuiltinRenderers", () => {
	it("indents under the elbow and strips leading blank lines", async () => {
		const { elbowIndent } = await import("../../extensions/lib/tui-render.ts");
		expect(elbowIndent(["", "a", "b"])).toEqual(["  ⎿  a", "     b"]);
		expect(elbowIndent([])).toEqual([]);
	});

	it("replaces the base call line and keeps the base result, indented", async () => {
		const { ccWrapBuiltinRenderers } = await import("../../extensions/lib/tui-render.ts");
		const base = {
			renderCall: () => ({ render: () => ["$ ls -la"], invalidate() {} }),
			renderResult: () => ({ render: () => ["file-a", "file-b"], invalidate() {} }),
		};
		const wrapped = ccWrapBuiltinRenderers<{ command?: string }>("Bash", base, { title: (a) => a?.command });
		const context = { args: { command: "ls -la" }, isPartial: false, isError: false, state: {} };

		const call = wrapped.renderCall({ command: "ls -la" }, theme, context).render(120);
		expect(call).toEqual(["<success>●</> <b>Bash</b>(<muted>ls -la</>)"]);

		const result = wrapped
			.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, context)
			.render(120);
		expect(result).toEqual(["  ⎿  file-a", "     file-b"]);
	});

	it("keepBaseCall keeps the body (diff preview) and swaps only the header", async () => {
		const { ccWrapBuiltinRenderers } = await import("../../extensions/lib/tui-render.ts");
		const base = {
			// Base call components are padded Boxes: blank line(s) before the header.
			renderCall: () => ({ render: () => ["", "edit src/x.ts", "-old line", "+new line"], invalidate() {} }),
		};
		const wrapped = ccWrapBuiltinRenderers<{ path?: string }>("Update", base, {
			title: (a) => a?.path,
			keepBaseCall: true,
		});
		const context = { args: { path: "src/x.ts" }, isPartial: false, isError: false, state: {} };
		const lines = wrapped.renderCall({ path: "src/x.ts" }, theme, context).render(120);
		expect(lines[0]).toBe("<success>●</> <b>Update</b>(<muted>src/x.ts</>)");
		expect(lines.slice(1)).toEqual(["-old line", "+new line"]);
	});

	it("stores inner components on state, not lastComponent (base renderers cast it)", async () => {
		const { ccWrapBuiltinRenderers } = await import("../../extensions/lib/tui-render.ts");
		const seen: unknown[] = [];
		const inner = { render: () => ["out"], invalidate() {} };
		const base = {
			renderResult: (_r: unknown, _o: unknown, _t: unknown, ctx: any) => {
				seen.push(ctx.lastComponent);
				return inner;
			},
		};
		const wrapped = ccWrapBuiltinRenderers("Bash", base);
		const context = { args: {}, isPartial: false, isError: false, state: {} as any, lastComponent: { wrapper: true } };
		wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, context);
		wrapped.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, context);
		expect(seen[0]).toBeUndefined();
		expect(seen[1]).toBe(inner);
	});

	it("a throwing base result renderer falls back to plain text, never the JSON dump", async () => {
		const { ccWrapBuiltinRenderers } = await import("../../extensions/lib/tui-render.ts");
		const base = {
			renderResult: () => {
				throw new Error("boom");
			},
		};
		const wrapped = ccWrapBuiltinRenderers("Bash", base);
		const context = { args: {}, isPartial: false, isError: false, state: {} };
		const lines = wrapped
			.renderResult({ content: [{ type: "text", text: "raw output" }] }, { expanded: false, isPartial: false }, theme, context)
			.render(120);
		expect(lines[0]).toBe("  ⎿  <muted>raw output</>");
	});
});

describe("panelTopRule", () => {
	const paint = (color: string, text: string) => `<${color}>${text}</>`;
	it("is a full-width rule painted with the border token", () => {
		const rule = panelTopRule(paint, 10);
		expect(rule).toBe("<border>──────────</>");
	});
	it("is empty at zero width", () => {
		expect(panelTopRule(paint, 0)).toBe("<border></>");
	});
});

describe("searchBoxLines", () => {
	const paint = (color: string, text: string) => `<${color}>${text}</>`;
	const plain = (s: string) => s.replace(/<\/?[a-z]*>/g, "");

	it("returns three border-aligned lines of equal code-point width", () => {
		const lines = searchBoxLines("", "Search…", paint, 40);
		expect(lines).toHaveLength(3);
		const widths = lines.map((l) => [...plain(l)].length);
		expect(widths[0]).toBe(widths[1]);
		expect(widths[1]).toBe(widths[2]);
	});

	it("shows the placeholder dim and the query in the default foreground", () => {
		expect(searchBoxLines("", "Search…", paint, 40)[1]).toContain("<dim>");
		const typed = searchBoxLines("git", "Search…", paint, 40)[1];
		expect(typed).not.toContain("<dim>");
		expect(plain(typed)).toContain("⌕ git");
	});

	it("truncates a long query to fit the box", () => {
		const line = plain(searchBoxLines("x".repeat(200), "Search…", paint, 30)[1]);
		expect([...line].length).toBe([...plain(searchBoxLines("", "Search…", paint, 30)[0])].length);
	});
});

describe("stripReminderBlocks", () => {
	it("hides persisted <system-reminder> blocks from the transcript view and leaves everything else", () => {
		const result = {
			content: [
				{ type: "text", text: "ok" },
				{ type: "text", text: "<system-reminder>\nnote\n</system-reminder>" },
				{ type: "image", data: "x", mimeType: "image/png" },
			],
			details: { a: 1 },
		};
		expect(stripReminderBlocks(result)).toEqual({
			content: [
				{ type: "text", text: "ok" },
				{ type: "image", data: "x", mimeType: "image/png" },
			],
			details: { a: 1 },
		});
		const plain = { content: [{ type: "text", text: "ok" }] };
		expect(stripReminderBlocks(plain)).toBe(plain);
	});

	it("hides the raw <total_tokens> and <new-diagnostics> blocks too, whether they stand alone or close a text block", () => {
		const result = {
			content: [
				{ type: "text", text: "hi" },
				{ type: "text", text: "<total_tokens>14974751 tokens left</total_tokens>" },
				{ type: "text", text: "<new-diagnostics>The following new diagnostic issues were detected:\n\na.ts:\n  ✘ [Line 1:7] bad\n</new-diagnostics>" },
			],
		};
		expect(stripReminderBlocks(result)).toEqual({ content: [{ type: "text", text: "hi" }] });

		// The same bytes merged into one block (a suffix, or a merge downstream): the tail goes, the output stays.
		const merged = {
			content: [
				{
					type: "text",
					text: "Successfully wrote to src/a.ts\n<total_tokens>974381 tokens left</total_tokens>\n<new-diagnostics>x\n</new-diagnostics>\n<system-reminder>\nnote\n</system-reminder>",
				},
			],
		};
		expect(stripReminderBlocks(merged)).toEqual({ content: [{ type: "text", text: "Successfully wrote to src/a.ts" }] });
	});

	it("leaves a harness tag quoted inside real output alone", () => {
		const doc = { content: [{ type: "text", text: "CC appends <total_tokens>N tokens left</total_tokens> after results.\nMore prose." }] };
		expect(stripReminderBlocks(doc)).toBe(doc);
		expect(stripHarnessText("a <system-reminder>quoted</system-reminder> b")).toBe("a <system-reminder>quoted</system-reminder> b");
	});
});

