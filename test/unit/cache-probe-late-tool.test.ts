import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATE_TOOL_HINT, LATE_TOOL_NAME } from "../e2e/late-tool-fixture.ts";

const ADDENDUM_HEAD = "Additional deferred tools became available via tool_search since this conversation started.";
const asJsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const usage = (cacheRead: number, cacheWrite: number) => ({ input: 10, output: 5, cacheRead, cacheWrite });
const reply = (u: object) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: u, content: [{ type: "toolCall", name: LATE_TOOL_NAME }] } });

/** Two session requests: the second carries the late tool, announced by `announce`. */
const run = (announce: { addendumLine?: string; toolAddition?: boolean }, hint: string | undefined, dir: string) => {
	const head = { model: "probe-model", system: "system", tools: [{ name: "bash" }] };
	const first = { ...head, messages: [{ role: "user", content: "start" }] };
	const lateTool = { name: LATE_TOOL_NAME, defer_loading: true };
	const messages: unknown[] = [{ role: "user", content: "start" }, { role: "assistant", content: "ok" }];
	if (announce.addendumLine !== undefined) messages.push({ role: "user", content: `${ADDENDUM_HEAD}\n${announce.addendumLine}` });
	if (announce.toolAddition) messages.push({ role: "system", content: [{ type: "tool_addition", tool: { name: LATE_TOOL_NAME } }] });
	const second = { ...head, tools: [...head.tools, lateTool], messages };
	writeFileSync(join(dir, "wire.jsonl"), asJsonl([first, second]));
	writeFileSync(join(dir, "events.jsonl"), asJsonl([reply(usage(0, 100)), reply(usage(100, 0))]));
	const form = announce.toolAddition ? "tool_addition" : "addendum";
	const result = spawnSync(process.execPath, [resolve("test/e2e/cache-probe.mjs"), join(dir, "wire.jsonl"), join(dir, "events.jsonl"), "--late-tool", LATE_TOOL_NAME, "--late-tool-form", form, ...(hint === undefined ? [] : ["--late-tool-hint", hint])], { encoding: "utf8" });
	return { status: result.status, out: result.stdout };
};

describe("cache-probe late-tool hint (synthetic wire)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cache-probe-late-tool-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("passes an addendum line that is the name, a colon, a space and the hint", () => {
		const result = run({ addendumLine: `${LATE_TOOL_NAME}: ${LATE_TOOL_HINT}` }, LATE_TOOL_HINT, dir);
		expect(result.out).toContain("PASS");
		expect(result.status).toBe(0);
	});

	it("fails a bare name line and quotes the line it found", () => {
		const result = run({ addendumLine: LATE_TOOL_NAME }, LATE_TOOL_HINT, dir);
		expect(result.status).toBe(1);
		expect(result.out).toContain(`FAIL  the addendum's line for ${LATE_TOOL_NAME} is "${LATE_TOOL_NAME}", expected "${LATE_TOOL_NAME}: ${LATE_TOOL_HINT}"`);
	});

	it("fails a different hint and quotes the line it found", () => {
		const result = run({ addendumLine: `${LATE_TOOL_NAME}: Some other hint.` }, LATE_TOOL_HINT, dir);
		expect(result.status).toBe(1);
		expect(result.out).toContain(`is "${LATE_TOOL_NAME}: Some other hint."`);
	});

	it("checks no line when no hint is given, as before", () => {
		const result = run({ addendumLine: LATE_TOOL_NAME }, undefined, dir);
		expect(result.status).toBe(0);
	});

	it("does not look for a listing line in the tool_addition form", () => {
		const result = run({ toolAddition: true }, LATE_TOOL_HINT, dir);
		expect(result.out).toContain("announced by tool_addition");
		expect(result.status).toBe(0);
	});
});
