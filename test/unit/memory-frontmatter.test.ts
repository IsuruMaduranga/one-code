import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { stampFrontmatter } from "../../extensions/lib/memory.ts";

const modified = "2026-10-10T00:00:00.000Z";
const stamp = (content: string) => stampFrontmatter(content, "new-session", modified);
const header = (content: string) => parse(content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] ?? "");

describe("memory frontmatter safety", () => {
	it("stamps a valid flow mapping without duplicating metadata", () => {
		const out = stamp("---\nname: fact\nmetadata: { type: project, custom: keep }\n---\nbody\n");
		expect(header(out).metadata).toEqual({ node_type: "memory", type: "project", custom: "keep", originSessionId: "new-session", modified });
		expect(out.endsWith("---\nbody\n")).toBe(true);
	});

	it("preserves comments on the metadata mapping", () => {
		const out = stamp("---\nname: fact\nmetadata: # note\n  type: project # keep\n---\nbody\n");
		expect(header(out).metadata.type).toBe("project");
		expect(header(out).metadata.modified).toBe(modified);
		expect(out).toContain("# note");
		expect(out).toContain("# keep");
	});

	it("preserves nonstandard indentation and quoted metadata keys without duplicates", () => {
		const out = stamp('---\nname: fact\n"metadata":\n    type: project\n    originSessionId: original\n    modified: before\n---\nbody\n');
		expect(header(out).metadata).toMatchObject({ type: "project", originSessionId: "original", modified });
	});

	it("does not remove unrelated nested provenance fields", () => {
		const out = stamp("---\nname: fact\ncustom:\n  modified: keep\n  originSessionId: also-keep\nmetadata:\n  type: project\n---\nbody\n");
		expect(header(out).custom).toEqual({ modified: "keep", originSessionId: "also-keep" });
	});

	it("preserves CRLF delimiters and body while stamping", () => {
		const out = stamp("---\r\nname: fact\r\nmetadata:\r\n  type: project\r\n---\r\nbody\r\n");
		expect(header(out).metadata.modified).toBe(modified);
		expect(out.replaceAll("\r\n", "")).not.toContain("\n");
		expect(out.endsWith("---\r\nbody\r\n")).toBe(true);
	});

	it("preserves a byte-order mark while stamping", () => {
		const out = stamp("\uFEFF---\nname: fact\nmetadata:\n  type: project\n---\nbody\n");
		expect(out.startsWith("\uFEFF---\n")).toBe(true);
		expect(header(out).metadata.modified).toBe(modified);
	});

	it("retains the originating session when another session updates a memory", () => {
		const out = stamp("---\nname: fact\nmetadata:\n  originSessionId: original\n  modified: before\n---\nbody\n");
		expect(header(out).metadata.originSessionId).toBe("original");
		expect(header(out).metadata.modified).toBe(modified);
	});

	it.each(["note", "[project, feedback]"])("leaves non-mapping metadata %s intact", (metadata) => {
		const content = `---\nname: fact\nmetadata: ${metadata}\n---\nbody\n`;
		expect(stamp(content)).toBe(content);
	});

	it.each([
		"---\nname: fact\n---not-a-delimiter\nbody\n",
		"---\nname: fact\nmetadata: [unterminated\n---\nbody\n",
		"---\nname: fact\nmetadata: {}\nmetadata: {}\n---\nbody\n",
		'---\nname: "ambiguous---name"\nmetadata: {}\n---\nbody\n',
		"---\n- not-a-mapping\n---\nbody\n",
		"---\nname: fact\nmetadata: {}\n---\nbody\u0000binary\n",
		"---\nname: fact\ncustom: &shared { type: project }\nmetadata: *shared\n---\nbody\n",
	])("leaves malformed, ambiguous, binary, or aliased content untouched: %j", (content) => {
		expect(stamp(content)).toBe(content);
	});
});
