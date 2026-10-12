import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../extensions/lib/text-width.ts";
import type { ThemeLike } from "../../extensions/lib/tui-render.ts";
import { userDenialText } from "../../extensions/lib/user-denial.ts";
import {
	contentPreviewLines,
	countLines,
	createWriteRenderers,
	diffCounts,
	diffPreviewLines,
	updateSummary,
	WRITE_DIFF_MAX_BYTES,
	writeDetails,
	writeResultLines,
} from "../../extensions/tool-style/write-render.ts";

const tagged: ThemeLike = {
	fg: (color, text) => `<${color}>${text}</>`,
	bold: (text) => `<b>${text}</b>`,
	italic: (text) => `<i>${text}</i>`,
};
const plain: ThemeLike = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text };

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const fakeDiff = (before: string, after: string) => `-1 ${before}\n+1 ${after}`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("countLines", () => {
	it("counts a trailing newline as the end of the last line", () => {
		expect(countLines("a\nb\n")).toBe(2);
		expect(countLines("a\nb")).toBe(2);
		expect(countLines("a")).toBe(1);
	});
});

describe("contentPreviewLines", () => {
	it("shows the first ten lines and a trailer naming the rest", () => {
		const out = contentPreviewLines(plain, lines(14), 80, false);
		expect(out.slice(0, 10)).toEqual(lines(10).split("\n"));
		expect(out[10]).toBe("… +4 lines (ctrl+o to expand)");
		expect(out).toHaveLength(11);
	});

	it("shows everything expanded, and says (No content) for an empty file", () => {
		expect(contentPreviewLines(plain, lines(14), 80, true)).toEqual(lines(14).split("\n"));
		expect(contentPreviewLines(plain, "", 80, false)).toEqual(["(No content)"]);
	});

	it("wraps an overwide line instead of cutting it, and strips escapes", () => {
		const out = contentPreviewLines(plain, `${"x".repeat(50)}\x1b[31mred\x1b[0m\tend`, 20, false);
		for (const line of out) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(out.join("")).toBe(`${"x".repeat(50)}red   end`);
	});
});

describe("diffs", () => {
	const diff = " 1 keep\n-2 old\n+2 new\n+3 more";
	it("counts and summarizes like Claude Code", () => {
		expect(diffCounts(diff)).toEqual({ added: 2, removed: 1 });
		expect(updateSummary(plain, diff)).toBe("Added 2 lines, removed 1 line");
		expect(updateSummary(plain, "-1 a")).toBe("Removed 1 line");
		expect(updateSummary(tagged, "+1 a\n+2 b")).toBe("Added <b>2</b> lines");
	});

	it("colours each line by its sign", () => {
		expect(diffPreviewLines(tagged, diff, 80)).toEqual([
			"<toolDiffContext> 1 keep</>",
			"<toolDiffRemoved>-2 old</>",
			"<toolDiffAdded>+2 new</>",
			"<toolDiffAdded>+3 more</>",
		]);
	});
});

describe("writeDetails", () => {
	it("records a create, an overwrite's diff, and no diff when too big or unread", () => {
		expect(writeDetails(undefined, "new", fakeDiff)).toEqual({ kind: "create" });
		expect(writeDetails("old", "new", fakeDiff)).toEqual({ kind: "update", diff: "-1 old\n+1 new" });
		expect(writeDetails(null, "new", fakeDiff)).toEqual({ kind: "update" });
		expect(writeDetails("x".repeat(WRITE_DIFF_MAX_BYTES + 1), "new", fakeDiff)).toEqual({ kind: "update" });
	});
});

describe("writeResultLines", () => {
	it("says Wrote N lines to the path, then the first lines", () => {
		const out = writeResultLines(plain, { kind: "create" }, "notes/hello.txt", "hi\nthere\n", 80, false);
		expect(out).toEqual(["Wrote 2 lines to notes/hello.txt", "hi", "there"]);
	});

	it("says what an overwrite changed, then its diff", () => {
		const out = writeResultLines(plain, { kind: "update", diff: "-1 old\n+1 new" }, "a.txt", "new", 80, false);
		expect(out).toEqual(["Added 1 line, removed 1 line", "-1 old", "+1 new"]);
	});

	it("falls back to the create view when an overwrite has no diff", () => {
		expect(writeResultLines(plain, { kind: "update" }, "a.txt", "x", 80, false)[0]).toBe("Wrote 1 lines to a.txt");
	});
});

