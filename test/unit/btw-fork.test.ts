import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { exchangeMessages } from "../../extensions/btw/prompt.ts";
import { BTW_FORK_CHANNEL, type BtwForkRequest, requestBtwFork } from "../../extensions/lib/btw-fork.ts";
import { forkSession } from "../../extensions/subagents/runner.ts";

function bus() {
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	return {
		on: (channel: string, fn: (data: unknown) => void) => listeners.set(channel, [...(listeners.get(channel) ?? []), fn]),
		emit: (channel: string, data: unknown) => {
			for (const fn of listeners.get(channel) ?? []) fn(data);
		},
	};
}

describe("requestBtwFork", () => {
	it("answers with an error when no extension takes the request", async () => {
		const result = await requestBtwFork(bus(), { ctx: {}, question: "q", messages: [] });
		expect(result).toEqual({ error: expect.stringContaining("subagents extension") });
	});

	it("waits for the listener's answer once it takes the request", async () => {
		const events = bus();
		events.on(BTW_FORK_CHANNEL, (data) => {
			const request = data as BtwForkRequest;
			request.handled = true;
			setTimeout(() => request.respond({ name: `fork-for-${request.question}`, taskId: "t123" }), 1);
		});
		expect(await requestBtwFork(events, { ctx: {}, question: "q", messages: [] })).toEqual({ name: "fork-for-q", taskId: "t123" });
	});
});

describe("forkSession", () => {
	const root = mkdtempSync(join(tmpdir(), "btw-fork-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5" };

	it("clones the parent transcript and appends the side exchange after it", () => {
		const parent = SessionManager.create(root, join(root, "parent"));
		for (const message of exchangeMessages({ question: "main question", answer: "main answer" }, model)) parent.appendMessage(message);
		const parentFile = parent.getSessionFile();
		expect(parentFile).toBeDefined();

		const fork = forkSession(parentFile!, root, join(root, "forks"), exchangeMessages({ question: "side?", answer: "side." }, model));
		const texts = fork
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => ((entry as { message: { content: { text: string }[] } }).message.content[0] as { text: string }).text);
		expect(texts).toEqual(["main question", "main answer", "side?", "side."]);

		// A resume reads the appended exchange back from the fork's own file.
		const reopened = SessionManager.open(fork.getSessionFile()!, undefined, root);
		expect(reopened.getEntries().filter((entry) => entry.type === "message")).toHaveLength(4);
	});
});
