/** The consent dialog for imports outside the project names the files whose imports reach them. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { externalIncludesDialog } from "../../extensions/lib/context/external-includes.ts";

const home = join("/", "home", "u");
const at = (name: string, importer: string) => ({ path: join(home, name), importer });

describe("externalIncludesDialog", () => {
	it("names each importing file once, in the order found", () => {
		const one = externalIncludesDialog([at("a.md", "AGENTS.md")], home, "AGENTS.md");
		expect(one).toContain("This project's AGENTS.md imports files outside the current working directory.");
		const two = externalIncludesDialog([at("a.md", "AGENTS.md"), at("b.md", "PRODUCT.md"), at("c.md", "AGENTS.md")], home, "AGENTS.md");
		expect(two).toContain("This project's AGENTS.md or PRODUCT.md imports files outside");
		const three = externalIncludesDialog([at("a.md", "A.md"), at("b.md", "B.md"), at("c.md", "rules")], home, "A.md");
		expect(three).toContain("This project's A.md, B.md or rules imports files outside");
	});
});
