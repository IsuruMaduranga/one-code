import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatterLoosely } from "../../extensions/lib/frontmatter.ts";
import { expandTilde } from "../../extensions/lib/paths.ts";

describe("parseFrontmatterLoosely (A8)", () => {
	it("parses valid frontmatter through pi's parser", () => {
		const { frontmatter, body } = parseFrontmatterLoosely("---\nname: x\ndescription: does things\n---\nBody");
		expect(frontmatter).toEqual({ name: "x", description: "does things" });
		expect(body.trim()).toBe("Body");
	});

	it("salvages key: value lines when strict YAML rejects the block (trap #7)", () => {
		// An unquoted `: ` inside a value is invalid YAML for the strict parser.
		const raw = "---\nname: deploy\ndescription: Deploy: run the release steps\n---\nDo it";
		const { frontmatter, body } = parseFrontmatterLoosely(raw);
		expect(frontmatter.name).toBe("deploy");
		expect(String(frontmatter.description)).toContain("run the release steps");
		expect(body.trim()).toBe("Do it");
	});

	it("returns the whole text as body when there is no frontmatter", () => {
		expect(parseFrontmatterLoosely("just prose")).toEqual({ frontmatter: {}, body: "just prose" });
	});
});

describe("expandTilde (A13)", () => {
	it("expands ~ and ~/ against the given home and leaves ~user alone", () => {
		expect(expandTilde("~", "/home/me")).toBe("/home/me");
		expect(expandTilde("~/x/y", "/home/me")).toBe(join("/home/me", "x", "y"));
		expect(expandTilde("~other/x", "/home/me")).toBe("~other/x");
		expect(expandTilde("/abs", "/home/me")).toBe("/abs");
		expect(expandTilde("rel", "/home/me")).toBe("rel");
	});
});
