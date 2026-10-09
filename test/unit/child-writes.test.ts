import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { childWriteWatcher } from "../../extensions/lib/child-writes.ts";

describe("childWriteWatcher", () => {
	const cwd = resolve("/work/project");

	it("returns the resolved path when an edit or write ends without an error", () => {
		const watch = childWriteWatcher(cwd);
		expect(watch({ type: "tool_execution_start", toolName: "edit", toolCallId: "1", args: { path: "src/a.ts" } })).toBeUndefined();
		expect(watch({ type: "tool_execution_end", toolName: "edit", toolCallId: "1", isError: false })).toBe(join(cwd, "src", "a.ts"));
		watch({ type: "tool_execution_start", toolName: "write", toolCallId: "2", args: { file_path: join(cwd, "b.md") } });
		expect(watch({ type: "tool_execution_end", toolName: "write", toolCallId: "2" })).toBe(join(cwd, "b.md"));
	});

	it("ignores failed writes, other tools and unmatched ends", () => {
		const watch = childWriteWatcher(cwd);
		watch({ type: "tool_execution_start", toolName: "edit", toolCallId: "1", args: { path: "a.ts" } });
		expect(watch({ type: "tool_execution_end", toolName: "edit", toolCallId: "1", isError: true })).toBeUndefined();
		watch({ type: "tool_execution_start", toolName: "read", toolCallId: "2", args: { path: "a.ts" } });
		expect(watch({ type: "tool_execution_end", toolName: "read", toolCallId: "2" })).toBeUndefined();
		expect(watch({ type: "tool_execution_end", toolName: "edit", toolCallId: "3" })).toBeUndefined();
	});
});
