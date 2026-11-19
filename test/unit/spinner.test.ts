import { describe, expect, it, vi } from "vitest";
import { alignRight, formatDuration } from "../../extensions/lib/ui/tui-render.ts";
import { composeWorkingMessage, estimateTokens, messageChars, spinnerFrames } from "../../extensions/ui/spinner/line.ts";
import { ALL_VERBS, pickVerb, SPINNER_VERBS } from "../../extensions/ui/spinner/verbs.ts";

describe("spinnerFrames", () => {
	it("mirrors the frame cycle forward then back", () => {
		const frames = spinnerFrames("darwin", undefined);
		expect(frames).toEqual(["·", "✢", "✳", "✶", "✻", "✽", "✽", "✻", "✶", "✳", "✢", "·"]);
	});

	it("swaps the glyphs Ghostty and non-mac terminals render badly", () => {
		expect(spinnerFrames("darwin", "xterm-ghostty")).toContain("*");
		expect(spinnerFrames("linux", undefined)).toContain("*");
	});
});

describe("pickVerb", () => {
	it("picks from the verb list, clamped at the edges", () => {
		expect(pickVerb(() => 0)).toBe(ALL_VERBS[0]);
		expect(pickVerb(() => 0.999999)).toBe(ALL_VERBS[ALL_VERBS.length - 1]);
		expect(SPINNER_VERBS).toContain("Hyperspacing");
		expect(SPINNER_VERBS).toContain("Beboppin'");
		expect(SPINNER_VERBS.length).toBe(186);
	});

	it("adds the brand's own verbs after the base's", () => {
		expect(ALL_VERBS.slice(0, SPINNER_VERBS.length)).toEqual(SPINNER_VERBS);
		expect(pickVerb(() => 0.999999, [...SPINNER_VERBS, "Branding"])).toBe("Branding");
	});
});

describe("composeWorkingMessage", () => {
	it("shows the verb and elapsed time, adding tokens once anything streamed", () => {
		expect(composeWorkingMessage({ verb: "Hyperspacing", elapsedMs: 1000, responseChars: 0 })).toBe(
			"Hyperspacing… (1s)",
		);
		expect(composeWorkingMessage({ verb: "Hyperspacing", elapsedMs: 10_000, responseChars: 1792 })).toBe(
			"Hyperspacing… (10s · ↓ 448 tokens)",
		);
	});

	it("uses compact token counts and humane durations", () => {
		expect(composeWorkingMessage({ verb: "Brewing", elapsedMs: 67_000, responseChars: 5200 })).toBe(
			"Brewing… (1m 7s · ↓ 1.3k tokens)",
		);
	});
});

describe("estimateTokens / messageChars", () => {
	it("estimates a token per four characters", () => {
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(10)).toBe(3);
	});

	it("counts text and thinking blocks, ignoring everything else", () => {
		const message = {
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "x" },
			],
		};
		expect(messageChars(message)).toBe(8);
		expect(messageChars(undefined)).toBe(0);
		expect(messageChars({ content: "not-an-array" })).toBe(0);
	});
});

describe("alignRight", () => {
	it("right-aligns within the width and never exceeds it", () => {
		expect(alignRight("abc", 6)).toBe("   abc");
		expect(alignRight("abcdef", 4)).toBe("abcd");
	});
});

describe("formatDuration (shared)", () => {
	it("keeps the viewer's humane format", () => {
		expect(formatDuration(0, 45_000)).toBe("45s");
		expect(formatDuration(0, 67_000)).toBe("1m 7s");
	});
});

