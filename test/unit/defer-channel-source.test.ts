/**
 * A base module defers its own tools through `deferBaseTool`
 * (lib/request/deferred-channel.ts), whose name parameter is typed against
 * `DEFERRABLE_TOOLS`, the list a profile's listing hints are keyed by. A module
 * that emitted on `DEFER_CHANNEL` itself would skip that type, so a base tool
 * could be deferred without being on the list (and without a hint). A tool the
 * base does not list (an MCP server's, one the parent deferred for a child)
 * goes through `deferTool`. Products keep the raw channel through the SDK.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./helpers/import-graph.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const HELPERS = "extensions/lib/request/deferred-channel.ts";

/** The `emit(DEFER_CHANNEL, …)` calls in `source`. */
function rawDeferEmits(source: string, path: string): number {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	let found = 0;
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "emit") {
			const channel = node.arguments[0];
			if (channel && ts.isIdentifier(channel) && channel.text === "DEFER_CHANNEL") found++;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

describe("the deferral channel", () => {
	const modules = sourceFiles(join(ROOT, "extensions"), ROOT).filter((file) => !file.includes("/test/"));

	it("finds the raw emit in the helper module (the scan works)", () => {
		expect(rawDeferEmits(readFileSync(join(ROOT, HELPERS), "utf8"), HELPERS)).toBe(2);
	});

	it("is emitted on by no base module but the helpers, so every deferred base tool name is typed", () => {
		const direct = modules.filter((file) => file !== HELPERS && rawDeferEmits(readFileSync(join(ROOT, file), "utf8"), file) > 0);
		expect(direct, "defer a base tool with deferBaseTool(pi.events, name, keywords), any other tool with deferTool(pi.events, request) (lib/request/deferred-channel.ts)").toEqual([]);
	});
});
