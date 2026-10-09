import { describe, expect, it, vi } from "vitest";
import { ruleMatches } from "../../extensions/lib/claude-rules.ts";

// Setup imports path helpers too; reload them with the same native Windows semantics.
vi.hoisted(() => vi.resetModules());
// Exercise native Windows path semantics without pretending C:\\ exists on the host.
vi.mock("node:path", async (load) => {
	const actual = await load<typeof import("node:path")>();
	return { ...actual.win32, default: actual.win32 };
});

describe("path-conditional rules with native Windows paths", () => {
	it("matches forward-slashed globs against drive and UNC candidates", () => {
		expect(ruleMatches(["src/**/*.ts"], "C:\\Project\\src\\deep\\file.ts", "C:\\Project")).toBe(true);
		expect(ruleMatches(["src/**/*.ts"], "c:\\project\\src\\deep\\file.ts", "C:\\Project")).toBe(true);
		expect(ruleMatches(["src/**/*.ts"], "\\\\server\\share\\Project\\src\\file.ts", "\\\\server\\share\\Project")).toBe(true);
	});

	it("does not let absolute or parent patterns escape the owner or cross drives", () => {
		for (const globs of [["**"], ["../**"], ["C:/Other/**"], ["D:/**"]]) {
			expect(ruleMatches(globs, "C:\\Other\\file.ts", "C:\\Project")).toBe(false);
			expect(ruleMatches(globs, "D:\\Project\\file.ts", "C:\\Project")).toBe(false);
		}
	});
});
