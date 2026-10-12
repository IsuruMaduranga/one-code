import { describe, expect, it } from "vitest";
import { DOCK_ROWS_CHANNEL, DockRows, dockRowsReporter } from "../../extensions/lib/dock-rows.ts";

describe("dock rows", () => {
	it("reports a strip's rows only on a change, and sums the other strips", () => {
		const sent: unknown[] = [];
		const events = { emit: (channel: string, data: unknown) => channel === DOCK_ROWS_CHANNEL && sent.push(data) };
		const report = dockRowsReporter(events, "subagents");
		report(2);
		report(2);
		report(0);
		expect(sent).toEqual([{ source: "subagents", rows: 2 }, { source: "subagents", rows: 0 }]);

		const dock = new DockRows();
		dock.note({ source: "subagents", rows: 2 });
		dock.note({ source: "workflow", rows: 1 });
		expect(dock.others("workflow")).toBe(2);
		expect(dock.others("subagents")).toBe(1);
		dock.note({ source: "subagents", rows: 0 });
		expect(dock.others("workflow")).toBe(0);
		dock.note({ rows: 3 }); // malformed: ignored
		expect(dock.others("workflow")).toBe(0);
	});
});
