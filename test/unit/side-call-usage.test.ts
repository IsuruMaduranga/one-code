import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logSideCallUsage } from "../../extensions/lib/side-call-usage.ts";

vi.mock("node:fs", () => ({ appendFileSync: vi.fn() }));
const append = vi.mocked(appendFileSync);
const call = {
	kind: "reader" as const,
	model: { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" },
	sessionId: "session:reader",
	system: "Exact system\nbytes 😀",
	messages: [{ role: "user", content: "page\n\nquestion", timestamp: 1 }],
};
const reply = { usage: { input: 10, cacheRead: 2048, cacheWrite: 0 }, stopReason: "stop", content: [{ type: "text", text: "Private response" }] };

beforeEach(() => { append.mockReset(); vi.stubEnv("CC_SIDE_CALL_LOG", ""); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("side-call usage log", () => {
	it("does nothing without explicit opt-in", () => {
		logSideCallUsage(call, reply);
		expect(append).not.toHaveBeenCalled();
	});

	it("writes one JSON line per reply, with exact prompt text and normalized usage", () => {
		vi.stubEnv("CC_SIDE_CALL_LOG", "probe.jsonl");
		const before = structuredClone({ call, reply });
		logSideCallUsage(call, reply);
		logSideCallUsage({ ...call, kind: "btw", sessionId: "session:btw" }, { ...reply, stopReason: "error" });
		expect(append).toHaveBeenCalledTimes(2);
		const [path, line] = append.mock.calls[0];
		expect(path).toBe("probe.jsonl");
		expect(String(line).split("\n")).toHaveLength(2);
		expect(JSON.parse(String(line))).toEqual({ ...call, model: "anthropic/claude-haiku-4-5", api: "anthropic-messages", usage: reply.usage, stopReason: "stop" });
		expect(JSON.parse(String(append.mock.calls[1][1])).stopReason).toBe("error");
		expect(String(line)).not.toContain("Private response");
		expect({ call, reply }).toEqual(before);
	});

	it("never serializes credentials from a model or reply", () => {
		vi.stubEnv("CC_SIDE_CALL_LOG", "probe.jsonl");
		const credentialedModel = { ...call.model, headers: { authorization: "secret-header" }, apiKey: "secret-key" };
		logSideCallUsage({ ...call, model: credentialedModel }, reply);
		expect(String(append.mock.calls[0][1])).not.toContain("secret-");
	});

	it("does not change a side call's outcome when writing or serialization fails", () => {
		vi.stubEnv("CC_SIDE_CALL_LOG", "probe.jsonl");
		append.mockImplementation(() => { throw new Error("read-only filesystem"); });
		expect(() => logSideCallUsage(call, reply)).not.toThrow();
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expect(() => logSideCallUsage({ ...call, messages: cyclic }, reply)).not.toThrow();
	});
});
