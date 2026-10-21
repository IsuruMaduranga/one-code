/**
 * Children load the core in the package's own order (CLAUDE.md "Architecture":
 * the extension order is load-bearing), compaction and context-management
 * included (lifecycle-grid-hunt round 3, R3-M24, R3-M25).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHILD_EXTENSIONS } from "../../extensions/lib/child-extensions.ts";

const packageOrder = (JSON.parse(readFileSync("package.json", "utf8")) as { pi: { extensions: string[] } }).pi.extensions.map((path) =>
	path.replace(/^extensions\//, "").replace(/\/index\.ts$/, "").replace(/\.ts$/, ""),
);

describe("the child extension list", () => {
	it("loads compaction and context-management, as the main session does", () => {
		expect(CHILD_EXTENSIONS).toContain("compaction");
		expect(CHILD_EXTENSIONS).toContain("context-management");
	});

	it("keeps the main session's relative order for the request path's core", () => {
		const core = ["kept-thinking", "ledger", "system-reminder", "tool-search", "context-management", "compaction", "ledger/wire", "cache-marks"];
		const ascending = (positions: number[]) => positions.every((position, i) => position !== -1 && (i === 0 || position > positions[i - 1]));
		expect(ascending(core.map((name) => CHILD_EXTENSIONS.indexOf(name)))).toBe(true);
		expect(ascending(core.map((name) => packageOrder.indexOf(name)))).toBe(true);
	});
});
