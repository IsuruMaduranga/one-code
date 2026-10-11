import { describe, expect, it } from "vitest";
import { PANEL_FOCUS_CHANNEL, PanelFocus, panelFactory, panelUi } from "../../extensions/lib/panel-focus.ts";

/** A bus that feeds one PanelFocus, as the permissions extension listens. */
function bus() {
	const focus = new PanelFocus();
	const events = { emit: (channel: string, data: unknown) => channel === PANEL_FOCUS_CHANNEL && focus.note(data) };
	return { focus, events };
}

/** pi-tui's setFocus: clears `focused` on the old component and sets it on the new one. */
function setFocus(from: any, to: any) {
	if (from && "focused" in from) from.focused = false;
	if (to && "focused" in to) to.focused = true;
}

describe("panelFactory", () => {
	it("reports the panel focused while it holds the keyboard, and gone when it closes", () => {
		const { focus, events } = bus();
		let close!: (value: unknown) => void;
		const component = panelFactory(events, (_tui: unknown, _theme: unknown, _kb: unknown, done: (value: unknown) => void) => {
			close = done;
			return { render: () => [] };
		})(undefined, undefined, undefined, () => {});
		expect(focus.busy).toBe(false);
		setFocus(undefined, component);
		expect(focus.busy).toBe(true);
		close(null);
		expect(focus.busy).toBe(false);
	});

	it("counts a panel that something else displaced as gone", () => {
		const { focus, events } = bus();
		const component = panelFactory(events, (..._args: unknown[]) => ({ render: () => [] }))(undefined, undefined, undefined, () => {});
		setFocus(undefined, component);
		const dialog = { focused: false };
		setFocus(component, dialog);
		expect(focus.busy).toBe(false);
	});

	it("keeps a component's own focused accessor working", () => {
		const { events } = bus();
		class Input {
			seen: boolean[] = [];
			private on = false;
			get focused() {
				return this.on;
			}
			set focused(value: boolean) {
				this.on = value;
				this.seen.push(value);
			}
		}
		const component = panelFactory(events, (..._args: unknown[]) => new Input())(undefined, undefined, undefined, () => {});
		component.focused = true;
		expect(component.focused).toBe(true);
		expect(component.seen).toEqual([true]);
	});

	it("wraps a factory that returns a promise", async () => {
		const { focus, events } = bus();
		const component = await panelFactory(events, async (..._args: unknown[]) => ({ render: () => [] }))(undefined, undefined, undefined, () => {});
		setFocus(undefined, component);
		expect(focus.busy).toBe(true);
	});

	it("panelUi passes the wrapped factory and the options through", async () => {
		const { focus, events } = bus();
		const calls: unknown[][] = [];
		const ui = {
			custom: async (factory: (...args: unknown[]) => unknown, options?: unknown) => {
				calls.push([options]);
				setFocus(undefined, factory(undefined, undefined, undefined, () => {}));
				return "chosen";
			},
		};
		expect(await panelUi(events, ui).custom(() => ({ render: () => [] }), { overlay: true })).toBe("chosen");
		expect(calls).toEqual([[{ overlay: true }]]);
		expect(focus.busy).toBe(true);
	});
});

describe("PanelFocus", () => {
	it("lets waiters through when the last panel goes, or when their signal aborts", async () => {
		const focus = new PanelFocus();
		const a = {};
		const b = {};
		focus.note({ id: a, focused: true });
		focus.note({ id: b, focused: true });
		let cleared = false;
		const wait = focus.whenClear().then(() => {
			cleared = true;
		});
		focus.note({ id: a, focused: false });
		await Promise.resolve();
		expect(cleared).toBe(false);
		focus.note({ id: b, focused: false });
		await wait;
		expect(cleared).toBe(true);

		focus.note({ id: a, focused: true });
		const controller = new AbortController();
		const aborted = focus.whenClear(controller.signal);
		controller.abort();
		await aborted;
		expect(focus.busy).toBe(true);
		focus.reset();
		expect(focus.busy).toBe(false);
	});

	it("resolves at once when nothing is focused, and ignores malformed events", async () => {
		const focus = new PanelFocus();
		focus.note(undefined);
		focus.note({ focused: true });
		expect(focus.busy).toBe(false);
		await focus.whenClear();
	});
});
