import { describe, expect, it } from "vitest";
import { indexLimitStatus, loadableIndexContent, truncateIndex } from "../../extensions/lib/memory.ts";

describe("memory index parsing matches Claude Code's instruction parser", () => {
	it.each(["\r\n", "\n"])("strips BOM-prefixed frontmatter with %j line endings before applying limits", (newline) => {
		const header = `\uFEFF---${newline}${Array.from({ length: 210 }, (_, i) => `key${i}: value`).join(newline)}${newline}---${newline}`;
		const body = `- [Fact](fact.md) — still visible${newline}`;
		expect(loadableIndexContent(header + body)).toBe(body);
		expect(truncateIndex(header + body)).toBe(body);
		expect(indexLimitStatus(header + body)).toBe("ok");
	});

	it("does not strip comments inside a fenced code block", () => {
		const content = "# Index syntax example\n\n```html\n<!-- keep this literal example -->\n```\n";
		expect(loadableIndexContent(content)).toBe(content);
	});

	it("does not strip comments inside an indented code block", () => {
		const content = "# Index syntax example\n\n    <!-- keep this literal example -->\n";
		expect(loadableIndexContent(content)).toBe(content);
	});

	it("retains visible text after a comment", () => {
		const content = "<!-- annotation -->keep this entry\n";
		expect(loadableIndexContent(content)).toBe("keep this entry\n");
	});

	it("still strips whole comment blocks outside code", () => {
		const content = "<!-- private maintainer note -->\n\n- [Fact](fact.md) — visible\n";
		expect(loadableIndexContent(content).trim()).toBe("- [Fact](fact.md) — visible");
	});
});
