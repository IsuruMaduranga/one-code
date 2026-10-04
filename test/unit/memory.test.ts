import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	INDEX_MAX_CHARS,
	INDEX_MAX_LINES,
	indexLimitStatus,
	loadableIndexContent,
	memoryDir,
	memoryIndexReminder,
	memoryPromptSection,
	projectSlug,
	stampFrontmatter,
	truncateIndex,
} from "../../extensions/lib/memory.ts";

describe("projectSlug", () => {
	it("matches Claude Code's slugging: non [A-Za-z0-9-] chars become dashes", () => {
		expect(projectSlug("/Users/isuruWij/ml/pi-claude-code")).toBe("-Users-isuruWij-ml-pi-claude-code");
		expect(projectSlug("/tmp/my_app.v2")).toBe("-tmp-my-app-v2");
	});

	it("slugs a native Windows path the same way (drive colon and backslashes become dashes)", () => {
		expect(projectSlug("C:\\Users\\x\\proj")).toBe("C--Users-x-proj");
		expect(projectSlug("\\\\server\\share\\proj")).toBe("--server-share-proj");
		expect(memoryDir("C:\\Users\\x", "C:\\Users\\x\\proj")).toBe(join("C:\\Users\\x", ".claude", "projects", "C--Users-x-proj", "memory"));
	});
});

describe("memoryDir", () => {
	it("lives under ~/.claude/projects/<slug>/memory", () => {
		expect(memoryDir("/Users/u", "/tmp/project")).toBe(join("/Users/u", ".claude", "projects", "-tmp-project", "memory"));
	});
});

describe("memoryPromptSection", () => {
	it("names the directory and describes the file format", () => {
		const section = memoryPromptSection("/Users/u/.claude/projects/-tmp-project/memory");
		expect(section).toContain("# Memory");
		expect(section).toContain("/Users/u/.claude/projects/-tmp-project/memory/");
		expect(section).toContain("MEMORY.md");
		expect(section).toContain("type: user | feedback | project | reference");
	});

	it("is deterministic for a given directory (both variants)", () => {
		const dir = "/Users/u/.claude/projects/-p/memory";
		expect(memoryPromptSection(dir)).toBe(memoryPromptSection(dir));
		expect(memoryPromptSection(dir, true)).toBe(memoryPromptSection(dir, true));
	});

	it("verbose mode adds the long spec and differs from compact", () => {
		const dir = "/Users/u/.claude/projects/-p/memory";
		const verbose = memoryPromptSection(dir, true);
		expect(verbose.startsWith("# auto memory\n")).toBe(true);
		expect(verbose).toContain("write to it directly with the write tool");
		expect(verbose).toContain(`${dir}/`);
		expect(verbose).toContain("## Types of memory");
		expect(verbose).toContain("## What NOT to save in memory");
		expect(verbose).toContain("## How to save memories");
		expect(verbose).toContain("## Before recommending from memory");
		expect(verbose).not.toMatch(/\s$/); // the composer adds the blank line after it
		expect(verbose).toContain("MEMORY.md");
		expect(verbose).not.toBe(memoryPromptSection(dir, false));
	});
});

describe("truncateIndex", () => {
	it("passes short content through unchanged", () => {
		expect(truncateIndex("- one\n- two\n")).toBe("- one\n- two\n");
	});

	it("passes an index of exactly 200 lines through, trailing newline and all", () => {
		const exact = `${Array.from({ length: INDEX_MAX_LINES }, (_, i) => `- line ${i}`).join("\n")}\n`;
		expect(truncateIndex(exact)).toBe(exact);
	});

	it("caps at the line limit and says what was cut, the way Claude Code does", () => {
		const long = `${Array.from({ length: INDEX_MAX_LINES + 30 }, (_, i) => `- [entry ${i + 1}](e${i + 1}.md) — one line`).join("\n")}\n`;
		const out = truncateIndex(long);
		const kept = long.split("\n").slice(0, INDEX_MAX_LINES).join("\n");
		expect(out).toBe(
			`${kept}\n\n> WARNING: MEMORY.md is 230 lines (limit: 200). Only part of it was loaded: 30 of 230 lines were cut off, starting at line 201 ("- [entry 201](e201.md) — one line"). Keep index entries to one line under ~200 chars; move detail into topic files.\n`,
		);
	});

	it("caps at the character limit at the last line break, naming both sizes", () => {
		const line = `- ${"x".repeat(98)}`; // 100 characters
		const long = Array.from({ length: 150 }, () => `${line}${"y".repeat(100)}`).join("\n"); // 150 lines of 200 chars
		const out = truncateIndex(long);
		const [kept, warning] = out.split("\n\n> WARNING: ");
		expect(kept.length).toBeLessThanOrEqual(INDEX_MAX_CHARS);
		expect(long.startsWith(kept)).toBe(true);
		expect(long[kept.length]).toBe("\n");
		expect(warning).toBe(
			`MEMORY.md is 29.4KB (limit: 24.4KB) \u2014 index entries are too long. Only part of it was loaded: 26 of 150 lines were cut off, starting at line 125 ("${`${line}${"y".repeat(100)}`.slice(0, 79)}\u2026"). Keep index entries to one line under ~200 chars; move detail into topic files.\n`,
		);
	});

	it("cuts a single overlong line at the character limit", () => {
		const out = truncateIndex("x".repeat(INDEX_MAX_CHARS + 10));
		expect(out).toContain(`Only part of it was loaded: everything after the first ${INDEX_MAX_CHARS} characters of line 1 was cut off.`);
		expect(out.endsWith("move detail into topic files.\n")).toBe(true);
	});
});

