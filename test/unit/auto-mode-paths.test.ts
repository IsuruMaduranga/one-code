import { describe, expect, it } from "vitest";
import { pathArgument } from "../../extensions/auto-mode/paths.ts";

/**
 * pathArgument is the single place that knows which input field carries a file
 * tool's target path — it feeds the read-before-write guard, the permission-rule
 * subject, the auto-mode classifier transcript, and worktree redirection. It
 * must recognise Claude Code's field names, including `notebook_path`, or a
 * CC-shaped notebook_edit slips past every path-based gate (code-review).
 */
describe("pathArgument recognises every path field name", () => {
	it("reads pi's `path`", () => {
		expect(pathArgument({ path: "src/a.ts" })).toBe("src/a.ts");
	});

	it("reads Claude Code's `file_path`", () => {
		expect(pathArgument({ file_path: "src/b.ts" })).toBe("src/b.ts");
	});

	it("reads notebook_edit's `notebook_path`", () => {
		expect(pathArgument({ notebook_path: "nb.ipynb" })).toBe("nb.ipynb");
	});

	it("prefers `path` when several are present", () => {
		expect(pathArgument({ path: "p", file_path: "f", notebook_path: "n" })).toBe("p");
	});

	it("returns undefined when no path field is set or it is not a string", () => {
		expect(pathArgument({})).toBeUndefined();
		expect(pathArgument(undefined)).toBeUndefined();
		expect(pathArgument({ notebook_path: 42 })).toBeUndefined();
	});
});
