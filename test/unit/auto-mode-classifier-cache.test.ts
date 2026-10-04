import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { classify, createClassifierState } from "../../extensions/auto-mode/classifier.ts";
import { loadAutoModeConfig } from "../../extensions/auto-mode/config.ts";
import { buildPayload, type ClassifyRequest, stage1User, stage2User, reviewUser } from "../../extensions/auto-mode/prompt.ts";
import { cacheClassifierHistory } from "../../extensions/auto-mode/cache.ts";
import { claudeMdFraming } from "../../extensions/auto-mode/classifier-prompt.ts";
import { transcriptBlocks, type TranscriptEntry } from "../../extensions/auto-mode/transcript.ts";
import { RESOLVED_PATHS_NOTE } from "../../extensions/auto-mode/resolved-paths-meta.ts";

const config = loadAutoModeConfig("/nonexistent-home-for-tests");
const request: ClassifyRequest = {
	toolName: "bash",
	transcript: [
		{ kind: "user", text: "Check the public sites." },
		{ kind: "tool", tool: "bash", input: { command: "curl -sI https://example.com" } },
	],
	userMessages: ["Check the public sites."],
	claudeMd: "# Instructions\nKeep secrets local.",
	username: "tester",
	environment: config.environment,
};
const cacheControl = { type: "ephemeral", ttl: "1h" };
type Block = { type: string; text: string; cache_control?: typeof cacheControl };
type Payload = { system: Block[]; messages: { role: string; content: Block[] }[] };
const payloads: Payload[] = [];
let replies: string[];
const model = { provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages", contextWindow: 1_000_000 } as Model<Api>;
function deps(selected = model) {
	return {
		registry: {
			getAvailable: () => [selected],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		} as unknown as ModelRegistry,
		sessionModel: selected,
		config,
		state: createClassifierState(),
	};
}

beforeEach(() => {
	payloads.length = 0;
	replies = ["<severity>5</severity>"];
	vi.mocked(completeSimple).mockReset().mockImplementation(async (_model, context, options) => {
		const payload: Payload = {
			system: [{ type: "text", text: context.systemPrompt!, cache_control: cacheControl }],
			messages: [{ role: "user", content: [{ type: "text", text: context.messages[0].content as string, cache_control: cacheControl }] }],
		};
		await options?.onPayload?.(payload, _model);
		payloads.push(payload);
		return { stopReason: "stop", content: [{ type: "text", text: replies.shift() ?? "<severity>5</severity>" }], usage: {} } as AssistantMessage;
	});
});

const blocks = (payload: Payload) => payload.messages[0].content;
const text = (payload: Payload) => blocks(payload).map((block) => block.text).join("");
const cachedPrefix = (payload: Payload) => {
	const content = blocks(payload);
	const last = content.findLastIndex((block) => block.cache_control);
	return content.slice(0, last + 1).map((block) => block.text).join("");
};

describe("classifier transcript cache", () => {
	it("caches stable history rather than the action or stage instruction", async () => {
		await classify(request, deps());
		const payload = payloads[0];
		expect(text(payload)).toBe(stage1User(buildPayload(request).userPrefix));
		expect(blocks(payload).length).toBeGreaterThan(1);
		expect(cachedPrefix(payload)).toContain('{"user":"Check the public sites."}');
		expect(cachedPrefix(payload)).not.toContain("curl -sI");
		expect(cachedPrefix(payload)).not.toContain("</transcript>");
		expect(cachedPrefix(payload)).not.toContain("Grade HARM ONLY");
		expect(payload.system[0].cache_control).toEqual(cacheControl);
	});

	it.each([false, true])("preserves both stage texts byte-for-byte (denial=%s)", async (denied) => {
		const current: ClassifyRequest = { ...request, transcript: [
			...request.transcript.slice(0, -1),
			...(denied ? [{ kind: "denied" as const, tool: "bash", subject: "rm file", rule: "Bash(rm:*)" }] : []),
			request.transcript.at(-1)!,
		] };
		replies = ["<severity>90</severity>", "<severity>90</severity><category>Data Exfiltration</category>"];
		expect((await classify(current, deps())).decision).toBe("block");
		const prefix = buildPayload(current).userPrefix;
		expect(payloads).toHaveLength(2);
		expect(text(payloads[0])).toBe(stage1User(prefix));
		expect(text(payloads[1])).toBe(stage2User(prefix, denied));
		expect(cachedPrefix(payloads[1])).toBe(cachedPrefix(payloads[0]));
		expect(blocks(payloads[1]).length).toBeGreaterThan(1);
	});

	it("uses the same cache boundary for the retrospective review", async () => {
		await classify(request, { ...deps(), reviewOnly: true });
		expect(text(payloads[0])).toBe(reviewUser(buildPayload(request).userPrefix));
		expect(cachedPrefix(payloads[0])).not.toContain("RETROSPECTIVE");
		expect(cachedPrefix(payloads[0])).toContain('{"user":"Check the public sites."}');
	});

	it("keeps earlier history at identical block boundaries across calls", async () => {
		const dependencies = deps();
		await classify(request, dependencies);
		await classify({ ...request, transcript: [...request.transcript, { kind: "tool", tool: "bash", input: { command: "curl -sI https://example.org" } }] }, dependencies);
		const first = blocks(payloads[0]);
		const end = first.findLastIndex((block) => block.cache_control);
		expect(end).toBeGreaterThanOrEqual(0);
		expect(blocks(payloads[1]).slice(0, end + 1).map((block) => block.text)).toEqual(first.slice(0, end + 1).map((block) => block.text));
	});

	it("marks the previous write explicitly after more than twenty new history entries", async () => {
		const dependencies = deps();
		await classify(request, dependencies);
		const additions: TranscriptEntry[] = Array.from({ length: 50 }, (_, i) => ({ kind: "tool", tool: "bash", input: { command: `echo ${i}` } }));
		await classify({ ...request, transcript: [...request.transcript, ...additions] }, dependencies);
		const first = blocks(payloads[0]);
		const previousEnd = first.findLastIndex((block) => block.cache_control);
		const second = blocks(payloads[1]);
		expect(second.findLastIndex((block) => block.cache_control) - previousEnd).toBeGreaterThan(20);
		expect(second[previousEnd].cache_control).toEqual(cacheControl);
		expect(second.slice(0, previousEnd + 1)).toEqual(first.slice(0, previousEnd + 1));
		expect(second.filter((block) => block.cache_control)).toHaveLength(2);
	});

	it("retains a matching marked prefix through five sequential gated calls", async () => {
		const dependencies = deps();
		const transcript = [...request.transcript];
		for (let i = 0; i < 5; i++) {
			await classify({ ...request, transcript: [...transcript] }, dependencies);
			if (i > 0) {
				const before = blocks(payloads[i - 1]);
				const end = before.findLastIndex((block) => block.cache_control);
				const after = blocks(payloads[i]);
				expect(after[end].cache_control).toEqual(cacheControl);
				expect(after.slice(0, end + 1).map((block) => block.text)).toEqual(before.slice(0, end + 1).map((block) => block.text));
				expect(cachedPrefix(payloads[i]).length).toBeGreaterThan(cachedPrefix(payloads[i - 1]).length);
			}
			transcript.push({ kind: "tool", tool: "bash", input: { command: `curl -sI https://example.com/${i}` } });
		}
	});

	it("does not reuse old text after compaction or a branch switch", async () => {
		const dependencies = deps();
		await classify(request, dependencies);
		const compacted: ClassifyRequest = { ...request, claudeMd: "New framing", transcript: [
			{ kind: "summary", text: "New active context" }, request.transcript.at(-1)!,
		] };
		await classify(compacted, dependencies);
		expect(text(payloads[1])).toBe(stage1User(buildPayload(compacted).userPrefix));
		expect(text(payloads[1])).not.toContain("Check the public sites.");
		expect(cachedPrefix(payloads[1])).not.toBe(cachedPrefix(payloads[0]));
	});

	it.each(["openai-responses", "openai-completions", "bedrock-converse-stream", "google-generative-ai", "google-vertex"])("leaves %s as a single string without a payload hook", async (api) => {
		await classify(request, deps({ ...model, provider: "openai", id: "gpt-5-mini", api } as Model<Api>));
		const [, context, options] = vi.mocked(completeSimple).mock.calls[0];
		expect(context.messages[0].content).toBe(stage1User(buildPayload(request).userPrefix));
		expect(options?.onPayload).toBeUndefined();
	});
});

const action: TranscriptEntry = { kind: "tool", tool: "read", input: { path: "link/secret", content: "line one\nline two 😀" } };
const resolvedPaths = [{ path: "link/secret", resolvesTo: "/outside/secret" }];
const mixed: TranscriptEntry[] = [
	{ kind: "summary", text: "Earlier context" },
	{ kind: "user", text: "Keep the newline\nand emoji 😀" },
	{ kind: "tool", tool: "read", input: { path: "omit-local-read" } },
	{ kind: "tool", tool: "read", input: { path: "remote", _host: "remote-host" } },
	{ kind: "meta", gitStatus: { clean: true } },
	{ kind: "tool", tool: "bash", input: { command: "echo historical action" } },
	{ kind: "denied", tool: "bash", subject: "rm file", rule: "Bash(rm:*)" },
	{ kind: "meta", gitStatus: { modified: 1, staged: 0, untracked: 0 } },
	{ kind: "resolved-paths", resolvedPaths },
	action,
];
// Independent golden for the pre-change renderer: no production builder supplies these bytes.
const mixedText = '<transcript>\n' + [
	'{"summary":"Earlier context"}',
	'{"user":"Keep the newline\\nand emoji 😀"}',
	'{"Read":{"path":"remote","_host":"remote-host"}}',
	'{"meta":{"gitStatus":{"clean":true}}}',
	'{"Bash":"echo historical action"}',
	'{"denied_by_permission_rule":{"tool":"Bash","attempted":"rm file","rule":"Bash(rm:*)"}}',
	'{"meta":{"gitStatus":{"modified":1,"staged":0,"untracked":0}}}',
	JSON.stringify({ meta: { resolvedPaths, note: RESOLVED_PATHS_NOTE } }),
	'{"Read":{"path":"link/secret","content":"line one\\nline two 😀"}}',
].join("\n") + '\n</transcript>';

describe("classifier text preservation", () => {
	it.each([undefined, "", "# CLAUDE.md\nKeep exact whitespace.\n\n"])("matches the original text with framing %j in every stage", (claudeMd) => {
		const built = buildPayload({ ...request, claudeMd, transcript: mixed });
		const prefix = [claudeMdFraming(claudeMd), mixedText].filter(Boolean).join("\n\n");
		expect(built.userPrefix).toBe(prefix);
		for (const render of [stage1User, (value: string) => stage2User(value), (value: string) => stage2User(value, true), reviewUser]) {
			const expected = render(prefix);
			const parts = [...built.history, built.tail, render(built.userPrefix).slice(built.userPrefix.length)];
			const wire = { messages: [{ role: "user", content: [{ type: "text" as const, text: expected, cache_control: cacheControl }] }] };
			cacheClassifierHistory(wire, parts, built.history.length - 1);
			expect(wire.messages[0].content.map((block) => block.text).join("")).toBe(expected);
			const marked = wire.messages[0].content.filter((block) => block.cache_control);
			expect(marked).toHaveLength(1);
			expect(marked[0].text).toContain("denied_by_permission_rule");
		}
	});

	it("keeps pending git-status and resolved-paths facts with the action, not cached history", () => {
		const { history, tail } = transcriptBlocks(mixed);
		expect(history.join("") + tail).toBe(mixedText);
		expect(history.join("")).toContain('"clean":true');
		expect(history.join("")).not.toContain('"modified":1');
		expect(history.join("")).not.toContain("resolvedPaths");
		expect(tail).toContain('"modified":1');
		expect(tail).toContain("resolvedPaths");
		expect(tail).toContain("link/secret");
	});

	it.each([
		{ entries: [], expected: "<transcript>\n\n</transcript>" },
		{ entries: [action], expected: '<transcript>\n{"Read":{"path":"link/secret","content":"line one\\nline two 😀"}}\n</transcript>' },
		{ entries: [{ kind: "tool", tool: "read", input: { path: "omit" } }, action], expected: '<transcript>\n{"Read":{"path":"link/secret","content":"line one\\nline two 😀"}}\n</transcript>' },
	] as { entries: TranscriptEntry[]; expected: string }[])("preserves empty and action-only histories: $entries", ({ entries, expected }) => {
		const { history, tail } = transcriptBlocks(entries);
		expect(history.join("") + tail).toBe(expected);
		expect(history).toEqual(["<transcript>"]);
	});

	it("keeps oversized historical entries whole", () => {
		const large = "long history 😀\n".repeat(20_000);
		const { history, tail } = transcriptBlocks([{ kind: "tool", tool: "write", input: { path: "file", content: large } }, action]);
		expect(history[1]).toBe("\n" + JSON.stringify({ Write: { path: "file", content: large } }));
		expect(tail).not.toContain("truncated");
	});
});

describe("Anthropic wire layout", () => {
	it("preserves OAuth system marks and uses at most four breakpoints", () => {
		const payload = {
			model: "claude-sonnet-5", max_tokens: 64, stream: true,
			system: [{ type: "text", text: "OAuth identity", cache_control: cacheControl }, { type: "text", text: "rules", cache_control: cacheControl }],
			messages: [{ role: "user", content: [{ type: "text", text: "headerhistorynewtailstage", cache_control: cacheControl }] }],
		};
		const systemBefore = structuredClone(payload.system);
		cacheClassifierHistory(payload, ["header", "history", "new", "tail", "stage"], 2, 1);
		expect(payload.system).toEqual(systemBefore);
		expect(payload.messages[0].content.filter((block) => block.cache_control)).toHaveLength(2);
		expect(payload.messages[0].content.map((block) => block.text).join("")).toBe("headerhistorynewtailstage");
		expect(payload.max_tokens).toBe(64);
		expect(payload.stream).toBe(true);
	});

	it("uses only free marker slots if pi-ai adds more top-level markers", () => {
		const message = () => ({ role: "user", content: [{ type: "text", text: "headerhistorynewtailstage", cache_control: cacheControl }] });
		const system = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "text", text: `s${i}`, cache_control: cacheControl }));
		const parts = ["header", "history", "new", "tail", "stage"];
		const three = { system: system(3), messages: [message()] };
		cacheClassifierHistory(three, parts, 2, 1);
		expect(three.messages[0].content.filter((block) => block.cache_control).map((block) => block.text)).toEqual(["new"]);
		const four = { system: system(4), messages: [message()] };
		const before = structuredClone(four.messages);
		cacheClassifierHistory(four, parts, 2, 1);
		expect(four.messages).toEqual(before);
	});

	it("inherits the provider's cache duration instead of inventing a different one", () => {
		const short = { type: "ephemeral" };
		const payload = { messages: [{ role: "user", content: [{ type: "text", text: "historytailstage", cache_control: short }] }] };
		cacheClassifierHistory(payload, ["history", "tail", "stage"], 0, 100);
		expect(payload.messages[0].content[0].cache_control).toEqual(short);
		expect(payload.messages[0].content.filter((block) => block.cache_control)).toHaveLength(1);
	});

	it.each([
		{ messages: [{ role: "user", content: [{ type: "text", text: "provider-normalized text", cache_control: cacheControl }] }] },
		{ messages: [{ role: "user", content: [{ type: "text", text: "historytailstage" }] }] },
		{ messages: [{ role: "user", content: "historytailstage" }] },
		{ messages: [{ role: "assistant", content: [] }] },
		{ contents: [] },
	])("leaves transformed or unsupported payloads intact", (payload) => {
		const before = structuredClone(payload);
		cacheClassifierHistory(payload, ["history", "tail", "stage"], 0);
		expect(payload).toEqual(before);
	});
});
