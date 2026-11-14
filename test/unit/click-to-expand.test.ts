import { describe, expect, it } from "vitest";
import { ClickToggles, clickToExpand } from "../../extensions/lib/ui/tui-render.ts";

const row = (expanded: boolean) => ({ render: () => [expanded ? "open" : "closed"], invalidate: () => {} });
const click = { type: "click", button: "left" };

describe("clickToExpand", () => {
	it("toggles the row on a left click and ignores other mouse events", () => {
		const toggles = new ClickToggles();
		const message = {};
		const component = clickToExpand(toggles, message, false, row);
		expect(component.render(80)).toEqual(["closed"]);
		expect(component.handleMouse({ type: "click", button: "right" })).toBeUndefined();
		expect(component.handleMouse({ type: "press", button: "left" })).toBeUndefined();
		expect(component.handleMouse(click)).toEqual({ handled: true });
		expect(component.render(80)).toEqual(["open"]);
		expect(component.handleMouse(click)).toEqual({ handled: true });
		expect(component.render(80)).toEqual(["closed"]);
	});

	it("keeps a click across pi's rebuilds of the same message, and only that message", () => {
		const toggles = new ClickToggles();
		const message = {};
		clickToExpand(toggles, message, false, row).handleMouse(click);
		expect(clickToExpand(toggles, message, false, row).render(80)).toEqual(["open"]);
		expect(clickToExpand(toggles, {}, false, row).render(80)).toEqual(["closed"]);
	});

	it("gives way to a later ctrl+o", () => {
		const toggles = new ClickToggles();
		const message = {};
		clickToExpand(toggles, message, false, row).handleMouse(click);
		// ctrl+o expands everything: the row follows it.
		expect(clickToExpand(toggles, message, true, row).render(80)).toEqual(["open"]);
		clickToExpand(toggles, message, true, row).handleMouse(click);
		expect(clickToExpand(toggles, message, true, row).render(80)).toEqual(["closed"]);
		// ctrl+o collapses everything again.
		expect(clickToExpand(toggles, message, false, row).render(80)).toEqual(["closed"]);
	});
});
