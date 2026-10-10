import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pluginsExtension from "../../extensions/plugins/index.ts";
import { invalidatePluginsCache } from "../../extensions/lib/plugins.ts";
import { setInstalledEnabled } from "../../extensions/plugins/install/registry.ts";
import { ONE_SHOT_COMMAND_FAILED_CHANNEL } from "../../extensions/lib/interrupt.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

let home: string;
let root: string;
let plugin: string;

const writeRegistry = (installPath: string, extra: Record<string, unknown> = {}) => {
	writeFileSync(join(root, "installed_plugins.json"), JSON.stringify({
		plugins: { "fixture@local": [{ installPath, enabled: true, ...extra }] },
	}));
	invalidatePluginsCache();
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "onecode-plugin-lifecycle-"));
	stubHome(home);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
	root = join(home, "agent", "plugins");
	plugin = join(home, "fixture");
	mkdirSync(join(plugin, "commands"), { recursive: true });
	mkdirSync(root, { recursive: true });
	writeFileSync(join(plugin, "commands", "ping.md"), "Old command $ARGUMENTS");
	writeRegistry(plugin);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	invalidatePluginsCache();
	rmSync(home, { recursive: true, force: true });
});

describe("plugin command lifecycle", () => {
	it("refuses a registered command after disabling its plugin", async () => {
		const fake = createFakePi();
		pluginsExtension(fake.pi as never);
		setInstalledEnabled(root, "fixture@local", false);
		invalidatePluginsCache();
		const ctx = createFakeCtx({ cwd: home, mode: "tui" });
		await fake.commands.get("fixture:ping")!.handler("ARGS", ctx);
		expect(fake.sentUserMessages).toEqual([]);
	});

	it("uses the current installed command path after a plugin update", async () => {
		const fake = createFakePi();
		pluginsExtension(fake.pi as never);
		const updated = join(home, "updated fixture");
		mkdirSync(join(updated, "commands"), { recursive: true });
		writeFileSync(join(updated, "commands", "ping.md"), "Updated command $ARGUMENTS");
		writeRegistry(updated);
		await fake.commands.get("fixture:ping")!.handler("ARGS", createFakeCtx({ cwd: home, mode: "tui" }));
		expect(fake.sentUserMessages).toEqual([{ content: "Updated command ARGS", options: undefined }]);
	});

	it("rejects a load-time command outside its project in the actual session cwd", async () => {
		writeRegistry(plugin, { scope: "project", projectPath: process.cwd() });
		const fake = createFakePi();
		pluginsExtension(fake.pi as never);
		const failures: unknown[] = [];
		fake.events.on(ONE_SHOT_COMMAND_FAILED_CHANNEL, (data) => failures.push(data));
		const ctx = createFakeCtx({ cwd: home, mode: "json" });
		await fake.fire("session_start", {}, ctx);
		const output = vi.spyOn(console, "error").mockImplementation(() => {});
		const running = fake.commands.get("fixture:ping")!.handler("ARGS", ctx);
		await vi.waitFor(() => expect(fake.sentUserMessages.length + output.mock.calls.length).toBeGreaterThan(0));
		expect(fake.sentUserMessages).toEqual([]);
		await running;
		expect(failures).toHaveLength(1);
	});
});
