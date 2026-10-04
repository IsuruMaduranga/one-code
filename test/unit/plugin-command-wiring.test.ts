import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pluginsExtension from "../../extensions/plugins/index.ts";
import { invalidatePluginsCache } from "../../extensions/lib/plugins.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "onecode-plugin-command-"));
	stubHome(home);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
	const plugin = join(home, "fixture");
	mkdirSync(join(plugin, "commands"), { recursive: true });
	mkdirSync(join(home, "agent", "plugins"), { recursive: true });
	writeFileSync(join(plugin, "commands", "ping.md"), "Reply with $ARGUMENTS");
	writeFileSync(join(home, "agent", "plugins", "installed_plugins.json"), JSON.stringify({
		plugins: { "fixture@local": [{ installPath: plugin, enabled: true }] },
	}));
	invalidatePluginsCache();
});
afterEach(() => {
	invalidatePluginsCache();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("plugin command user turns", () => {
	it.each(["print", "json"])("waits for startup then settlement in %s", async (mode) => {
		const fake = createFakePi();
		pluginsExtension(fake.pi as never);
		let settle!: () => void;
		const idle = new Promise<void>((resolve) => { settle = resolve; });
		const waitForIdle = vi.fn(() => idle);
		let returned = false;
		const running = fake.commands.get("fixture:ping")!.handler("PLUGIN_OK", createFakeCtx({
			mode, cwd: home, waitForIdle,
			sessionManager: { getSessionDir: () => join(home, "sessions") },
		})).then(() => { returned = true; });
		try {
			await vi.waitFor(() => expect(fake.sentUserMessages).toHaveLength(1));
			expect(fake.sentUserMessages[0].content).toBe("Reply with PLUGIN_OK");
			expect(returned).toBe(false);
			expect(waitForIdle).not.toHaveBeenCalled();
			await fake.fire("agent_start", {});
			await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledTimes(1));
			expect(returned).toBe(false);
		} finally {
			settle();
			await running;
		}
		expect(returned).toBe(true);
	});
});
