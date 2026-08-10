import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateCheck, isNewerVersion } from "../../app/update-check.mjs";

describe("isNewerVersion", () => {
	it("orders plain x.y.z versions", () => {
		expect(isNewerVersion("0.2.0", "0.1.0")).toBe(true);
		expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
		expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
		expect(isNewerVersion("1.0", "0.99.99")).toBe(true);
	});

	it("treats unparseable versions as not newer", () => {
		expect(isNewerVersion("0.2.0-beta.1", "0.1.0")).toBe(false);
		expect(isNewerVersion("", "0.1.0")).toBe(false);
	});
});

type SessionStartHandler = (event: unknown, ctx: unknown) => void;

function harness() {
	let handler: SessionStartHandler | undefined;
	const pi = {
		on: (event: string, fn: SessionStartHandler) => {
			if (event === "session_start") handler = fn;
		},
	};
	const notify = vi.fn();
	const ctx = { hasUI: true, ui: { notify } };
	return { pi, ctx, notify, fire: () => handler?.({}, ctx) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createUpdateCheck", () => {
	it("notifies with the upgrade hint when the registry has a newer version", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ version: "0.9.0" }) })),
		);
		const { pi, notify, fire } = harness();
		createUpdateCheck({ currentVersion: "0.1.0", upgradeHint: "brew upgrade one-code" })(pi);
		fire();
		await flush();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("0.9.0"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("brew upgrade one-code"), "info");
	});

	it("stays silent when up to date, on registry errors, and without a UI", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ version: "0.1.0" }) })),
		);
		const same = harness();
		createUpdateCheck({ currentVersion: "0.1.0", upgradeHint: "x" })(same.pi);
		same.fire();
		await flush();
		expect(same.notify).not.toHaveBeenCalled();

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const offline = harness();
		createUpdateCheck({ currentVersion: "0.1.0", upgradeHint: "x" })(offline.pi);
		offline.fire();
		await flush();
		expect(offline.notify).not.toHaveBeenCalled();

		const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) }));
		vi.stubGlobal("fetch", fetchSpy);
		const headless = harness();
		(headless.ctx as { hasUI: boolean }).hasUI = false;
		createUpdateCheck({ currentVersion: "0.1.0", upgradeHint: "x" })(headless.pi);
		headless.fire();
		await flush();
		expect(headless.notify).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
