/**
 * The transcript's one-line results and short lines (lib/ui/result-summary-*.ts,
 * the summary and short-line hooks of `ccWrapBuiltinRenderers`, and their
 * wiring in tool-style, the file-tracker, the shell tool and ask-user). Every
 * case also checks that what the model reads is unchanged: the short line is
 * display only, and ctrl+o shows the whole text.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ccWrapBuiltinRenderers, type ThemeLike } from "../../extensions/lib/ui/tui-render.ts";
import { fileErrorKindOf, fileErrorLine, readSummary, searchCount, searchSummaryWords } from "../../extensions/lib/ui/result-summary-files.ts";
import { shellBlockedLine } from "../../extensions/lib/ui/result-summary-shell.ts";
import { askUserRows } from "../../extensions/lib/ui/result-summary-ask.ts";
import { THOUGHT_SHOWN_MS, ThinkingClock } from "../../extensions/lib/ui/thinking-clock.ts";
import { composeWorkingMessage } from "../../extensions/ui/spinner/line.ts";
import { executedErrorKind, refusalKind } from "../../extensions/safety/file-tracker/results.ts";
import { fileTrackerText } from "../../extensions/safety/file-tracker/text.ts";
import { registerShellTool } from "../../extensions/lib/shell-run/shell-tool.ts";
import { type ShellBlock, shellResultText } from "../../extensions/lib/shell-run/shell-text.ts";
import { askUserResultText } from "../../extensions/tools/ask-user/text.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { useShippedProfileWithAllTools } from "./helpers/profile.ts";
import { plainTheme } from "./helpers/plain-theme.ts";

// grep, find and ls are tools a profile may turn off; this file renders them.
useShippedProfileWithAllTools();

const plain: ThemeLike = plainTheme;
const tagged: ThemeLike = { fg: (c, t) => `<${c}>${t}</>`, bold: (t) => `<b>${t}</b>`, italic: (t) => t };
const text = (value: string) => ({ type: "text", text: value });
const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };

describe("readSummary", () => {
	it("counts a trailing newline's empty last line, as Claude Code's `Read 2 lines` for \"hello\\n\" does", () => {
		expect(readSummary({ content: [text("hello\n")] }, {})).toEqual({ kind: "lines", count: 2 });
		expect(readSummary({ content: [text("one line")] }, {})).toEqual({ kind: "lines", count: 1 });
	});

	it("reads pi's truncation count, and the limit when pi appended its more-lines notice", () => {
		expect(readSummary({ content: [text("a\nb\n\n[Showing lines 1-2 of 9. Use offset=3 to continue.]")], details: { truncation: { truncated: true, outputLines: 2 } } }, {})).toEqual({ kind: "lines", count: 2 });
		expect(readSummary({ content: [text("a\nb\n\n[7 more lines in file. Use offset=3 to continue.]")] }, { limit: 2 })).toEqual({ kind: "lines", count: 2 });
		// A limit past the end: what was read.
		expect(readSummary({ content: [text("a\nb")] }, { limit: 50 })).toEqual({ kind: "lines", count: 2 });
	});

	it("says image for an image, and leaves pi's warning view when the model cannot see it", () => {
		const image = { type: "image" };
		expect(readSummary({ content: [text("Read image file [image/png]"), image] }, {})).toEqual({ kind: "image" });
		expect(readSummary({ content: [text("Read image file [image/png]"), image], details: { imageUnsupportedByModel: "m" } }, {})).toBeUndefined();
		// pi could not shrink or convert the image: a text notice alone, no isError, no details.
		expect(readSummary({ content: [text("Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]")] }, {})).toBeUndefined();
		expect(readSummary({ content: [text("Read image file [image/bmp]\n[Image omitted: could not be converted to a supported inline image format.]")] }, {})).toBeUndefined();
	});

	it("counts an empty result (the empty-file reminder stripped) as zero", () => {
		expect(readSummary({ content: [] }, {})).toEqual({ kind: "lines", count: 0 });
	});
});

describe("searchCount", () => {
	it("counts nothing for pi's empty texts", () => {
		expect(searchCount("grep", { content: [text("No matches found")] })).toBe(0);
		expect(searchCount("find", { content: [text("No files found matching pattern")] })).toBe(0);
		expect(searchCount("ls", { content: [text("(empty directory)")] })).toBe(0);
	});

	it("drops pi's notice paragraph only when the details flag a limit", () => {
		expect(searchCount("find", { content: [text("a.ts\nb.ts\n\n[2 results limit reached]")], details: { resultLimitReached: 2 } })).toBe(2);
		expect(searchCount("grep", { content: [text("a.ts:1: x\na.ts:2: y")] })).toBe(2);
		expect(searchCount("ls", { content: [text("a/\nb\nc\n\n[3 entries limit reached. Use limit=6 for more]")], details: { entryLimitReached: 3 } })).toBe(3);
	});

	it("words the count", () => {
		expect(searchSummaryWords("grep", 1)).toEqual({ verb: "Found", noun: "line" });
		expect(searchSummaryWords("find", 0)).toEqual({ verb: "Found", noun: "files" });
		expect(searchSummaryWords("ls", 4)).toEqual({ verb: "Listed", noun: "paths" });
	});
});

describe("fileErrorLine", () => {
	it("uses Claude Code's words per operation", () => {
		expect(fileErrorLine("edit", "unread")).toEqual({ text: "File must be read first", color: "dim" });
		expect(fileErrorLine("edit", "missing")).toEqual({ text: "File not found", color: "error" });
		expect(fileErrorLine("edit", "failed")).toEqual({ text: "Error editing file", color: "error" });
		expect(fileErrorLine("read", "missing")).toEqual({ text: "File not found", color: "error" });
		expect(fileErrorLine("read", "failed")).toEqual({ text: "Error reading file", color: "error" });
		expect(fileErrorLine("write", "unread")).toEqual({ text: "Error writing file", color: "error" });
		expect(fileErrorLine("write", "missing")).toEqual({ text: "Error writing file", color: "error" });
	});

	it("keeps the words of a failure the harness did not classify", () => {
		expect(fileErrorLine("edit", undefined)).toBeUndefined();
		expect(fileErrorKindOf({ fileError: "nonsense" })).toBeUndefined();
		expect(fileErrorKindOf({ fileError: "missing" })).toBe("missing");
	});
});

describe("the file-tracker's classification", () => {
	it("recognizes each of its refusals by generating it, and nothing else", () => {
		const call = { path: "/w/a.ts", tool: "edit" };
		expect(refusalKind(fileTrackerText.unread(call), call, fileTrackerText)).toBe("unread");
		expect(refusalKind(fileTrackerText.stale({ path: call.path }), call, fileTrackerText)).toBe("failed");
		expect(refusalKind(fileTrackerText.unreadable(call), call, fileTrackerText)).toBe("failed");
		expect(refusalKind(fileTrackerText.unread({ path: "/w/other.ts", tool: "edit" }), call, fileTrackerText)).toBeUndefined();
		expect(refusalKind("Permission denied by a rule.", call, fileTrackerText)).toBeUndefined();
	});

	it("tells a missing file from another failure of a tool that ran", () => {
		const result = (text: string) => ({ toolName: "edit", isError: true, content: [{ type: "text", text }], path: "/w/a.ts", cwd: "/w" });
		expect(executedErrorKind(result("Could not edit file: /w/a.ts. Error code: ENOENT."))).toBe("missing");
		expect(executedErrorKind(result("Could not find the exact text in /w/a.ts."))).toBe("failed");
	});
});

describe("ccWrapBuiltinRenderers: summary, moved body and short error line", () => {
	const component = (lines: string[]) => ({ render: () => lines, invalidate() {} });

	it("shows the summary alone collapsed and above the base result expanded", () => {
		const base = { renderResult: () => component(["", "line one", "line two"]) };
		const wrapped = ccWrapBuiltinRenderers("Read", base, { summary: (_r, _a, theme) => `Read ${theme.bold("2")} lines` });
		const context = { args: {}, isError: false, state: {} };
		expect(wrapped.renderResult({ content: [text("x")] }, collapsed, tagged, context).render(80)).toEqual(["  ⎿  Read <b>2</b> lines"]);
		expect(wrapped.renderResult({ content: [text("x")] }, expanded, plain, context).render(80)).toEqual(["  ⎿  Read 2 lines", "     line one", "     line two"]);
	});

	it("shows the result text under the summary when expanded and the base renderer gives nothing", () => {
		const summary = { summary: () => "Read 2 lines" };
		const context = { args: {}, isError: false, state: {} };
		const result = { content: [text("line one\nline two")] };
		for (const base of [{}, { renderResult: () => { throw new Error("no view"); } }]) {
			const wrapped = ccWrapBuiltinRenderers("Read", base, summary);
			expect(wrapped.renderResult(result, collapsed, plain, context).render(80)).toEqual(["  ⎿  Read 2 lines"]);
			expect(wrapped.renderResult(result, expanded, plain, context).render(80)).toEqual(["  ⎿  Read 2 lines", "     line one", "     line two"]);
		}
	});

	it("moves a settled edit's diff from the call to under the summary", () => {
		const base = {
			renderCall: () => component(["", "edit a.ts", "", " -1 old", " +1 new", ""]),
			renderResult: () => component([]),
		};
		const wrapped = ccWrapBuiltinRenderers<{ path?: string }>("Update", base, { title: (a) => a?.path, keepBaseCall: true, summary: () => "Added 1 line, removed 1 line" });
		// While it waits, the call carries the diff (the prompt is decided on it).
		const waiting = { args: { path: "a.ts" }, isPartial: true, isError: false, state: {} };
		expect(wrapped.renderCall({ path: "a.ts" }, plain, waiting).render(80)).toEqual(["● Update(a.ts)", "", " -1 old", " +1 new", ""]);
		// Settled: pi renders the call, then the result, then paints both.
		const state = {};
		const settled = { args: { path: "a.ts" }, isPartial: false, isError: false, state };
		const call = wrapped.renderCall({ path: "a.ts" }, plain, settled);
		const result = wrapped.renderResult({ content: [text("ok")], details: { diff: " -1 old\n +1 new" } }, collapsed, plain, settled);
		expect(call.render(80)).toEqual(["● Update(a.ts)"]);
		expect(result.render(80)).toEqual(["  ⎿  Added 1 line, removed 1 line", "     -1 old", "     +1 new"]);
	});

	it("shows a short error line collapsed, hiding the call's failed preview, and the whole text expanded", () => {
		const long = "Could not find the exact text in a.ts. The old text must match exactly including all whitespace and newlines.";
		const base = {
			renderCall: () => component(["", "edit a.ts", "", long, ""]),
			renderResult: () => component(["", long]),
		};
		const wrapped = ccWrapBuiltinRenderers<{ path?: string }>("Update", base, { title: (a) => a?.path, keepBaseCall: true, errorLine: () => ({ text: "Error editing file", color: "error" }) });
		const state = {};
		const ctx = { args: { path: "a.ts" }, isPartial: false, isError: true, state };
		const result = { content: [text(long)] };
		const before = structuredClone(result);
		const call = wrapped.renderCall({ path: "a.ts" }, tagged, ctx);
		expect(wrapped.renderResult(result, collapsed, tagged, ctx).render(200)).toEqual(["  ⎿  <error>Error editing file</>"]);
		expect(call.render(200)).toEqual(["<error>●</> <b>Update</b>(<muted>a.ts</>)"]);
		// ctrl+o: the whole text, under the elbow, once (the call's copy stays hidden).
		const callExpanded = wrapped.renderCall({ path: "a.ts" }, plain, ctx);
		expect(wrapped.renderResult(result, expanded, plain, ctx).render(200)).toEqual([`  ⎿  ${long}`]);
		expect(callExpanded.render(200)).toEqual(["● Update(a.ts)"]);
		// Rendering never touches what the model reads.
		expect(result).toEqual(before);
	});
});

describe("resultLines: ctrl+o shows the whole text", () => {
	it("hard-wraps an expanded result's long lines under the elbow when it knows the width (output keeps every space), and leaves a collapsed one as it was", async () => {
		const { resultLines } = await import("../../extensions/lib/ui/tui-render.ts");
		const long = "alpha beta gamma delta epsilon zeta eta theta";
		expect(resultLines(plain, long, true, true, { width: 25 })).toEqual(["  ⎿  alpha beta gamma del", "     ta epsilon zeta eta ", "     theta"]);
		expect(resultLines(plain, long, false, true, { width: 25 })).toEqual([`  ⎿  ${long}`]);
		expect(resultLines(plain, long, true, true)).toEqual([`  ⎿  ${long}`]);
	});
});

describe("tool-style and the file-tracker: an edit of an unread file", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "result-summary-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	const load = async () => {
		const { default: fileTrackerExtension } = await import("../../extensions/safety/file-tracker/index.ts");
		const { default: toolStyleExtension } = await import("../../extensions/tools/tool-style/index.ts");
		const fake = createFakePi();
		fileTrackerExtension(fake.pi as never);
		toolStyleExtension(fake.pi as never);
		return fake;
	};

	it("refuses with the same words, and the transcript shows Claude Code's dim line", async () => {
		const fake = await load();
		const file = join(dir, "a.ts");
		writeFileSync(file, "original");
		const ctx = createFakeCtx({ cwd: dir });
		const refusal = await fake.fireOne<{ block?: boolean; reason?: string }>("tool_call", { toolName: "edit", toolCallId: "e1", input: { path: "a.ts" } }, ctx);
		// The model-facing refusal is the file-tracker's own text, byte for byte.
		expect(refusal?.reason).toBe(fileTrackerText.unread({ path: file, tool: "edit" }));
		const edit = fake.tools.get("edit") as any;
		const result = { content: [text(refusal!.reason!)], details: {} };
		const rows = edit.renderResult(result, collapsed, tagged, { args: { path: "a.ts" }, isError: true, cwd: dir, state: {} }).render(120);
		expect(rows).toEqual(["  ⎿  <dim>File must be read first</>"]);
		const write = fake.tools.get("write") as any;
		const writeRows = write.renderResult({ content: [text(fileTrackerText.unread({ path: file, tool: "write" }))] }, collapsed, plain, { args: { path: "a.ts", content: "x" }, isError: true, cwd: dir, state: {} }).render(120);
		expect(writeRows).toEqual(["  ⎿  Error writing file"]);
	});

	it("tags an executed failure's details and leaves its content as before", async () => {
		const fake = await load();
		const ctx = createFakeCtx({ cwd: dir });
		const enoent = `Could not edit file: ${join(dir, "gone.ts")}. Error code: ENOENT.`;
		await fake.fireOne("tool_call", { toolName: "edit", toolCallId: "e2", input: { path: "gone.ts" } }, ctx);
		const missing = await fake.fireOne<{ content?: Array<{ text: string }>; details?: unknown }>("tool_result", { toolName: "edit", toolCallId: "e2", input: { path: "gone.ts" }, isError: true, content: [text(enoent)], details: {} }, ctx);
		// The content is the file-tracker's existing rewrite, unchanged by this work.
		expect(missing?.content?.[0].text).toBe(fileTrackerText.toolResult({ kind: "missing", cwd: dir }));
		expect(missing?.details).toEqual({ fileError: "missing" });

		const other = "Could not find the exact text in a.ts. The old text must match exactly including all whitespace and newlines.";
		const failed = await fake.fireOne<{ content?: unknown; details?: unknown }>("tool_result", { toolName: "edit", toolCallId: "e3", input: { path: "a.ts" }, isError: true, content: [text(other)], details: {} }, ctx);
		expect(failed?.content).toBeUndefined();
		expect(failed?.details).toEqual({ fileError: "failed" });

		const edit = fake.tools.get("edit") as any;
		const rows = (details: unknown, t: string) => edit.renderResult({ content: [text(t)], details }, collapsed, plain, { args: { path: "a.ts" }, isError: true, cwd: dir, state: {} }).render(120);
		expect(rows({ fileError: "missing" }, "x")).toEqual(["  ⎿  File not found"]);
		expect(rows({ fileError: "failed" }, other)).toEqual(["  ⎿  Error editing file"]);
		expect(rows({}, "Operation aborted")).toEqual(["  ⎿  Operation aborted"]);
	});

	it("keeps an unclassified failure's words (a permission rule, plan mode)", async () => {
		const fake = await load();
		const edit = fake.tools.get("edit") as any;
		const policy = "Edits are not allowed in plan mode.";
		const rows = edit.renderResult({ content: [text(policy)], details: {} }, collapsed, plain, { args: { path: "a.ts" }, isError: true, cwd: dir, state: {} }).render(120);
		expect(rows.join("\n")).toContain(policy);
	});

	it("summarizes a read and a search", async () => {
		const fake = await load();
		const read = fake.tools.get("read") as any;
		const ctx = { args: { path: "a.ts" }, isError: false, cwd: dir, state: {} };
		expect(read.renderResult({ content: [text("hello\n")] }, collapsed, plain, ctx).render(120)).toEqual(["  ⎿  Read 2 lines"]);
		expect(read.renderResult({ content: [text("hello")] }, collapsed, plain, ctx).render(120)).toEqual(["  ⎿  Read 1 line"]);
		const find = fake.tools.get("find") as any;
		expect(find.renderResult({ content: [text("a.ts\nb.ts")] }, collapsed, plain, { args: { pattern: "*.ts" }, isError: false, state: {} }).render(120)).toEqual(["  ⎿  Found 2 files (ctrl+o to expand)"]);
		expect(find.renderResult({ content: [text("No files found matching pattern")] }, collapsed, plain, { args: { pattern: "*.x" }, isError: false, state: {} }).render(120)).toEqual(["  ⎿  Found 0 files"]);
	});
});

describe("the shell tool: a guard's refusal", () => {
	const blocks: ShellBlock[] = [
		{ kind: "pollingLoop", command: "for i in 1 2; do sleep 1; done" },
		{ kind: "sleep", shown: "sleep 30", sleepName: "sleep", untilExample: "until x; do sleep 1; done" },
		{ kind: "detach", via: "`nohup`" },
		{ kind: "editor", command: "vim a" },
		{ kind: "watch" },
		{ kind: "rebaseInteractive", shell: "bash" },
		{ kind: "addInteractive" },
		{ kind: "consolePrompt", command: "Read-Host" },
	];

	it.each(blocks.map((block) => ({ block })))("keeps the model's text for $block.kind and shows a short line", async ({ block }) => {
		const fake = createFakePi();
		registerShellTool(fake.pi as never, {
			name: "bash",
			ccLabel: "Bash",
			description: "",
			parameters: Type.Object({ command: Type.String() }),
			base: { label: "Bash" },
			foreground: () => ({ execute: vi.fn() }),
			guard: () => block,
			sandboxText: () => ({ disableParam: "", allowedDomainsParam: "", hostNotListed: "", section: () => "", turnedOff: "", unavailable: () => "", refused: () => "refused" }),
			backgroundShell: () => undefined,
		});
		const tool = fake.tools.get("bash") as any;
		const result = await tool.execute("c1", { command: "x" }, undefined, undefined, createFakeCtx({ mode: "tui" }));
		expect(result.content).toEqual([text(shellResultText().blocked(block))]);
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ blocked: block.kind });
		const ctx = { args: { command: "x" }, isError: true, state: {} };
		expect(tool.renderResult(result, collapsed, plain, ctx).render(200)).toEqual([`  ⎿  ${shellBlockedLine(result.details)}`]);
		expect(tool.renderResult(result, expanded, plain, ctx).render(400).join(" ")).toContain("Blocked:");
	});

	it("has a line for every kind and none for other details", () => {
		expect(shellBlockedLine({ blocked: "pollingLoop" })).toBe("Blocked: a foreground polling loop");
		expect(shellBlockedLine({ blocked: "toString" })).toBeUndefined();
		expect(shellBlockedLine({})).toBeUndefined();
	});
});

describe("ask-user: Claude Code's answered and declined blocks", () => {
	const answers = [
		{ question: "Which database?", header: "DB", selected: ["Postgres"], freeform: false },
		{ question: "Which cache?", header: "Cache", selected: ["Redis", "None"], freeform: false },
	];
	const args = { questions: [{ question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] }, { question: "Which size?", options: [{ label: "S" }, { label: "L" }] }] };

	it("lists each answer as question → answer under the elbow", () => {
		expect(askUserRows({ answers }, undefined, 80)).toEqual(["● Answered the questions:", "  ⎿  · Which database? → Postgres", "     · Which cache? → Redis, None"]);
	});

	it("lists every question with its options when the user declined or dismissed", () => {
		const declined = ["● Declined to answer the questions:", "  ⎿  · Which color? (Red / Blue)", "     · Which size? (S / L)"];
		expect(askUserRows({ answers: [], declined: true }, args, 80)).toEqual(declined);
		expect(askUserRows({ answers: [answers[0]], cancelled: true }, args, 80)).toEqual(declined);
	});

	it("wraps a long question with the elbow's hang", () => {
		expect(askUserRows({ answers: [{ question: "Which of these colors?", selected: ["Red"] }] }, undefined, 25)).toEqual(["● Answered the questions:", "  ⎿  · Which of these", "     colors? → Red"]);
	});

	it("leaves a result with nothing to list to the tool's text", () => {
		expect(askUserRows({ answers: [{ question: "Q", selected: [] }] }, undefined, 80)).toBeUndefined();
		expect(askUserRows({ answers: [], declined: true }, undefined, 80)).toBeUndefined();
		expect(askUserRows(undefined, args, 80)).toBeUndefined();
	});
});

describe("thought for Ns", () => {
	it("times a thinking run and shows it for two seconds after it ends", () => {
		const clock = new ThinkingClock();
		expect(clock.segment(0)).toBeUndefined();
		clock.start(1_000);
		expect(clock.segment(1_500)).toBeUndefined();
		clock.start(1_200); // a second start keeps the first
		clock.end(4_400);
		expect(clock.segment(4_400)).toBe("thought for 3s");
		expect(clock.segment(4_400 + THOUGHT_SHOWN_MS - 1)).toBe("thought for 3s");
		expect(clock.segment(4_400 + THOUGHT_SHOWN_MS)).toBeUndefined();
	});

	it("drops a run its message ended without closing (a stream error before a retry)", () => {
		const clock = new ThinkingClock();
		clock.start(0);
		clock.messageEnded(); // the stream failed: no thinking_end
		clock.start(30_000); // the retry's run
		clock.end(32_000);
		expect(clock.segment(32_000)).toBe("thought for 2s");
		// A finished run still shows after its message ends.
		clock.messageEnded();
		expect(clock.segment(32_500)).toBe("thought for 2s");
	});

	it("never says 0s, and forgets the run at the turn's end", () => {
		const clock = new ThinkingClock();
		clock.end(5); // no start: nothing
		expect(clock.segment(5)).toBeUndefined();
		clock.start(0);
		clock.end(200);
		expect(clock.segment(200)).toBe("thought for 1s");
		clock.reset();
		expect(clock.segment(200)).toBeUndefined();
	});

	it("closes the working line's stats in the capture's order", () => {
		expect(composeWorkingMessage({ verb: "Tempering", elapsedMs: 12_000, responseChars: 243_200, thought: "thought for 1s" })).toBe("Tempering… (12s · ↓ 60.8k tokens · thought for 1s)");
		expect(composeWorkingMessage({ verb: "Tempering", elapsedMs: 5_000, responseChars: 0 })).toBe("Tempering… (5s)");
	});
});
