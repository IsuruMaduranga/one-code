import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeMdLimitWarning, combinedLimitWarning } from "../../extensions/lib/memory.ts";
import type { MemoryEntry } from "../../extensions/memory/entries.ts";
import { editorHint, memoryDisplayPath, resolveOpen } from "../../extensions/memory/open-external.ts";
import {
	applyMemoryKey,
	decodeMemoryKey,
	initialMemoryState,
	MEMORY_DOCS_URL,
	renderMemoryPanel,
	type PanelPaint,
} from "../../extensions/memory/panel.ts";

const plainPaint: PanelPaint = { fg: (_c, t) => t, bold: (t) => t };
const MODE = { running: "claude-compatible", saved: "claude-compatible" } as const;

const entries: MemoryEntry[] = [
	{ title: "User instructions", description: "Saved in ~/.claude/CLAUDE.md", path: "/h/.claude/CLAUDE.md", kind: "file", exists: true },
	{ title: "Project instructions", description: "Checked in at ./CLAUDE.md", path: "/p/CLAUDE.md", kind: "file", exists: true },
	{ title: "Open auto-memory folder", path: "/mem", kind: "folder", exists: true },
];

describe("claudeMdLimitWarning", () => {
	it("warns over the limit with CC's N.Nk rendering", () => {
		expect(claudeMdLimitWarning("CLAUDE.md", 55_400)).toBe(
			"CLAUDE.md is over the 40.0k-char limit (55.4k chars) · /memory to free up context",
		);
	});
	it("is silent at or under the limit", () => {
		expect(claudeMdLimitWarning("CLAUDE.md", 40_000)).toBeNull();
		expect(claudeMdLimitWarning("AGENTS.md", 100)).toBeNull();
	});
});

describe("combinedLimitWarning", () => {
	it("warns on the total when several files together exceed the limit", () => {
		expect(combinedLimitWarning(25_000 + 20_000)).toBe(
			"Project instructions total 45.0k chars, over the 40.0k-char limit · /memory to free up context",
		);
	});
	it("is silent at or under the limit", () => {
		expect(combinedLimitWarning(40_000)).toBeNull();
		expect(combinedLimitWarning(0)).toBeNull();
	});
});

describe("resolveOpen", () => {
	it("uses $VISUAL over $EDITOR for a file, keeping editor flags before the path", () => {
		expect(resolveOpen("/p/CLAUDE.md", "file", { VISUAL: "code -w", EDITOR: "vim" })).toEqual({
			command: "code",
			args: ["-w", "/p/CLAUDE.md"],
		});
	});
	it("honours quotes so a spaced editor path stays one token", () => {
		expect(resolveOpen("/p/x.md", "file", { EDITOR: '"/Apps/My Editor/bin/ed" -w' })).toEqual({
			command: "/Apps/My Editor/bin/ed",
			args: ["-w", "/p/x.md"],
		});
	});
	it("falls back to the OS opener when no editor is set", () => {
		expect(resolveOpen("/p/x.md", "file", {}, "darwin")).toEqual({ command: "open", args: ["/p/x.md"] });
		expect(resolveOpen("/p/x.md", "file", {}, "linux")).toEqual({ command: "xdg-open", args: ["/p/x.md"] });
	});
	it("ignores $EDITOR for a folder and uses the OS opener", () => {
		expect(resolveOpen("/mem", "folder", { EDITOR: "vim" }, "darwin")).toEqual({ command: "open", args: ["/mem"] });
	});
});

describe("memory panel navigation", () => {
	it("decodes arrows, enter, and close", () => {
		expect(decodeMemoryKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodeMemoryKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodeMemoryKey("\r")).toEqual({ kind: "enter" });
		expect(decodeMemoryKey("\x1b")).toEqual({ kind: "close" });
		expect(decodeMemoryKey("z")).toBeUndefined();
	});

	it("clamps the cursor and opens the selected entry", () => {
		const state = initialMemoryState();
		applyMemoryKey(state, { kind: "up" }, entries);
		expect(applyMemoryKey(state, { kind: "up" }, entries)).toBeUndefined();
		expect(state.cursor).toBe(-1); // clamped at the config-sources row
		applyMemoryKey(state, { kind: "down" }, entries);
		applyMemoryKey(state, { kind: "down" }, entries);
		applyMemoryKey(state, { kind: "down" }, entries);
		applyMemoryKey(state, { kind: "down" }, entries); // clamps at bottom
		expect(state.cursor).toBe(2);
		expect(applyMemoryKey(state, { kind: "enter" }, entries)).toEqual({ kind: "open", entry: entries[2] });
		expect(applyMemoryKey(state, { kind: "close" }, entries)).toEqual({ kind: "close" });
	});
});

