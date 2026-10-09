import { describe, expect, it, vi } from "vitest";
import { consentDialog, installConsentDialogs, startupConsentReady } from "../../extensions/lib/consent-dialogs.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const deferred = () => {
	let resolve!: (value: string) => void;
	const promise = new Promise<string>((done) => { resolve = done; });
	return { promise, resolve };
};

describe("startup consent dialog queue", () => {
	it("serializes prompts and reserves a position before asynchronous policy reads", async () => {
		const { events } = createFakePi();
		installConsentDialogs(events);
		const first = deferred();
		const shown: string[] = [];
		const a = consentDialog(events, async () => { shown.push("first"); return first.promise; });
		const b = consentDialog(events, async () => { shown.push("second"); return "two"; });
		await Promise.resolve();
		expect(shown).toEqual(["first"]);
		first.resolve("one");
		expect(await a).toBe("one");
		expect(await b).toBe("two");
		expect(shown).toEqual(["first", "second"]);
	});

	it("puts external includes after startup consent, even though it registers first", async () => {
		const { events } = createFakePi();
		installConsentDialogs(events);
		const shown: string[] = [];
		const includes = consentDialog(events, async () => { shown.push("includes"); }, true);
		const hook = consentDialog(events, async () => { shown.push("hook"); });
		const mcp = consentDialog(events, async () => { shown.push("mcp"); });
		await hook;
		await mcp;
		expect(shown).toEqual(["hook", "mcp"]);
		startupConsentReady(events);
		await includes;
		expect(shown).toEqual(["hook", "mcp", "includes"]);
	});

	it("cancels active and queued replies on shutdown, and accepts work in the new session", async () => {
		const { events } = createFakePi();
		const reset = installConsentDialogs(events);
		const first = deferred();
		let signal: AbortSignal | undefined;
		const a = consentDialog(events, async (s) => { signal = s; return first.promise; });
		const stale = vi.fn(async () => "stale approval");
		const b = consentDialog(events, stale);
		const c = consentDialog(events, stale, true);
		await Promise.resolve();
		reset();
		expect(signal?.aborted).toBe(true);
		expect(await a).toBeUndefined();
		expect(await b).toBeUndefined();
		expect(await c).toBeUndefined();
		first.resolve("late yes");
		startupConsentReady(events);
		expect(await consentDialog(events, async () => "new session")).toBe("new session");
		expect(stale).not.toHaveBeenCalled();
	});

	it("a rejected dialog does not strand the next one", async () => {
		const { events } = createFakePi();
		installConsentDialogs(events);
		await expect(consentDialog(events, async () => { throw new Error("closed"); })).rejects.toThrow("closed");
		expect(await consentDialog(events, async () => "next")).toBe("next");
	});

	it("works directly when an extension is loaded without the queue owner", async () => {
		const { events } = createFakePi();
		expect(await consentDialog(events, async () => "standalone")).toBe("standalone");
	});
});