describe("spinner wiring (retry keeps the open span)", () => {
	it("keeps the first run's start and verb across agent_end/agent_start, stopping only at settle", async () => {
		vi.useFakeTimers();
		try {
			const { default: spinnerExtension } = await import("../../extensions/ui/spinner/index.ts");
			const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
			const pi = {
				on(event: string, handler: (event: unknown, ctx: unknown) => void) {
					const list = handlers.get(event) ?? [];
					list.push(handler);
					handlers.set(event, list);
				},
			};
			const fire = (event: string, ctx: unknown) => {
				for (const h of handlers.get(event) ?? []) h({}, ctx);
			};
			const messages: Array<string | undefined> = [];
			const ctx = {
				hasUI: true,
				ui: {
					theme: undefined,
					setWorkingIndicator: () => {},
					setWorkingMessage: (text?: string) => {
						messages.push(text);
					},
				},
			};

			spinnerExtension(pi as never);
			fire("agent_start", ctx);
			vi.advanceTimersByTime(5000);
			const beforeRetry = messages.at(-1);
			expect(beforeRetry).toContain("(5s");
			const verb = beforeRetry?.split("…")[0];

			// Provider retry: pi fires agent_end for the failed run and then a
			// fresh agent_start, with no agent_settled in between. The spinner
			// does not subscribe to agent_end at all (a retry must be invisible
			// to it), so the retry is modelled as a second agent_start on the
			// open span. The elapsed counter must NOT restart from zero, and the
			// verb stays.
			fire("agent_start", ctx);
			vi.advanceTimersByTime(1000);
			const afterRetry = messages.at(-1);
			expect(afterRetry).toContain("(6s");
			expect(afterRetry?.split("…")[0]).toBe(verb);

			// Settle stops the ticker and restores pi's default message.
			fire("agent_settled", ctx);
			expect(messages.at(-1)).toBeUndefined();
			const count = messages.length;
			vi.advanceTimersByTime(5000);
			expect(messages.length).toBe(count);

			// The next turn opens a fresh span from zero.
			fire("agent_start", ctx);
			expect(messages.at(-1)).toContain("(0s");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("spinner wiring (a yield wait says what it waits for)", () => {
	it("shows Claude Code's waiting line while a yield call runs, and the verb again after", async () => {
		vi.useFakeTimers();
		try {
			const { default: spinnerExtension } = await import("../../extensions/ui/spinner/index.ts");
			const { createFakePi } = await import("./helpers/fake-pi.ts");
			const { SESSION_WORK_CHANNEL } = await import("../../extensions/lib/notify/session-work.ts");
			const fake = createFakePi();
			const tasks = [{ id: "a1", type: "subagent", status: "running", description: "Build" }];
			fake.events.on(SESSION_WORK_CHANNEL, (data: unknown) => (data as { tasks: unknown[] }).tasks.push(...tasks));
			const messages: Array<string | undefined> = [];
			const ctx = { hasUI: true, ui: { theme: undefined, setWorkingIndicator: () => {}, setWorkingMessage: (text?: string) => messages.push(text) } };
			spinnerExtension(fake.pi as never);
			await fake.fire("agent_start", { type: "agent_start" }, ctx);
			const verb = messages.at(-1)?.split("…")[0];

			await fake.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "y1", toolName: "yield", args: {} }, ctx);
			expect(messages.at(-1)).toBe("Waiting for 1 background agent to finish… (0s)");
			tasks.push({ id: "a2", type: "subagent", status: "running", description: "Test" });
			vi.advanceTimersByTime(65_000);
			expect(messages.at(-1)).toBe("Waiting for 2 background agents to finish… (1m 5s)");

			// Another tool does not end the wait; the yield call's end does.
			await fake.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: {}, isError: false }, ctx);
			expect(messages.at(-1)).toContain("Waiting for 2 background agents");
			await fake.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "y1", toolName: "yield", result: {}, isError: false }, ctx);
			expect(messages.at(-1)).toBe(`${verb}… (1m 5s)`);

			// A wait on a shell alone still says what it waits for.
			tasks.splice(0, tasks.length, { id: "s1", type: "shell", status: "running", description: "npm test" });
			await fake.fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "y2", toolName: "yield", args: {} }, ctx);
			expect(messages.at(-1)).toBe("Waiting for 1 background task to finish… (1m 5s)");
		} finally {
			vi.useRealTimers();
		}
	});
});