describe("the write tool's execution", () => {
	it("records a create, then an overwrite's diff, on details, and leaves the model-facing content as pi wrote it", async () => {
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { createFakePi } = await import("./helpers/fake-pi.ts");
		const { default: toolStyleExtension } = await import("../../extensions/tool-style/index.ts");
		const dir = mkdtempSync(join(tmpdir(), "write-details-"));
		try {
			const fake = createFakePi();
			toolStyleExtension(fake.pi as never);
			const write = fake.tools.get("write")! as any;
			const ctx = { cwd: dir } as never;
			const created = await write.execute("c1", { path: "a.txt", content: "one\n" }, undefined, undefined, ctx);
			expect(created.content).toEqual([{ type: "text", text: "Successfully wrote to a.txt" }]);
			expect(created.details).toEqual({ kind: "create" });
			const updated = await write.execute("c2", { path: "a.txt", content: "two\n" }, undefined, undefined, ctx);
			expect(updated.details.kind).toBe("update");
			expect(diffCounts(updated.details.diff)).toEqual({ added: 1, removed: 1 });
			expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("two\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("createWriteRenderers", () => {
	const fallback = () => ({ render: () => ["FALLBACK"], invalidate() {} });
	const make = (before: string | null | undefined) =>
		createWriteRenderers({ readBefore: async () => before, diff: fakeDiff }, fallback);

	it("previews a new file's content under the call while it waits, then only the call line once it ran", async () => {
		const r = make(undefined);
		const state = {};
		let invalidated = 0;
		const ctx = { isPartial: true, argsComplete: true, isError: false, state, cwd: "/w", invalidate: () => invalidated++ };
		const args = { path: "notes/hello.txt", content: "hello\nworld" };
		expect(r.renderCall(args, plain, ctx).render(80)).toEqual(["● Write(notes/hello.txt)"]);
		await flush();
		expect(invalidated).toBeGreaterThan(0);
		expect(r.renderCall(args, plain, ctx).render(80)).toEqual(["● Write(notes/hello.txt)", "  hello", "  world"]);
		expect(r.renderCall(args, plain, { ...ctx, isPartial: false }).render(80)).toEqual(["● Write(notes/hello.txt)"]);
	});

	it("previews the diff when the file exists", async () => {
		const r = make("old");
		const ctx = { isPartial: true, argsComplete: true, isError: false, state: {}, cwd: "/w", invalidate() {} };
		const args = { path: "a.txt", content: "new" };
		r.renderCall(args, plain, ctx);
		await flush();
		expect(r.renderCall(args, plain, ctx).render(80)).toEqual(["● Write(a.txt)", "  -1 old", "  +1 new"]);
	});

	it("bounds every preview line to the width", async () => {
		const r = make(undefined);
		const ctx = { isPartial: true, argsComplete: true, isError: false, state: {}, cwd: "/w", invalidate() {} };
		const args = { path: "wide.txt", content: `${"界".repeat(100)}\n${"y".repeat(300)}` };
		r.renderCall(args, plain, ctx);
		await flush();
		for (const line of r.renderCall(args, plain, ctx).render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	it("renders a finished write's result under the elbow, with the path relative to the cwd", () => {
		const r = make(undefined);
		const ctx = { args: { path: "/w/notes/hello.txt", content: "hi\n" }, isError: false, cwd: "/w", state: {} };
		const out = r.renderResult({ content: [{ type: "text", text: "File created successfully at: /w/notes/hello.txt" }], details: { kind: "create" } }, { expanded: false, isPartial: false }, plain, ctx).render(80);
		// Relative and native, as the transcript shows it on Windows too.
		expect(out).toEqual([`  ⎿  Wrote 1 lines to ${join("notes", "hello.txt")}`, "     hi"]);
	});

	it("shows a rejection without a reason as Claude Code's line and the content; anything else falls back", () => {
		const r = make(undefined);
		const ctx = { args: { path: "a.txt", content: "secret\n" }, isError: true, cwd: "/w", state: {} };
		const rejected = r.renderResult({ content: [{ type: "text", text: userDenialText() }] }, { expanded: false, isPartial: false }, plain, ctx).render(80);
		expect(rejected).toEqual(["  ⎿  User rejected write to a.txt", "     secret"]);
		expect(rejected.join("\n")).not.toContain("STOP");
		const withReason = r.renderResult({ content: [{ type: "text", text: userDenialText("use b.txt") }] }, { expanded: false, isPartial: false }, plain, ctx).render(80);
		expect(withReason).toEqual(["FALLBACK"]);
		const failed = r.renderResult({ content: [{ type: "text", text: "EACCES" }] }, { expanded: false, isPartial: false }, plain, ctx).render(80);
		expect(failed).toEqual(["FALLBACK"]);
	});
});
