import { describe, expect, it } from "vitest";
import { bannerLines } from "../../extensions/branding/index.ts";

// Identity paint keeps assertions about layout free of colour codes.
const plain = (_color: string, text: string) => text;

describe("bannerLines", () => {
	it("leads with the package name and version", () => {
		const [title] = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		expect(title).toContain("pi-claude-code");
		expect(title).toContain("v0.1.0");
		expect(title).toContain("Claude Code on the pi harness");
	});

	it("lists the key hints", () => {
		const [, hints] = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		for (const key of ["escape", "ctrl+c/ctrl+d", "/", "!", "ctrl+o"]) {
			expect(hints).toContain(key);
		}
	});

	it("shows the model when known and always the mode", () => {
		const [, , context] = bannerLines(
			{ version: "0.1.0", model: "gpt-5.5", cwd: "/p", mode: "acceptEdits" },
			plain,
		);
		expect(context).toContain("gpt-5.5");
		expect(context).toContain("acceptEdits");
	});

	it("omits the model line content when no model is resolved", () => {
		const [, , context] = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		expect(context).not.toContain("model");
		expect(context).toContain("default");
	});

	it("applies the paint function it is given", () => {
		const [title] = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, (c, t) => `<${c}>${t}</${c}>`);
		expect(title).toContain("<accent>pi-claude-code</accent>");
	});
});
