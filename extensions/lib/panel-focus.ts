/**
 * Which One Code panels hold the keyboard, over the event bus (jiti modules
 * cannot share state), so a permission prompt waits for a panel to close
 * instead of taking its place. Pure: no pi imports.
 *
 * pi shows a dialog (`ctx.ui.select`, `input`, `confirm`) in the slot a
 * `ctx.ui.custom` panel occupies: the dialog replaces the panel and takes its
 * focus, the panel never comes back, and an Enter typed for the panel answers
 * the dialog. Claude Code holds a permission dialog while a command's panel
 * is open. So every panel goes through `panelFactory`, which reports when its
 * component gains and loses focus, and the permissions extension queues its
 * prompts until no panel is focused (`PanelFocus.whenClear`).
 *
 * Focus is read from pi-tui's own `focused` flag, which `setFocus` sets on a
 * component that has the property: a panel that something else displaced
 * reports itself gone at once, so a prompt can never wait on a panel that is
 * no longer on screen.
 */

export const PANEL_FOCUS_CHANNEL = "one-code:panel-focus";

/** One panel's focus change; `id` is an object unique to the panel. */
export interface PanelFocusEvent {
	id: object;
	focused: boolean;
}

interface Emitter {
	emit(channel: string, data: unknown): void;
}

function findDescriptor(target: object, key: string): PropertyDescriptor | undefined {
	for (let at: object | null = target; at; at = Object.getPrototypeOf(at)) {
		const found = Object.getOwnPropertyDescriptor(at, key);
		if (found) return found;
	}
	return undefined;
}

/** Report every write to the component's `focused` flag, keeping whatever the component does with it. */
function watchFocus(component: object, onChange: (focused: boolean) => void): void {
	const own = findDescriptor(component, "focused");
	let value: unknown = own && "value" in own ? own.value : undefined;
	Object.defineProperty(component, "focused", {
		configurable: true,
		enumerable: true,
		get: () => (own?.get ? own.get.call(component) : value),
		set: (next: unknown) => {
			if (own?.set) own.set.call(component, next);
			else value = next;
			onChange(Boolean(next));
		},
	});
}

/**
 * A `ctx.ui.custom` factory that reports its panel's focus on
 * `PANEL_FOCUS_CHANNEL`: `ctx.ui.custom(panelFactory(pi.events, (tui, theme,
 * keybindings, done) => …))`. The panel counts as gone when it loses focus or
 * calls `done`.
 */
export function panelFactory<A extends unknown[], C>(events: Emitter, factory: (...args: A) => C): (...args: A) => C {
	return (...args: A): C => {
		const id = {};
		const report = (focused: boolean) => events.emit(PANEL_FOCUS_CHANNEL, { id, focused } satisfies PanelFocusEvent);
		const done = args[3];
		if (typeof done === "function") {
			args[3] = ((...result: unknown[]) => {
				report(false);
				return done(...result);
			}) as A[3];
		}
		const watch = (component: unknown) => {
			if (component && typeof component === "object") watchFocus(component, report);
			return component;
		};
		const made = factory(...args);
		return (made instanceof Promise ? made.then(watch) : watch(made)) as C;
	};
}

/**
 * `ctx.ui` with a `custom` whose panels report their focus:
 * `panelUi(pi.events, ctx.ui).custom<T>((tui, theme, keybindings, done) => …)`.
 */
export function panelUi<U extends { custom: (...args: any[]) => any }>(events: Emitter, ui: U): Pick<U, "custom"> {
	const custom = (factory: (...args: unknown[]) => unknown, ...rest: unknown[]) => ui.custom(panelFactory(events, factory), ...rest);
	return { custom: custom as U["custom"] };
}

/** The focused panels, fed from `PANEL_FOCUS_CHANNEL`. */
export class PanelFocus {
	private readonly focused = new Set<object>();
	private waiters = new Set<() => void>();

	note(data: unknown): void {
		const event = data as Partial<PanelFocusEvent> | undefined;
		if (!event || typeof event.id !== "object" || event.id === null) return;
		if (event.focused) this.focused.add(event.id);
		else this.focused.delete(event.id);
		if (this.focused.size === 0) this.release();
	}

	/** True while a panel holds the keyboard. */
	get busy(): boolean {
		return this.focused.size > 0;
	}

	/** Resolves once no panel is focused, or when `signal` aborts. */
	whenClear(signal?: AbortSignal): Promise<void> {
		if (!this.busy || signal?.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const finish = () => {
				this.waiters.delete(finish);
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			this.waiters.add(finish);
			signal?.addEventListener("abort", finish, { once: true });
		});
	}

	/** Forget every panel (a new session) and let waiting prompts through. */
	reset(): void {
		this.focused.clear();
		this.release();
	}

	private release(): void {
		const waiting = this.waiters;
		this.waiters = new Set();
		for (const finish of waiting) finish();
	}
}
