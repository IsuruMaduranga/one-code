import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../../extensions/permissions/modes.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import { pinCatalog } from "./catalog-fixture.ts";

const model = (id: string, contextWindow: number, price: number) => ({ provider: "openai-codex", id, name: id, contextWindow, maxTokens: 8192, cost: { input: price, output: price * 4 } });
// All frontier on OpenAI's own API, released together so none supersedes another.
const large = model("gpt-6-astra", 1_000_000, 10);
const small = model("gpt-6.1-sol", 272_000, 5);
const cheap = model("gpt-6-sol", 272_000, 2);

describe("automatic classifier selection wiring", () => {
	let home: string;
	let fake: FakePi;
	let ctx: ReturnType<typeof createFakeCtx>;
	let statuses: PermissionStatus[];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "classifier-selection-"));
		mkdirSync(join(home, "project"));
		mkdirSync(join(home, ".onecode"));
		stubHome(home);
		pinCatalog([
			{ id: "openai/gpt-6-astra", released: "2026-09-22", price: [5, 40] },
			{ id: "openai/gpt-6.1-sol", released: "2026-09-22", price: [1.5, 13] },
			{ id: "openai/gpt-6-sol", released: "2026-09-22", price: [1, 13] },
			{ id: "openai/gpt-5.6-sol", released: "2026-07-09", price: [2.5, 30] },
		]);
		vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		fake = createFakePi();
		statuses = [];
		fake.events.on(PERMISSION_STATUS_CHANNEL, (data) => statuses.push(data as PermissionStatus));
		permissionsExtension(fake.pi as never);
		ctx = createFakeCtx({ cwd: join(home, "project"), model: large, modelRegistry: { getAvailable: () => [large, small, cheap] }, sessionManager: { getSessionId: () => "s", getSessionDir: () => join(home, "sessions"), getBranch: () => [] } });
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("announces the window fallback at startup and re-picks on a model switch", async () => {
		await fake.fire("session_start", { reason: "startup" }, ctx);
		expect(statuses.at(-1)?.classifier).toBe("openai-codex/gpt-6-astra");
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		expect(notify.mock.calls.map(([text]) => text)).toEqual(expect.arrayContaining([expect.stringMatching(/gpt-6-astra.*(?:window|context)/)]));
		ctx.model = small;
		await fake.fire("model_select", { model: small }, ctx);
		expect(statuses.at(-1)?.classifier).toBe("openai-codex/gpt-6-sol");
		expect(notify.mock.calls.some(([text]) => /gpt-6-sol\b/.test(text))).toBe(true);
	});

	it("announces the session fallback below frontier and replaces it on a frontier switch", async () => {
		// No cheaper model contains its window, so the session screens itself.
		const belowFrontier = model("gpt-5.6-sol", 1_000_000, 5);
		ctx.model = belowFrontier;
		await fake.fire("session_start", { reason: "startup" }, ctx);
		expect(statuses.at(-1)?.classifier).toBe("openai-codex/gpt-5.6-sol");
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		expect(notify.mock.calls.some(([text]) => /in its workhorse tier or above contains/.test(text))).toBe(true);
		ctx.model = small;
		await fake.fire("model_select", { model: small }, ctx);
		expect(statuses.at(-1)?.classifier).toBe("openai-codex/gpt-6-sol");
		await fake.fire("session_shutdown", {}, ctx);
	});

	it("removes the model command, completion, and setting display without rewriting legacy settings", async () => {
		const settings = join(home, ".onecode", "settings.json");
		const legacy = JSON.stringify({ autoMode: { classifierModel: "openai-codex/gpt-5.6-terra" } });
		writeFileSync(settings, legacy);
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const command = fake.commands.get("auto-mode")!;
		expect(command.description).not.toContain("model");
		const completions = command.getArgumentCompletions as () => { value: string }[];
		expect(completions().map((entry) => entry.value)).not.toContain("model");
		await command.handler("model openai-codex/gpt-6-sol", ctx);
		expect((ctx.ui as { notify: unknown }).notify).toHaveBeenCalledWith(expect.stringContaining('Unknown subcommand "model"'), "warning");
		await command.handler("config", ctx);
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		expect(String(notify.mock.calls.at(-1)?.[0])).not.toContain("classifierModel:");
		expect(readFileSync(settings, "utf8")).toBe(legacy);
	});
});