describe("config-sources row", () => {
	it("is reached by ↑ from the first entry, toggles on Enter, and ↓ returns to the list", () => {
		const state = initialMemoryState();
		applyMemoryKey(state, { kind: "up" }, entries);
		expect(state.cursor).toBe(-1);
		expect(applyMemoryKey(state, { kind: "enter" }, entries)).toEqual({ kind: "toggle-mode" });
		applyMemoryKey(state, { kind: "down" }, entries);
		expect(state.cursor).toBe(0);
		expect(applyMemoryKey(state, { kind: "enter" }, entries)).toEqual({ kind: "open", entry: entries[0] });
	});

	it("renders the saved mode, marks a pending change, and names the key", () => {
		const state = initialMemoryState();
		const same = renderMemoryPanel({ state, entries, width: 100, height: 20, mode: { running: "claude-compatible", saved: "claude-compatible" } }, plainPaint);
		expect(same.some((l) => l.startsWith("  Config sources: Claude-compatible") && l.includes("~/.claude, CLAUDE.md"))).toBe(true);
		expect(same.join("\n")).toContain("↑ for config sources");
		state.cursor = -1;
		const pending = renderMemoryPanel({ state, entries, width: 100, height: 20, mode: { running: "claude-compatible", saved: "independent" } }, plainPaint);
		expect(pending.some((l) => l.startsWith("❯ Config sources: Independent (from next start)"))).toBe(true);
		expect(pending.some((l) => l.startsWith("❯ 1."))).toBe(false);
	});

	it("shows the running mode and its source when ONECODE_CONFIG_MODE sets it", () => {
		const lines = renderMemoryPanel({ state: initialMemoryState(), entries, width: 100, height: 20, mode: { running: "independent", saved: "claude-compatible", fromEnv: true } }, plainPaint);
		expect(lines.some((l) => l.startsWith("  Config sources: Independent (set by ONECODE_CONFIG_MODE)"))).toBe(true);
	});
});

describe("renderMemoryPanel", () => {
	it("renders the title, status, entries, and learn-more link", () => {
		const lines = renderMemoryPanel({ state: initialMemoryState(), entries, width: 80, height: 20, mode: MODE }, plainPaint);
		const text = lines.join("\n");
		expect(text).toContain("Memory");
		expect(text).toContain("Auto-memory: on");
		expect(text).toContain("1. User instructions");
		expect(text).toContain("Saved in ~/.claude/CLAUDE.md");
		expect(text).toContain("3. Open auto-memory folder");
		expect(text).toContain(`Learn more: ${MEMORY_DOCS_URL}`);
		expect(text).toContain("Enter to open or switch · ↑ for config sources · Esc to close");
	});

	it("marks the selected row with the ❯ cursor", () => {
		const state = initialMemoryState();
		state.cursor = 1;
		const lines = renderMemoryPanel({ state, entries, width: 80, height: 20, mode: MODE }, plainPaint);
		expect(lines.some((l) => l.startsWith("❯ 2. Project instructions"))).toBe(true);
		expect(lines.some((l) => l.startsWith("  1. User instructions"))).toBe(true);
	});

	it("keeps the cursor visible when the list is taller than the viewport", () => {
		const many: MemoryEntry[] = Array.from({ length: 30 }, (_, i) => ({
			title: `Entry ${i + 1}`,
			path: `/f/${i}.md`,
			kind: "file",
			exists: true,
		}));
		const state = initialMemoryState();
		state.cursor = 25;
		const lines = renderMemoryPanel({ state, entries: many, width: 80, height: 12, mode: MODE }, plainPaint);
		expect(lines.some((l) => l.includes("❯ 26. Entry 26"))).toBe(true);
	});
});

describe("editorHint (CC 2.1.288 /memory)", () => {
	it("names the variable in use, $VISUAL first, else the default nudge", () => {
		expect(editorHint({})).toBe("> To use a different editor, set the $EDITOR or $VISUAL environment variable.");
		expect(editorHint({ EDITOR: "vim" })).toBe('> Using $EDITOR="vim". To change editor, set $EDITOR or $VISUAL environment variable.');
		expect(editorHint({ VISUAL: "code -w", EDITOR: "vim" })).toBe('> Using $VISUAL="code -w". To change editor, set $EDITOR or $VISUAL environment variable.');
	});
});

describe("memoryDisplayPath (CC 2.1.288 /memory)", () => {
	const home = join("/", "Users", "me");
	const cwd = join(home, "proj");
	it("shows ~/… under home and ./… under the working directory, the shorter when both apply", () => {
		expect(memoryDisplayPath(join(home, ".claude", "CLAUDE.md"), cwd, home)).toBe("~/.claude/CLAUDE.md");
		expect(memoryDisplayPath(join(cwd, "CLAUDE.md"), cwd, home)).toBe("./CLAUDE.md");
		expect(memoryDisplayPath(join(cwd, "a", "b", "CLAUDE.md"), cwd, home)).toBe("./a/b/CLAUDE.md");
	});
	it("leaves a path outside both as is", () => {
		const elsewhere = join("/", "etc", "CLAUDE.md");
		expect(memoryDisplayPath(elsewhere, cwd, home)).toBe(elsewhere);
	});
});
