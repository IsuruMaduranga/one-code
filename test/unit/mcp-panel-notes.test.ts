/** The /mcp list's config notes stay within the panel's height. */
import { describe, expect, it } from "vitest";
import { renderMcpPanel } from "../../extensions/tools/mcp/panel/render.ts";
import { initialMcpState } from "../../extensions/tools/mcp/panel/state.ts";
import { plainTheme } from "./helpers/plain-theme.ts";

const paint = plainTheme as never;
const server = { name: "docs", group: "User MCPs", status: "connected", toolCount: 3, configLocation: "~/.onecode/mcp.json" } as never;
const render = (configNotes: string[], height: number, entries: never[] = []) =>
	renderMcpPanel({ state: initialMcpState(), entries, width: 80, height, notices: [], configNotes, settled: true, where: "~/.onecode/mcp.json" }, paint);

describe("the /mcp panel's config notes", () => {
	const notes = Array.from({ length: 20 }, (_, index) => `MCP server "s${index}" has neither a url nor a command.`);

	it("shows every note when they fit", () => {
		const lines = render(notes.slice(0, 3), 22);
		for (const note of notes.slice(0, 3)) expect(lines.join("\n")).toContain(note);
		expect(lines.length).toBeLessThanOrEqual(22);
	});

	it("cuts the notes to the rows left and says how many more there are", () => {
		const lines = render(notes, 22);
		expect(lines.length).toBeLessThanOrEqual(22);
		expect(lines.join("\n")).toContain('"s0"');
		expect(lines.join("\n")).toMatch(/… \d+ more lines, shown in full when the session starts/);
		expect(lines.at(-1)).toContain("Esc to cancel");
		const withServer = render(notes, 22, [server]);
		expect(withServer.length).toBeLessThanOrEqual(22);
		expect(withServer.join("\n")).toContain("docs");
	});
});
