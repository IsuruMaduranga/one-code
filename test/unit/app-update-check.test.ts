import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_INTERVAL_MS, checkedRecently, createUpdateCheck, isNewerVersion, isOffline } from "../../app/update-check.mjs";

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

describe("offline and cadence gating", () => {
	it("isOffline reads PI_OFFLINE the way pi does", () => {
		expect(isOffline({ PI_OFFLINE: "1" })).toBe(true);
		expect(isOffline({ PI_OFFLINE: "true" })).toBe(true);
		expect(isOffline({ PI_OFFLINE: "yes" })).toBe(true);
		expect(isOffline({ PI_OFFLINE: "0" })).toBe(false);
		expect(isOffline({})).toBe(false);
	});

	it("checkedRecently is true only for a readable stamp inside the interval", () => {
		const dir = mkdtempSync(join(tmpdir(), "onecode-update-"));
		const stamp = join(dir, "last-update-check");
		expect(checkedRecently(stamp)).toBe(false); // missing
		writeFileSync(stamp, String(Date.now() - 60_000));
		expect(checkedRecently(stamp)).toBe(true);
		writeFileSync(stamp, String(Date.now() - CHECK_INTERVAL_MS - 1));
		expect(checkedRecently(stamp)).toBe(false);
		writeFileSync(stamp, "garbage");
		expect(checkedRecently(stamp)).toBe(false);
		expect(checkedRecently(undefined)).toBe(false);
	});

	it("skips the fetch when offline, and stamps + skips within a day", async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) }));
		vi.stubGlobal("fetch", fetchMock);
		const dir = mkdtempSync(join(tmpdir(), "onecode-update-"));
		const stamp = join(dir, "last-update-check");

		vi.stubEnv("PI_OFFLINE", "1");
		const offline = harness();
		createUpdateCheck({ currentVersion: "0.1.0", upgradeHint: "x", stampPath: stamp })(offline.pi);
		offline.fire();
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
		vi.unstubAllEnvs();

		const first = harness();
		createUpdateCheck({ currentVersion: "0.1.0", upgradeHint: "x", stampPath: stamp })(first.pi);
		first.fire();
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(first.notify).toHaveBeenCalledTimes(1);
		expect(Number(readFileSync(stamp, "utf8"))).toBeGreaterThan(0);

		// Same day, next start (or a /clear): no second request.
		const second = harness();
		createUpdateCheck({ currentVersion: "0.1.0", upgradeHint: "x", stampPath: stamp })(second.pi);
		second.fire();
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second.notify).not.toHaveBeenCalled();
	});
});
