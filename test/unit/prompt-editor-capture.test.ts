/**
 * The prompt editor asks pi-tui (1.5) for the fullscreen viewport keys while
 * an agent view is open, so they reach the subagents extension's listener
 * instead of scrolling the main transcript under the view; it no longer acts
 * on them itself. The wheel over its rows scrolls the view.
 */
import { describe, expect, it } from "vitest";
import type { AgentViewScroll } from "../../extensions/lib/agents/agent-view.ts";
import { PromptEditor } from "../../extensions/ui/branding/prompt-editor.ts";

const plain = (text: string) => text;
const theme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const tui = { requestRender: () => {}, terminal: { rows: 30, columns: 80 } };
const keys = { matches: (data: string, binding: string) => data === "\x1b[5~" && binding === "tui.altScreen.pageUp" };

function editor(viewOpen: () => boolean, moves: AgentViewScroll[] = []) {
	return new PromptEditor(tui as never, theme as never, keys as never, () => "> ", undefined, undefined, undefined, undefined, () => (viewOpen() ? (move) => moves.push(move) : undefined));
}

describe("PromptEditor and the agent view", () => {
	it("captures the viewport keys only while a view is open", () => {
		let open = false;
		const prompt = editor(() => open);
		expect(prompt.capturesViewportInput).toBe(false);
		open = true;
		expect(prompt.capturesViewportInput).toBe(true);
	});

	it("leaves a page key to the listeners: it does not scroll the view itself", () => {
		const moves: AgentViewScroll[] = [];
		const prompt = editor(() => true, moves);
		prompt.handleInput("\x1b[5~");
		expect(moves).toEqual([]);
	});

	it("scrolls an open view by a wheel over its rows", () => {
		const moves: AgentViewScroll[] = [];
		const prompt = editor(() => true, moves);
		expect(prompt.handleMouse({ type: "wheel", wheelDelta: -3, button: "none", x: 0, y: 0 } as never)).toEqual({ handled: true });
		expect(moves).toEqual([{ action: "wheel", lines: -3 }]);
	});
});
