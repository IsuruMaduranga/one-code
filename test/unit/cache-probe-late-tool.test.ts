import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapReminder } from "../../extensions/lib/request/reminders.ts";
import { toolSearchResultText } from "../../extensions/lib/request/tool-search-text.ts";
import { LATE_TOOL_HINT, LATE_TOOL_NAME } from "../e2e/late-tool-fixture.ts";

const ADDENDUM_HEAD = toolSearchResultText.addendumHead;
const asJsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const usage = (cacheRead: number, cacheWrite: number) => ({ input: 10, output: 5, cacheRead, cacheWrite });
const reply = (u: object) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: u, content: [{ type: "toolCall", name: LATE_TOOL_NAME }] } });

/**
 * Where the addendum sits: a user message's string content, a text block, or
 * (as on the real wire) a bash tool result after the command's output and
 * another reminder, its content a string or an array of text blocks.
 */
type Placement = "message" | "text-block" | "tool-result-string" | "tool-result-array";

/** The user message that carries `addendum` at `placement`. */
const addendumMessage = (addendum: string, placement: Placement) => {
	if (placement === "message") return { role: "user", content: addendum };
	if (placement === "text-block") return { role: "user", content: [{ type: "text", text: addendum }] };
	const output = `before-late\n\n${wrapReminder("<total_tokens>1000 tokens left</total_tokens>")}\n${wrapReminder(addendum)}`;
	const content = placement === "tool-result-string" ? output : [{ type: "text", text: output }];
	return { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content, is_error: false, cache_control: { type: "ephemeral" } }] };
};

/** Two session requests: the second carries the late tool, announced by `announce`. */
const run = (announce: { addendumLine?: string; toolAddition?: boolean; placement?: Placement }, hint: string | undefined, dir: string) => {
	const head = { model: "probe-model", system: "system", tools: [{ name: "bash" }] };
	const first = { ...head, messages: [{ role: "user", content: "start" }] };
	const lateTool = { name: LATE_TOOL_NAME, defer_loading: true };
	const messages: unknown[] = [
		{ role: "user", content: "start" },
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "echo before-late && sleep 1" } }] },
	];
	if (announce.addendumLine !== undefined) messages.push(addendumMessage(`${ADDENDUM_HEAD}\n${announce.addendumLine}`, announce.placement ?? "message"));
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

	for (const placement of ["text-block", "tool-result-string", "tool-result-array"] as const) {
		it(`passes the hint line in a ${placement}`, () => {
			const result = run({ addendumLine: `${LATE_TOOL_NAME}: ${LATE_TOOL_HINT}`, placement }, LATE_TOOL_HINT, dir);
			expect(result.out).toContain("announced by addendum");
			expect(result.out).toContain("PASS");
			expect(result.status).toBe(0);
		});

		it(`fails a different hint in a ${placement} and quotes the line it found`, () => {
			const result = run({ addendumLine: `${LATE_TOOL_NAME}: Some other hint.`, placement }, LATE_TOOL_HINT, dir);
			expect(result.status).toBe(1);
			expect(result.out).toContain(`is "${LATE_TOOL_NAME}: Some other hint."`);
		});
	}

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
