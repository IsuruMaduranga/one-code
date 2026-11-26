/**
 * The cache probe's read checks on synthetic runs: an errored request (the
 * provider's overload event, retried by pi-ai) is not a miss and its retry is
 * held to the last answered request, and the fork phase also checks the
 * parent's own next request after the fork.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const asJsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const node = (script: string, args: string[]) => {
	const result = spawnSync(process.execPath, [resolve(script), ...args], { encoding: "utf8" });
	return { status: result.status, out: result.stdout };
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cache-probe-read-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("cache-probe session read check with errored requests", () => {
	const head = { model: "probe-model", system: "system", tools: [{ name: "bash" }] };
	const turn = (n: number) => [
		{ role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "bash", input: { command: `echo ${n}` } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: String(n) }] },
	];
	const first = [{ role: "user", content: "start" }];
	const second = [...first, ...turn(1)];
	const third = [...second, ...turn(2)];
	// Requests 2 and 4 error and are sent again as 3 and 5 (implicit caching: no writes).
	const wire = [first, second, second, third, third].map((messages) => ({ ...head, messages }));
	const answered = (input: number, cacheRead: number) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input, output: 5, cacheRead, cacheWrite: 0 } } });
	const errored = { type: "message_end", message: { role: "assistant", stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
	const probe = (events: unknown[]) => {
		writeFileSync(join(dir, "wire.jsonl"), asJsonl(wire));
		writeFileSync(join(dir, "events.jsonl"), asJsonl(events));
		return node("test/e2e/cache-probe.mjs", [join(dir, "wire.jsonl"), join(dir, "events.jsonl")]);
	};

	it("passes when each retry reads what the last answered request sent", () => {
		const result = probe([answered(18753, 0), errored, answered(242, 18688), errored, answered(162, 18816)]);
		expect(result.out).toContain("2 errored requests left out of the head and read checks");
		expect(result.out).not.toContain("FAIL");
		expect(result.status).toBe(0);
	});

	it("fails a retry that misses, naming the answered request it should have read", () => {
		const result = probe([answered(18753, 0), errored, answered(18930, 0), errored, answered(162, 18816)]);
		expect(result.out).toContain("request 3 read 0 cached tokens");
		expect(result.out).toContain("of what request 1 sent");
		expect(result.status).toBe(1);
	});
});

describe("cache-probe fork check", () => {
	const usage = (input: number, cacheRead: number) => ({ input, output: 5, cacheRead, cacheWrite: 0 });
	const entry = (at: number, message: object) => ({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", ...message } });
	const spawn = entry(1000, { stopReason: "toolUse", usage: usage(18700, 0), content: [{ type: "toolCall", name: "Agent" }] });
	const probe = (parentAfter: object[], forkRead = 18688, forkBefore: object[] = []) => {
		const sessions = join(dir, "sessions");
		const task = join(sessions, "session-1", "subagents", "task-1");
		mkdirSync(task, { recursive: true });
		writeFileSync(join(sessions, "main.jsonl"), asJsonl([spawn, ...parentAfter]));
		writeFileSync(join(task, "fork.jsonl"), asJsonl([spawn, ...forkBefore, entry(2000, { stopReason: "stop", usage: usage(300, forkRead), content: [] })]));
		return node("test/e2e/cache-probe-fork.mjs", [sessions, "--model", "openai-codex/probe-model"]);
	};

	it("passes when the fork and the parent's next request both read the parent's prompt", () => {
		const result = probe([entry(3000, { stopReason: "stop", usage: usage(400, 18688), content: [] })]);
		expect(result.out).toContain("PASS  fork: the fork's first request read 18688");
		expect(result.out).toContain("PASS  fork: the parent's next request after the fork read 18688");
		expect(result.status).toBe(0);
	});

	it("fails when the parent's next request misses although the fork read", () => {
		const result = probe([entry(3000, { stopReason: "stop", usage: usage(13300, 5760), content: [] })]);
		expect(result.out).toContain("PASS  fork: the fork's first request");
		expect(result.out).toContain("FAIL  fork: the parent's next request after the fork read 5760");
		expect(result.status).toBe(1);
	});

	it("skips an errored parent reply and checks its retry", () => {
		const result = probe([
			entry(3000, { stopReason: "error", usage: usage(0, 0), content: [] }),
			entry(3500, { stopReason: "stop", usage: usage(400, 18688), content: [] }),
		]);
		expect(result.out).toContain("PASS  fork: the parent's next request after the fork read 18688");
		expect(result.status).toBe(0);
	});

	it("skips an errored first reply of the fork and checks its retry", () => {
		const result = probe([entry(3000, { stopReason: "stop", usage: usage(400, 18688), content: [] })], 18688, [entry(1500, { stopReason: "error", usage: usage(0, 0), content: [] })]);
		expect(result.out).toContain("PASS  fork: the fork's first request read 18688");
		expect(result.status).toBe(0);
	});

	it("fails when the parent sends nothing after the fork", () => {
		const result = probe([]);
		expect(result.out).toContain("FAIL  fork: the parent sent no answered request after the fork");
		expect(result.status).toBe(1);
	});
});
