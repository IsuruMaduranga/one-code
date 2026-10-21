import { describe, expect, it } from "vitest";
import { filesSeenOnBranch, keptReadPaths, keptShellReadPaths } from "../../extensions/file-tracker/replay.ts";
import { makeRecord, type PendingRecordData, RECORD } from "../../extensions/lib/ledger/records.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (...blocks: unknown[]) => ({ type: "message", message: { role: "assistant", content: blocks } });
const textResult = (toolCallId: string, text: string) => ({ type: "message", message: { role: "toolResult", toolCallId, content: [{ type: "text", text }] } });
const seen = (path: string, sha256 = "h1") => ({ path, size: 1, mtimeMs: 7, sha256 });
/** A result that recorded what it saw of `path` (none when `path` is undefined). */
const result = (toolCallId: string, path: string | undefined, { isError = false, sha256 = "h1" } = {}) => ({
	type: "message",
	message: { role: "toolResult", toolCallId, isError, ...(path ? { details: { oneCodeFile: seen(path, sha256) } } : {}) },
});
const pending = (fields: Partial<PendingRecordData>) => ({ type: "custom", id: `p${Math.random()}`, customType: RECORD.pending, data: makeRecord("pending", "test", { id: "x", text: "t", ...fields }) });
const compaction = { type: "compaction", id: "c" };

describe("filesSeenOnBranch", () => {
	it("keys each file on the absolute path its result recorded, never the call's own spelling, and skips results that recorded nothing", () => {
		const entries = [
			assistant(call("1", "read", { path: "a.ts" }), call("2", "edit", { path: "b.ts" }), call("3", "read", { path: "c.ts" }), call("4", "read", { path: "d.ts" })),
			result("1", "/wt/a.ts"),
			result("2", "/w/b.ts"),
			result("3", undefined),
			result("4", "/w/d.ts", { isError: true }),
		];
		const files = filesSeenOnBranch(entries);
		expect([...files.keys()]).toEqual(["/wt/a.ts", "/w/b.ts"]);
		expect(files.get("/wt/a.ts")?.seen).toEqual(seen("/wt/a.ts"));
	});

	it("keeps only reads from the kept turns, and counts a restore only after the latest compaction", () => {
		const entries = [
			assistant(call("1", "read", { path: "/w/kept-read" }), call("2", "edit", { path: "/w/kept-edit" })),
			result("1", "/w/kept-read"),
			result("2", "/w/kept-edit"),
			pending({ observations: [seen("/w/old-restore")] }),
			compaction,
			pending({ observations: [seen("/w/restored")] }),
			assistant(call("3", "write", { path: "/w/new" })),
			result("3", "/w/new"),
		];
		expect([...filesSeenOnBranch(entries).keys()]).toEqual(["/w/kept-read", "/w/restored", "/w/new"]);
	});

	it("takes a kept edit or write as the latest version of a file a kept read showed", () => {
		const entries = [
			assistant(call("1", "read", { path: "/w/a" }), call("2", "edit", { path: "/w/a" }), call("3", "write", { path: "/w/a" })),
			result("1", "/w/a", { sha256: "h1" }),
			result("2", "/w/a", { sha256: "h2" }),
			result("3", "/w/a", { sha256: "h3" }),
			compaction,
		];
		expect(filesSeenOnBranch(entries).get("/w/a")?.seen).toEqual(seen("/w/a", "h3"));
	});

	it("collects the versions a notice named after the file's last observation", () => {
		const entries = [
			assistant(call("1", "read", { path: "/w/a" })),
			result("1", "/w/a"),
			pending({ notified: [{ path: "/w/a", sha256: "h2" }, { path: "/w/never-read", sha256: "h9" }] }),
			pending({ notified: [{ path: "/w/a", sha256: "h3" }] }),
		];
		expect(filesSeenOnBranch(entries).get("/w/a")?.notified).toEqual(new Set(["h2", "h3"]));
		// A later read starts over: what the notices named is older than what the model saw.
		const reread = filesSeenOnBranch([...entries, assistant(call("2", "read", { path: "/w/a" })), result("2", "/w/a", { sha256: "h3" })]);
		expect(reread.get("/w/a")).toEqual({ seen: seen("/w/a", "h3"), notified: new Set() });
	});
});

describe("keptReadPaths", () => {
	it("lists the files a successful read in the kept turns returned, by the absolute path its result recorded", () => {
		const kept = [
			assistant(call("1", "read", { path: "a.ts" }), call("2", "read", { path: "b.ts" }), call("3", "edit", { path: "c.ts" }), call("4", "read", { file_path: "d.ts" })),
			result("1", "/wt/a.ts"),
			result("2", "/w/b.ts", { isError: true }),
			result("3", "/w/c.ts"),
			result("4", "/w/d.ts"),
		];
		expect(keptReadPaths(kept)).toEqual(["/wt/a.ts", "/w/d.ts"]);
	});
});

describe("keptShellReadPaths", () => {
	const SEEN = "the content the model saw\nline two\n";
	const seen = (path: string) => (path === "/w/a.txt" ? SEEN : undefined);
	// What each call certified as it ran, by call id.
	const pathsOf = (id: string) => (id === "1" ? ["/w/a.txt"] : undefined);

	it("names a tracked file a kept bash call showed in full, as the tracker last saw it", () => {
		const kept = [assistant(call("1", "bash", { command: "cat a.txt" })), textResult("1", SEEN.trimEnd())];
		expect(keptShellReadPaths(kept, pathsOf, seen)).toEqual(["/w/a.txt"]);
	});

	// Re-parsing the command at compaction resolved it from today's directory
	// (after entering a worktree, a different file): only the record decides.
	it("names nothing for a kept call that certified no read when it ran", () => {
		const kept = [assistant(call("2", "bash", { command: "cat a.txt" })), textResult("2", SEEN.trimEnd())];
		expect(keptShellReadPaths(kept, pathsOf, seen)).toEqual([]);
	});

	it("names nothing for a partial output, a call without its result, or an untracked file", () => {
		expect(keptShellReadPaths([assistant(call("1", "bash", { command: "head -1 a.txt" })), textResult("1", "the content the model saw")], pathsOf, seen)).toEqual([]);
		expect(keptShellReadPaths([assistant(call("1", "bash", { command: "cat a.txt" }))], pathsOf, seen)).toEqual([]);
		expect(keptShellReadPaths([textResult("1", SEEN)], pathsOf, seen)).toEqual([]);
		expect(keptShellReadPaths([assistant(call("1", "bash", { command: "cat a.txt" })), textResult("1", SEEN)], pathsOf, () => undefined)).toEqual([]);
	});
});

