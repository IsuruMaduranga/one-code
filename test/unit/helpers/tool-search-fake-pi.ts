/**
 * The fake pi the tool-search wiring tests drive: an event bus that records
 * every reminder, a lifecycle `fire()`, and a mutable tool registry / active
 * set. Shared by tool-search-defer-miss.test.ts and tool-search-announce.test.ts.
 */
import { DEFER_CHANNEL } from "../../../extensions/lib/deferred.ts";
import { REMINDER_CHANNEL } from "../../../extensions/lib/reminders.ts";

export interface Reminder {
	scope?: string;
	key?: string;
	text?: string;
	placement?: string;
}

export function makeToolSearchFakePi(initialActive: string[] = []) {
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const lifecycleHandlers = new Map<string, Array<(event: unknown) => void>>();
	const reminders: Reminder[] = [];
	let active: string[] = initialActive;
	const allTools: Array<{ name: string; description: string }> = [];

	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const list = busHandlers.get(channel) ?? [];
				list.push(handler);
				busHandlers.set(channel, list);
			},
			emit(channel: string, data: unknown) {
				if (channel === REMINDER_CHANNEL) reminders.push(data as Reminder);
				for (const h of busHandlers.get(channel) ?? []) h(data);
			},
		},
		on(event: string, handler: (event: unknown) => void) {
			const list = lifecycleHandlers.get(event) ?? [];
			list.push(handler);
			lifecycleHandlers.set(event, list);
		},
		fire(event: string, payload: unknown) {
			for (const h of lifecycleHandlers.get(event) ?? []) h(payload);
		},
		getAllTools: () => allTools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		registerTool: () => {},
		registerCommand: () => {},
	};

	/** Register a tool the way its owning extension would (active), then defer it. */
	const addDeferred = (name: string) => {
		allTools.push({ name, description: `${name} tool` });
		active = [...active, name];
		pi.events.emit(DEFER_CHANNEL, { name });
	};

	return { pi, reminders, allTools, setActive: (n: string[]) => (active = n), activeTools: () => active, addDeferred };
}
