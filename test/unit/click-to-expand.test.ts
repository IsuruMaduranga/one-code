import { Container, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { ClickToggles, clickToExpand } from "../../extensions/lib/ui/tui-render.ts";

const row = (expanded: boolean) => ({ render: () => [expanded ? "open" : "closed"], invalidate: () => {} });
const click = { type: "click", button: "left" };

describe("clickToExpand", () => {
	it("toggles on a left click and leaves the press to pi-tui's text selection", () => {
		const toggles = new ClickToggles();
		const message = {};
		const component = clickToExpand(toggles, message, false, row);
		expect(component.render(80)).toEqual(["closed"]);
		expect(component.handleMouse({ type: "click", button: "right" })).toBeUndefined();
		expect(component.handleMouse({ type: "press", button: "right" })).toBeUndefined();
		expect(component.handleMouse({ type: "press", button: "left" })).toBeUndefined();
		expect(component.render(80)).toEqual(["closed"]);
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

	it("ends a click's override when ctrl+o changes and changes back, with no click between", () => {
		const toggles = new ClickToggles();
		const message = {};
		clickToExpand(toggles, message, false, row).handleMouse(click);
		expect(clickToExpand(toggles, message, false, row).render(80)).toEqual(["open"]);
		// pi rebuilds every custom row on each ctrl+o.
		expect(clickToExpand(toggles, message, true, row).render(80)).toEqual(["open"]);
		expect(clickToExpand(toggles, message, false, row).render(80)).toEqual(["closed"]);
	});

	it("ends the override when another row sees the ctrl+o change first", () => {
		const toggles = new ClickToggles();
		const message = {};
		clickToExpand(toggles, message, false, row).handleMouse(click);
		clickToExpand(toggles, {}, true, row);
		clickToExpand(toggles, {}, false, row);
		expect(clickToExpand(toggles, message, false, row).render(80)).toEqual(["closed"]);
	});
});

/**
 * The same rows under pi-tui's real fullscreen mouse dispatcher: SGR mouse
 * reports go in through the terminal. The press starts pi-tui's selection,
 * and a release on the same cell ends it with a click to the row.
 */
describe("clickToExpand under pi-tui's mouse dispatcher", () => {
	let tui: TuiAltScreen | undefined;
	afterEach(() => {
		tui?.stop();
		tui = undefined;
	});

	function screen() {
		let feed: (data: string) => void = () => {};
		const terminal = {
			start: (onInput: (data: string) => void) => {
				feed = onInput;
			},
			stop: () => {},
			drainInput: async () => {},
			write: () => {},
			columns: 40,
			rows: 10,
			kittyProtocolActive: false,
			moveBy: () => {},
			hideCursor: () => {},
			showCursor: () => {},
			clearLine: () => {},
			clearFromCursor: () => {},
			clearScreen: () => {},
			setTitle: () => {},
			setProgress: () => {},
			setProgramStatus: () => {},
		};
		const toggles = new ClickToggles();
		const message = {};
		const host = new Container();
		host.addChild(clickToExpand(toggles, message, false, row) as never);
		tui = new TuiAltScreen(terminal as never, false, undefined, { mouse: true });
		tui.addChild(host);
		tui.start();
		// The layout pi-tui hit-tests against comes from a render.
		const render = () => (tui as unknown as { doRender(): void }).doRender();
		render();
		const shown = () => host.render(40)[0];
		// SGR reports are 1-based; the row is on the first line.
		const press = (x: number, y: number) => feed(`\x1b[<0;${x};${y}M`);
		const drag = (x: number, y: number) => feed(`\x1b[<32;${x};${y}M`);
		const release = (x: number, y: number) => feed(`\x1b[<0;${x};${y}m`);
		return { shown, press, drag, release, render };
	}

	it("a click (press and release on the same cell) toggles the row", () => {
		const { shown, press, release, render } = screen();
		expect(shown()).toBe("closed");
		press(3, 1);
		expect(shown()).toBe("closed");
		release(3, 1);
		expect(shown()).toBe("open");
		render();
		press(3, 1);
		release(3, 1);
		expect(shown()).toBe("closed");
	});

	it("a drag that starts on the row does not toggle it", () => {
		const { shown, press, drag, release } = screen();
		press(3, 1);
		drag(6, 1);
		release(6, 1);
		expect(shown()).toBe("closed");
	});
});
