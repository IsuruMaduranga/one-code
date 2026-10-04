import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import memoryExtension from "../../extensions/memory/index.ts";
import effortExtension from "../../extensions/effort/index.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import pluginsExtension from "../../extensions/plugins/index.ts";
import skillExtension from "../../extensions/skill/index.ts";
import { invalidatePluginsCache } from "../../extensions/lib/plugins.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { oneCodeProjectSettingsPath } from "../../extensions/lib/one-code-settings.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

let home: string;
let cwd: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "rpc-panels-"));
	cwd = join(home, "project");
	mkdirSync(cwd);
	stubHome(home);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
	invalidatePluginsCache();
});
afterEach(() => {
	invalidatePluginsCache();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function mount(extension: (pi: never) => void) {
	const fake = createFakePi();
	extension(fake.pi as never);
	// pi's RPC UI is present, but custom() resolves undefined without building it.
	const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc" });
	const custom = (ctx.ui as { custom: ReturnType<typeof vi.fn> }).custom;
	const notices = () => (ctx._notified as Array<{ message: string }>).map((n) => n.message).join("\n");
	return { fake, ctx, custom, notices };
}

describe("RPC commands never silently mount unsupported custom UI", () => {
	it("/memory lists paths and reports its limitation, not a fictional user cancellation", async () => {
		const { fake, ctx, custom, notices } = mount(memoryExtension);
		const reminders: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push((data as { text: string }).text));
		await fake.commands.get("memory")!.handler("", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notices()).toContain("CLAUDE.md");
		expect(notices()).toMatch(/RPC.*(TUI|terminal)/);
		expect(reminders.join("\n")).not.toContain("Cancelled memory editing");
		expect(reminders.join("\n")).toContain("RPC");
	});

	it("/permissions explains that management needs the TUI and still lists permissions", async () => {
		const { fake, ctx, custom, notices } = mount(permissionsExtension);
		await fake.commands.get("permissions")!.handler("", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notices()).toMatch(/RPC.*TUI/);
		expect(notices()).toContain("mode:");
	});

	it("bare /add-dir tells the client to supply a path instead of silently opening a panel", async () => {
		const { fake, ctx, custom, notices } = mount(permissionsExtension);
		await fake.commands.get("add-dir")!.handler("", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notices()).toContain("/add-dir <path>");
	});

	it("/add-dir never grants or persists access for an unrecognized RPC select response", async () => {
		const { fake, ctx, notices } = mount(permissionsExtension);
		const external = join(home, "external");
		mkdirSync(external);
		(ctx.ui as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValue("yes");
		await fake.commands.get("add-dir")!.handler(external, ctx);
		expect(existsSync(oneCodeProjectSettingsPath(cwd, home))).toBe(false);
		expect(notices()).not.toContain("Added directory");
	});

	it.each(["Yes, for this session", "Yes, and remember this directory"])("/add-dir still accepts the explicit RPC choice: %s", async (choice) => {
		const { fake, ctx, notices } = mount(permissionsExtension);
		const external = join(home, "external");
		mkdirSync(external);
		(ctx.ui as { select: ReturnType<typeof vi.fn> }).select.mockResolvedValue(choice);
		await fake.commands.get("add-dir")!.handler(external, ctx);
		expect(notices()).toContain("Added directory");
		const settings = oneCodeProjectSettingsPath(cwd, home);
		if (choice === "Yes, for this session") expect(existsSync(settings)).toBe(false);
		else expect(JSON.parse(readFileSync(settings, "utf8")).permissions.additionalDirectories).toHaveLength(1);
	});

	it("/auto-mode model already gives usable text instructions in RPC", async () => {
		const { fake, ctx, custom, notices } = mount(permissionsExtension);
		ctx.modelRegistry = { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-5" }] };
		await fake.commands.get("auto-mode")!.handler("model", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notices()).toContain("classifierModel:");
		expect(notices()).toContain("Set one with /auto-mode model <provider/model-id>");
	});

	it("/plugins lists installed plugins and explains that management needs the TUI", async () => {
		const { fake, ctx, custom, notices } = mount(pluginsExtension);
		await fake.commands.get("plugins")!.handler("", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notices()).toMatch(/RPC.*TUI/);
		expect(notices()).toContain("No plugins installed");
	});

	it("/skills lists skill states and explains that management needs the TUI", async () => {
		const path = join(cwd, ".claude", "skills", "demo");
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "SKILL.md"), "---\nname: demo\ndescription: Demonstration\n---\nDemo body.\n");
		const { fake, ctx, custom, notices } = mount(skillExtension);
		await fake.commands.get("skills")!.handler("", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notices()).toMatch(/RPC.*TUI/);
		expect(notices()).toContain("demo [on]");
	});

	it("/effort already gives usable text instructions in RPC", async () => {
		const { fake, ctx, custom, notices } = mount(effortExtension);
		await fake.commands.get("effort")!.handler("", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notices()).toContain("Current effort: medium");
		expect(notices()).toContain("Set one with /effort");
	});
});
