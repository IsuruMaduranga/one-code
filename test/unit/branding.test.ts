import { describe, expect, it } from "vitest";
import { LOGO_LINES, bannerLines, truncateLine } from "../../extensions/branding/index.ts";

// Identity paint keeps assertions about layout free of colour codes.
const plain = (_color: string, text: string) => text;

describe("bannerLines", () => {
	it("leads with the brand name and version", () => {
		const [title] = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain);
		expect(title).toContain("pincer");
		expect(title).toContain("v0.1.0");
		expect(title).toContain("the Claude Code experience, on the pi harness");
	});

	it("lists the key shortcuts across the hint lines", () => {
		const hints = bannerLines({ version: "0.1.0", cwd: "/p", mode: "default" }, plain).join("\n");
		for (const key of [
			"shift+tab cycle effort",
			"/effort effort + ultracode",
			"ctrl+l model",
			"ctrl+p cycle model",
			"ctrl+q permission mode",
			"ctrl+t thinking blocks",
			"ctrl+o tool output",
			"ctrl+g external editor",
			"ctrl+v paste image",
			"alt+enter follow-up",
			"escape interrupt",
			"ctrl+c/ctrl+d clear/exit",
			"/ commands",
			"! bash",
			"ultracode multi-agent workflow",
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
		expect(title).toContain("<accent>pincer</accent>");
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

describe("truncateLine", () => {
	const visible = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").length;

	it("leaves a line that fits alone", () => {
		expect(truncateLine("short", 80)).toBe("short");
		expect(truncateLine("\x1b[31mred\x1b[0m", 80)).toBe("\x1b[31mred\x1b[0m");
	});

	it("cuts to the visible width, not the string length", () => {
		// pi-tui crashes the whole app on an overwide line, so this is a
		// correctness bound, not cosmetics.
		const painted = `\x1b[36m${"x".repeat(200)}\x1b[0m`;
		const cut = truncateLine(painted, 50);
		expect(visible(cut)).toBeLessThanOrEqual(50);
		expect(cut.endsWith("…")).toBe(true);
	});

	it("never splits an ANSI escape and always resets before the ellipsis", () => {
		const painted = `${"a".repeat(10)}\x1b[35m${"b".repeat(10)}`;
		const cut = truncateLine(painted, 15);
		expect(cut).toContain("\x1b[35m");
		expect(cut).toContain("\x1b[0m…");
		expect(visible(cut)).toBe(15);
	});

	it("every banner line respects a narrow width", () => {
		const paint = (_c: string, t: string) => `\x1b[36m${t}\x1b[0m`;
		const lines = bannerLines(
			{
				version: "1.0.0",
				model: "claude-haiku-4-5",
				cwd: "/repo",
				mode: "auto · classifier haiku-4-5 (planned)",
				sections: [{ label: "skills", items: Array.from({ length: 30 }, (_v, i) => `skill-${i}`) }],
			},
			paint,
			80,
		);
		for (const line of lines) {
			expect(visible(line)).toBeLessThanOrEqual(80);
		}
	});
});
