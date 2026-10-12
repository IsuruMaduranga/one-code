/**
 * Rows each extension paints below the editor (the "dock": the subagent strip
 * and shells chip, the workflow status rows), shared over `pi.events` (pure:
 * no pi imports). A panel that takes the editor's place sizes itself to what
 * the dock leaves: pi cuts a component taller than its share from the bottom,
 * which took the viewer's key-hint row when only its own strip was counted.
 *
 * Extensions are isolated (jiti), so each one keeps its own `DockRows` fed from
 * the channel; a source reports through `dockRowsReporter`, which emits only
 * on a change.
 */

export const DOCK_ROWS_CHANNEL = "one-code:dock-rows";

export interface DockRowsEvent {
	/** The reporting strip, e.g. "subagents" or "workflow". */
	source: string;
	/** Rows it paints now; 0 when it shows nothing. */
	rows: number;
}

interface Emitter {
	emit(channel: string, data: unknown): void;
}

/** A source's reporter: call it with the rows painted on each render; it emits only when the count changes. */
export function dockRowsReporter(events: Emitter, source: string): (rows: number) => void {
	let last = 0;
	return (rows) => {
		if (rows === last) return;
		last = rows;
		events.emit(DOCK_ROWS_CHANNEL, { source, rows } satisfies DockRowsEvent);
	};
}

/** A `DockRows` fed from `events`, for an extension that sizes a view to the dock. */
export function trackDockRows(events: { on(channel: string, handler: (data: unknown) => void): unknown }): DockRows {
	const dock = new DockRows();
	events.on(DOCK_ROWS_CHANNEL, (data) => dock.note(data));
	return dock;
}

/** The dock's rows as reported, by source. */
export class DockRows {
	private readonly rows = new Map<string, number>();

	note(data: unknown): void {
		const event = data as Partial<DockRowsEvent> | undefined;
		if (typeof event?.source !== "string" || typeof event.rows !== "number") return;
		if (event.rows > 0) this.rows.set(event.source, event.rows);
		else this.rows.delete(event.source);
	}

	/** Rows every source other than `self` paints. */
	others(self: string): number {
		let total = 0;
		for (const [source, rows] of this.rows) if (source !== self) total += rows;
		return total;
	}
}
