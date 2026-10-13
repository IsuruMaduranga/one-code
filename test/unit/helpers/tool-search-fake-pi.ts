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
	const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const reminders: Reminder[] = [];
	let active: string[] = initialActive;
	const allTools: Array<{ name: string; description: string }> = [];
	const registered = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();

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
		on(event: string, handler: (event: unknown, ctx?: unknown) => unknown) {
			const list = lifecycleHandlers.get(event) ?? [];
			list.push(handler);
			lifecycleHandlers.set(event, list);
		},
		/** `ctx` is optional: most tests need none; a session_start with a transcript passes a fake sessionManager. Returns each handler's result. */
		fire(event: string, payload: unknown, ctx?: unknown): unknown[] {
			return (lifecycleHandlers.get(event) ?? []).map((h) => h(payload, ctx));
		},
		getAllTools: () => allTools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		/** Registered tools join getAllTools, as in pi (deferral keys on tool_search being there). */
		registerTool: (tool: { name: string; description?: string; execute: (id: string, params: unknown) => Promise<unknown> }) => {
			registered.set(tool.name, tool);
			allTools.push({ name: tool.name, description: tool.description ?? "" });
		},
		registerCommand: () => {},
	};

	/** Register a tool the way its owning extension would (active), then defer it. */
	const addDeferred = (name: string) => {
		allTools.push({ name, description: `${name} tool` });
		active = [...active, name];
		pi.events.emit(DEFER_CHANNEL, { name });
	};

	/** Run a tool the extension registered (tool_search), as pi would. */
	const runTool = (name: string, params: unknown) => {
		const tool = registered.get(name);
		if (!tool) throw new Error(`tool ${name} was not registered`);
		return tool.execute("call-1", params) as Promise<{ content: Array<{ text: string }>; details: unknown }>;
	};

	return { pi, reminders, allTools, setActive: (n: string[]) => (active = n), activeTools: () => active, addDeferred, runTool };
}
