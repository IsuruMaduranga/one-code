import { describe, expect, it, vi } from "vitest";
import { openGatePrompt } from "../../extensions/lib/consent/gate-prompt.ts";
import { PROMPT_ATTENTION_CHANNEL } from "../../extensions/lib/notify/desktop.ts";

/** A bus that records every emit as `channel: message` (or the bare channel). */
function bus() {
	const log: string[] = [];
	const events = {
		emit: (channel: string, data: unknown) => {
			const message = (data as { message?: string } | undefined)?.message;
			log.push(channel === PROMPT_ATTENTION_CHANNEL ? `described: ${message}` : channel);
		},
	};
	return { events, log };
}

describe("openGatePrompt", () => {
	it("announces the description, then opens the prompt and returns its answer", async () => {
		const { events, log } = bus();
		const answer = await openGatePrompt({
			events,
			attention: "Prod needs your permission to use Bash",
			open: async () => {
				log.push("opened");
				return "Yes";
			},
		});
		expect(answer).toBe("Yes");
		expect(log[0]).toBe("described: Prod needs your permission to use Bash");
		expect(log[1]).toBe("opened");
	});

	it("opens an undescribed prompt without announcing anything", async () => {
		const { events, log } = bus();
		const open = vi.fn(async () => "typed");
		expect(await openGatePrompt({ events, attention: undefined, open })).toBe("typed");
		expect(open).toHaveBeenCalledOnce();
		expect(log).toEqual([]);
	});

	it("neither announces nor opens when the signal is already aborted", async () => {
		const { events, log } = bus();
		const controller = new AbortController();
		controller.abort();
		const open = vi.fn(async () => "Yes");
		expect(await openGatePrompt({ events, attention: "described", signal: controller.signal, open })).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
		expect(log).toEqual([]);
	});

	it("neither announces nor opens with no UI (the gate fails closed)", async () => {
		const { events, log } = bus();
		const open = vi.fn(async () => "Yes");
		expect(await openGatePrompt({ events, attention: "described", hasUI: () => false, open })).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
		expect(log).toEqual([]);
	});

	it("lets a throwing UI check propagate without opening (a stale context)", async () => {
		const { events, log } = bus();
		const open = vi.fn(async () => "Yes");
		await expect(openGatePrompt({ events, attention: "described", hasUI: () => { throw new Error("stale ctx"); }, open })).rejects.toThrow("stale ctx");
		expect(open).not.toHaveBeenCalled();
		expect(log).toEqual([]);
	});

	it("passes an opener's rejection through", async () => {
		const { events } = bus();
		await expect(openGatePrompt({ events, attention: undefined, open: async () => { throw new Error("boom"); } })).rejects.toThrow("boom");
	});
});
