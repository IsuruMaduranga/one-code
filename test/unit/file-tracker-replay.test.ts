import { describe, expect, it } from "vitest";
import { keptShellReadPaths, pathsReadOnBranch } from "../../extensions/file-tracker/replay.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (...blocks: unknown[]) => ({ type: "message", message: { role: "assistant", content: blocks } });
const result = (toolCallId: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId, isError } });
const textResult = (toolCallId: string, text: string) => ({ type: "message", message: { role: "toolResult", toolCallId, content: [{ type: "text", text }] } });

describe("keptShellReadPaths", () => {
	const SEEN = "the content the model saw\nline two\n";
	const seen = (path: string) => (path === "/w/a.txt" ? SEEN : undefined);
	const pathsOf = (command: string) => (command.includes("a.txt") ? ["/w/a.txt"] : []);

	it("names a tracked file a kept bash call showed in full, as the tracker last saw it", () => {
		const kept = [assistant(call("1", "bash", { command: "cat a.txt" })), textResult("1", SEEN.trimEnd())];
		expect(keptShellReadPaths(kept, pathsOf, seen)).toEqual(["/w/a.txt"]);
	});

	it("names nothing for a partial output, a call without its result, or an untracked file", () => {
		expect(keptShellReadPaths([assistant(call("1", "bash", { command: "head -1 a.txt" })), textResult("1", "the content the model saw")], pathsOf, seen)).toEqual([]);
		expect(keptShellReadPaths([assistant(call("1", "bash", { command: "cat a.txt" }))], pathsOf, seen)).toEqual([]);
		expect(keptShellReadPaths([textResult("1", SEEN)], pathsOf, seen)).toEqual([]);
		expect(keptShellReadPaths([assistant(call("1", "bash", { command: "cat a.txt" })), textResult("1", SEEN)], pathsOf, () => undefined)).toEqual([]);
	});
});

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
