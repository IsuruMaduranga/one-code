/**
 * The agent view labels a call as the main transcript does: for every tool
 * registered with `name: "x"` and `...ccToolRenderers("Label")`, the agent
 * view's `toolDisplayLabel("x")` must be that label.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolDisplayLabel } from "../../extensions/subagents/panel-render.ts";

const EXTENSIONS = join(import.meta.dirname, "../../extensions");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

// A `name:` line, at most two lines, then the renderer's label.
const REGISTRATION = /name: "([a-z_]+)",\n(?:[^\n]*\n){0,2}?\s*\.\.\.ccToolRenderers\("([^"]+)"/g;

describe("agent view tool labels", () => {
	const pairs = sources(EXTENSIONS).flatMap((file) => [...readFileSync(file, "utf8").replace(/\r\n/g, "\n").matchAll(REGISTRATION)].map((m) => ({ name: m[1], label: m[2] })));

	it("finds the registrations it checks", () => {
		expect(pairs.length).toBeGreaterThan(15);
		expect(pairs).toContainEqual({ name: "task_stop", label: "Stop Task" });
	});

	it.each(pairs)("labels $name as $label", ({ name, label }) => {
		expect(toolDisplayLabel(name)).toBe(label);
	});
});
