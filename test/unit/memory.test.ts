import { describe, expect, it } from "vitest";
import {
	INDEX_MAX_BYTES,
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
});

describe("memoryDir", () => {
	it("lives under ~/.claude/projects/<slug>/memory", () => {
		expect(memoryDir("/Users/u", "/tmp/project")).toBe("/Users/u/.claude/projects/-tmp-project/memory");
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

	it("is deterministic for a given directory", () => {
		const dir = "/Users/u/.claude/projects/-p/memory";
		expect(memoryPromptSection(dir)).toBe(memoryPromptSection(dir));
	});
});

describe("truncateIndex", () => {
	it("passes short content through unchanged", () => {
		expect(truncateIndex("- one\n- two\n")).toBe("- one\n- two\n");
	});

	it("caps at the line limit", () => {
		const long = Array.from({ length: INDEX_MAX_LINES + 50 }, (_, i) => `- line ${i}`).join("\n");
		const out = truncateIndex(long);
		expect(out.split("\n")).toHaveLength(INDEX_MAX_LINES);
	});

	it("caps at the byte limit without splitting a multi-byte character", () => {
		const long = "é".repeat(INDEX_MAX_BYTES); // 2 bytes each, one line
		const out = truncateIndex(long);
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(INDEX_MAX_BYTES);
		expect(out).not.toContain("�");
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
		expect(indexLimitStatus("x".repeat(INDEX_MAX_BYTES + 1))).toBe("over");
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