describe("loadableIndexContent", () => {
	it("strips leading YAML frontmatter", () => {
		expect(loadableIndexContent("---\ntitle: x\n---\n- entry\n")).toBe("- entry\n");
	});

	it("strips block-level HTML comments but keeps inline ones", () => {
		const input = "- a\n<!-- maintainer\nnote -->\n- b <!-- inline --> c\n";
		expect(loadableIndexContent(input)).toBe("- a\n- b <!-- inline --> c\n");
	});

	it("passes plain content through", () => {
		expect(loadableIndexContent("- a\n- b\n")).toBe("- a\n- b\n");
	});
});

describe("indexLimitStatus", () => {
	const line = "- [x](x.md) — y";
	it("is ok when small", () => {
		expect(indexLimitStatus(`${line}\n${line}`)).toBe("ok");
	});
	it("is near at 90% of the line limit", () => {
		expect(indexLimitStatus(Array(INDEX_MAX_LINES * 0.9).fill(line).join("\n"))).toBe("near");
	});
	it("is over past the line limit", () => {
		expect(indexLimitStatus(Array(INDEX_MAX_LINES + 1).fill(line).join("\n"))).toBe("over");
	});
	it("does not count frontmatter against the limit", () => {
		const fm = `---\n${Array(300).fill("x: y").join("\n")}\n---\n`;
		expect(indexLimitStatus(`${fm}${line}`)).toBe("ok");
	});
	it("is over past the byte limit", () => {
		expect(indexLimitStatus("x".repeat(INDEX_MAX_CHARS + 1))).toBe("over");
	});
});

describe("stampFrontmatter", () => {
	const written = `---
name: a-fact
description: something
metadata:
  type: project
---

The fact body.
`;

	it("stamps node_type, session id, and modified into an existing metadata block", () => {
		const out = stampFrontmatter(written, "sess-1", "2026-08-05T10:00:00.000Z");
		expect(out).toBe(`---
name: a-fact
description: something
metadata:
  node_type: memory
  type: project
  originSessionId: sess-1
  modified: 2026-08-05T10:00:00.000Z
---

The fact body.
`);
	});

	it("re-stamping replaces the previous values instead of duplicating", () => {
		const once = stampFrontmatter(written, "sess-1", "2026-08-05T10:00:00.000Z");
		const twice = stampFrontmatter(once, "sess-2", "2026-08-06T11:00:00.000Z");
		expect(twice.match(/originSessionId/g)).toHaveLength(1);
		expect(twice).toContain("originSessionId: sess-2");
		expect(twice).toContain("modified: 2026-08-06");
	});

	it("adds a metadata block when the frontmatter has none", () => {
		const out = stampFrontmatter("---\nname: a\n---\nbody\n", "s", "t");
		expect(out).toContain("metadata:\n  node_type: memory\n  originSessionId: s\n  modified: t\n---");
	});

	it("leaves files without frontmatter untouched (MEMORY.md stays unstamped)", () => {
		const index = "# Memory index\n\n- [A](a.md) — hook\n";
		expect(stampFrontmatter(index, "s", "t")).toBe(index);
	});
});

describe("memoryIndexReminder", () => {
	it("frames the index as auto-memory and carries the content", () => {
		const reminder = memoryIndexReminder("/m/MEMORY.md", "- [A](a.md) — hook\n");
		expect(reminder).toContain("/m/MEMORY.md");
		expect(reminder).toContain("auto-memory");
		expect(reminder).toContain("- [A](a.md) — hook");
	});
});
