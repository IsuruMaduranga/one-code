import { describe, expect, it } from "vitest";
import { pathsReadOnBranch } from "../../extensions/file-tracker/replay.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (...blocks: unknown[]) => ({ type: "message", message: { role: "assistant", content: blocks } });
const result = (toolCallId: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId, isError } });

describe("pathsReadOnBranch (T9)", () => {
	it("collects paths of successful reads and writes, in order, once", () => {
		const entries = [
			assistant(call("1", "read", { path: "a.ts" }), call("2", "bash", { command: "ls" })),
			result("1"),
			result("2"),
			assistant(call("3", "edit", { path: "b.ts", oldText: "x", newText: "y" })),
			result("3"),
			assistant(call("4", "read", { path: "a.ts" })),
			result("4"),
		];
		expect(pathsReadOnBranch(entries)).toEqual(["a.ts", "b.ts"]);
	});

	it("ignores failed results, unknown ids, and non-message entries", () => {
		const entries = [
			{ type: "custom", customType: "x" },
			assistant(call("1", "read", { path: "gone.ts" })),
			result("1", true),
			result("nope"),
		];
		expect(pathsReadOnBranch(entries)).toEqual([]);
	});
});
