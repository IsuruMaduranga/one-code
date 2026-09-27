import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { exchangeMessages } from "../../extensions/btw/prompt.ts";
import { BTW_FORK_CHANNEL, btwForkedLine, btwForkName, btwForkRecord, btwForkTaskId, type BtwForkRequest, requestBtwFork } from "../../extensions/lib/btw-fork.ts";
import { newChildSessionManager } from "../../extensions/subagents/runner.ts";

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

describe("btwForkName", () => {
	it("joins the question's first three words, as Claude Code names the fork", () => {
		expect(btwForkName("does reading outside project goes through automode classifier")).toBe("does-reading-outside");
		expect(btwForkName("  What   number\tdoes value.ts export")).toBe("what-number-does");
	});

	it("keeps only lowercase letters, digits and single inner dashes", () => {
		expect(btwForkName("Why -- is `x` failing?")).toBe("why-is");
		expect(btwForkName("what's in src/lib?")).toBe("whats-in-srclib");
	});

	it("cuts the name to 24 characters", () => {
		expect(btwForkName("internationalization localization accessibility")).toBe("internationalization-loc");
	});

	it("falls back to fork when no word survives", () => {
		expect(btwForkName("??? !!! ...")).toBe("fork");
		expect(btwForkName("")).toBe("fork");
	});
});

describe("btwForkedLine", () => {
	it("is Claude Code's line, with the last four characters of the task id", () => {
		expect(btwForkedLine("does-reading-outside", "bd83d403")).toBe("\u2442 forked does-reading-outside (d403)");
	});
});

describe("btwForkRecord", () => {
	it("is Claude Code's /btw breadcrumb and forked line, with no caveat (findings §40)", () => {
		expect(btwForkRecord("what-word-is", "awhat-word-is-477c2d9e80467f14", " what word is in the file? ")).toEqual([
			"<command-name>/btw</command-name>\n            <command-message>btw</command-message>\n            <command-args>what word is in the file?</command-args>\n",
			"<local-command-stdout>\u2442 forked what-word-is (7f14)</local-command-stdout>\n",
		]);
	});
});

describe("btwForkTaskId", () => {
	it("is a<name>-<16 hex>", () => {
		expect(btwForkTaskId("what-word-is")).toMatch(/^awhat-word-is-[0-9a-f]{16}$/);
	});
});

describe("newChildSessionManager", () => {
	const root = mkdtempSync(join(tmpdir(), "btw-fork-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-5" };

	it("clones the parent transcript and appends the side exchange after it", () => {
		const parent = SessionManager.create(root, join(root, "parent"));
		for (const message of exchangeMessages({ question: "main question", answer: "main answer" }, model)) parent.appendMessage(message);
		const parentFile = parent.getSessionFile();
		expect(parentFile).toBeDefined();

		const fork = newChildSessionManager({
			cwd: root,
			forkFrom: parentFile,
			sessionDir: join(root, "forks"),
			forkMessages: exchangeMessages({ question: "side?", answer: "side." }, model),
		});
		const texts = fork
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => ((entry as { message: { content: { text: string }[] } }).message.content[0] as { text: string }).text);
		expect(texts).toEqual(["main question", "main answer", "side?", "side."]);

		// A resume reads the appended exchange back from the fork's own file.
		const reopened = SessionManager.open(fork.getSessionFile()!, undefined, root);
		expect(reopened.getEntries().filter((entry) => entry.type === "message")).toHaveLength(4);
	});

	it("starts a fork from the side exchange alone when the parent has no transcript yet", () => {
		const fork = newChildSessionManager({
			cwd: root,
			forkFrom: join(root, "not-written-yet.jsonl"),
			sessionDir: join(root, "fresh"),
			forkMessages: exchangeMessages({ question: "side?", answer: "side." }, model),
		});
		expect(fork.getEntries().filter((entry) => entry.type === "message")).toHaveLength(2);
		expect(fork.getSessionFile()).toBeDefined();
	});
});
