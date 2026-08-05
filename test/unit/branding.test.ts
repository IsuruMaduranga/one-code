import { describe, expect, it } from "vitest";
import { LOGO_LINES, bannerLines } from "../../extensions/branding/index.ts";

// Identity paint keeps assertions about layout free of colour codes.
const plain = (_color: string, text: string) => text;

describe("bannerLines", () => {
	it("leads with the package name and version", () => {
		const [title] = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		expect(title).toContain("pi-claude-code");
		expect(title).toContain("v0.1.0");
		expect(title).toContain("Claude Code on the pi harness");
	});

	it("lists the key shortcuts across the hint lines", () => {
		const hints = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain).join("\n");
		for (const key of [
			"shift+tab thinking",
			"ctrl+l model",
			"ctrl+p cycle model",
			"/permission-mode mode",
			"ctrl+t thinking blocks",
			"ctrl+o tool output",
			"ctrl+g external editor",
			"ctrl+v paste image",
			"alt+enter follow-up",
			"escape interrupt",
			"ctrl+c/ctrl+d clear/exit",
			"/ commands",
			"! bash",
		]) {
			expect(hints).toContain(key);
		}
	});

	it("shows the model when known and always the mode", () => {
		const lines = bannerLines({ version: "0.1.0", model: "gpt-5.5", cwd: "/p", mode: "acceptEdits" }, plain);
		const context = lines[lines.length - 1];
		expect(context).toContain("model gpt-5.5");
		expect(context).toContain("mode acceptEdits");
	});

	it("omits the model line content when no model is resolved", () => {
		const lines = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		const context = lines[lines.length - 1];
		expect(context).not.toContain("model");
		expect(context).toContain("default");
	});

	it("applies the paint function it is given", () => {
		const [title] = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, (c, t) => `<${c}>${t}</${c}>`);
		expect(title).toContain("<accent>pi-claude-code</accent>");
	});

	it("puts one equal-width logo row (or padding) before each text line, so the text column aligns", () => {
		const lines = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		expect(lines.length).toBeGreaterThanOrEqual(LOGO_LINES.length);
		const widths = new Set(LOGO_LINES.map((art) => [...art].length));
		expect(widths.size).toBe(1);
		const logoWidth = [...LOGO_LINES[0]].length;
		for (const [i, line] of lines.entries()) {
			expect(line.startsWith(`${LOGO_LINES[i] ?? " ".repeat(logoWidth)}  `)).toBe(true);
		}
	});
});
