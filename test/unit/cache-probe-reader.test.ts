import { describe, expect, it } from "vitest";
// @ts-expect-error The standalone E2E checker is intentionally plain JavaScript.
import { checkReaderProbe, READER_PROBE_LONG_URL, READER_PROBE_QUESTION, READER_PROBE_SHORT_URL } from "../e2e/cache-probe-reader.mjs";

const row = (overrides: Record<string, unknown> = {}) => ({
	kind: "reader",
	model: "anthropic/claude-haiku-4-5",
	api: "anthropic-messages",
	sessionId: "probe-session:reader",
	system: "Answer from the supplied page only.",
	messages: [{ role: "user", content: "<page>same page bytes</page>\nQuestion: same question", timestamp: 1 }],
	usage: { input: 5000, cacheRead: 0, cacheWrite: 5000 },
	stopReason: "stop",
	...overrides,
});

const events = (url = READER_PROBE_LONG_URL) => [
	{ type: "tool_execution_start", toolName: "web_fetch", toolCallId: "one", args: { url, prompt: READER_PROBE_QUESTION } },
	{ type: "tool_execution_end", toolName: "web_fetch", toolCallId: "one", result: { isError: false } },
	{ type: "tool_execution_start", toolName: "web_fetch", toolCallId: "two", args: { url, prompt: READER_PROBE_QUESTION } },
	{ type: "tool_execution_end", toolName: "web_fetch", toolCallId: "two", result: { isError: false } },
	{ type: "message_end", message: { role: "assistant", stopReason: "stop" } },
];

describe("cache-probe-reader", () => {
	it("passes an explicit Anthropic warm read with stable key and bytes", () => {
		const result = checkReaderProbe(
			[row(), row({ usage: { input: 1, cacheRead: 5000, cacheWrite: 0 }, messages: [{ role: "user", content: "<page>same page bytes</page>\nQuestion: same question", timestamp: 2 }] })],
			events(),
		);
		expect(result.status).toBe("pass");
		expect(result.failures).toEqual([]);
	});

	it("fails a cache miss instead of downgrading it to a warning", () => {
		const result = checkReaderProbe([row(), row({ usage: { input: 5000, cacheRead: 4999, cacheWrite: 0 } })], events());
		expect(result.status).toBe("fail");
		expect(result.failures.join("\n")).toMatch(/read 4999 cached tokens/);
	});

	it("fails changed reader input even though timestamps differ", () => {
		const result = checkReaderProbe(
			[row(), row({ usage: { input: 1, cacheRead: 5000, cacheWrite: 0 }, messages: [{ role: "user", content: "changed page", timestamp: 999 }] })],
			events(),
		);
		expect(result.status).toBe("fail");
		expect(result.failures).toContain("reader user message changed between calls (first difference at char 0)");
	});

	it("uses the implicit total minus one block floor and warns below it", () => {
		const first = row({ api: "openai-responses", model: "openai/gpt-6.1-mini", usage: { input: 2400, cacheRead: 0, cacheWrite: 0 } });
		const pass = checkReaderProbe([first, row({ api: "openai-responses", model: "openai/gpt-6.1-mini", usage: { input: 1, cacheRead: 2144, cacheWrite: 0 } })], events());
		expect(pass.status).toBe("pass");
		const partial = checkReaderProbe([first, row({ api: "openai-responses", model: "openai/gpt-6.1-mini", usage: { input: 1, cacheRead: 2143, cacheWrite: 0 } })], events());
		expect(partial.status).toBe("pass");
		expect(partial.lines.join("\n")).toMatch(/WARN  reader call 2 read 2143/);
	});

	it("skips the deliberate short fixture only below the known minimum", () => {
		const short = row({ usage: { input: 300, cacheRead: 0, cacheWrite: 0 } });
		const result = checkReaderProbe([short, row({ usage: { input: 300, cacheRead: 0, cacheWrite: 0 } })], events(READER_PROBE_SHORT_URL), { short: true });
		expect(result.status).toBe("skip");
		expect(result.lines.join("\n")).toMatch(/known 4096-token/);
	});

	it.each(["anthropic/claude-haiku-4-5", "gateway/anthropic/claude-haiku-4-5"])("uses Anthropic's higher Haiku minimum for %s", (model) => {
		const haiku = row({ model, usage: { input: 3000, cacheRead: 0, cacheWrite: 0 } });
		const result = checkReaderProbe([haiku, haiku], events(READER_PROBE_SHORT_URL), { short: true });
		expect(result.status).toBe("skip");
		expect(result.lines.join("\n")).toMatch(/4096-token cache minimum/);
	});

	it("fails when the outer run did not complete two sequential web_fetch calls", () => {
		const outOfOrder = [events()[0], events()[2], events()[1], events()[3]];
		const result = checkReaderProbe([row(), row({ usage: { input: 1, cacheRead: 2300, cacheWrite: 0 } })], outOfOrder);
		expect(result.status).toBe("fail");
		expect(result.failures).toContain("the second web_fetch started before the first completed");
	});

	it.each([
		{ stopReason: "error" },
		{ stopReason: "aborted" },
		{ usage: {} },
		{ usage: { input: 0, cacheRead: -1, cacheWrite: 0 } },
		{ sessionId: "different:reader" },
		{ sessionId: undefined },
		{ system: "changed system" },
		{ model: "anthropic/another-model" },
	])("fails incomplete or inconsistent reader evidence: %j", (changes) => {
		expect(checkReaderProbe([row(), row(changes)], events()).status).toBe("fail");
	});

	it("fails missing calls, provider errors, and impossible event order", () => {
		expect(checkReaderProbe([], events()).status).toBe("fail");
		const readerRows = [row(), row({ usage: { input: 1, cacheRead: 2300, cacheWrite: 0 } })];
		expect(checkReaderProbe(readerRows, []).status).toBe("fail");
		expect(checkReaderProbe(readerRows, [events()[1], events()[0], ...events().slice(2)]).status).toBe("fail");
		const failed = events();
		failed[1].result = { isError: true };
		expect(checkReaderProbe(readerRows, failed).status).toBe("fail");
	});

	it("never passes an explicit cache check without a positive first cache write or read", () => {
		const uncached = row({ usage: { input: 5000, cacheRead: 0, cacheWrite: 0 } });
		expect(checkReaderProbe([uncached, uncached], events()).status).toBe("fail");
	});

	it("labels unsupported API accounting as a skip, never as a pass", () => {
		const result = checkReaderProbe(
			[row({ api: "future-api", usage: { input: 2300, cacheRead: 0, cacheWrite: 2300 } }), row({ api: "future-api", usage: { input: 1, cacheRead: 2300, cacheWrite: 0 } })],
			events(),
		);
		expect(result.status).toBe("skip");
		expect(result.lines.join("\n")).toMatch(/not a cache PASS/);
	});
});
