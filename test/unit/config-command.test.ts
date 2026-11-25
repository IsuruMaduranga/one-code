import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import configExtension from "../../extensions/commands/config/index.ts";
import { decodeConfigKey, nextValue, renderConfig } from "../../extensions/commands/config/panel.ts";
import { configRows, type ConfigView, withSetting } from "../../extensions/commands/config/rows.ts";
import type { FeatureId } from "../../extensions/lib/profile/features.ts";
import type { FeatureOffSource } from "../../extensions/lib/profile/profile.ts";
import { productSettingsPath, readFeaturesOffSetting } from "../../extensions/lib/profile/settings-file.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import { CONFIG_ROWS_CHANNEL, type ConfigRowsQuery } from "../../extensions/lib/ui/config-rows.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const view = (file: Record<string, unknown>, offBy: Array<[FeatureId, FeatureOffSource]> = [], workflows = true): ConfigView => ({ file, offBy: new Map(offBy), workflows, offVariable: "ONECODE_FEATURES_OFF" });
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("/config rows", () => {
	it("shows each feature's value from the settings file and hides what the product turns off", () => {
		const rows = configRows(view({ featuresOff: ["recap"] }, [["session-title", "product"]]));
		expect(rows.find((row) => row.id === "feature:recap")?.currentValue).toBe("false");
		expect(rows.find((row) => row.id === "feature:turn-duration")?.currentValue).toBe("true");
		expect(rows.some((row) => row.id === "feature:session-title")).toBe(false);
		expect(rows.find((row) => row.id === "suggestNewerModels")?.currentValue).toBe("true");
		expect(rows.find((row) => row.id === "workflowSizeGuideline")?.currentValue).toBe("medium");
	});

	it("says when the environment turns a feature off for this run, and drops the workflow row without workflows", () => {
		const rows = configRows(view({}, [["recap", "environment"]], false));
		expect(rows.find((row) => row.id === "feature:recap")?.description).toContain("ONECODE_FEATURES_OFF turns it off");
		expect(rows.some((row) => row.id === "workflowSizeGuideline")).toBe(false);
	});

	it("rewrites only its own key and keeps the rest of the file", () => {
		const file = { model: "x", featuresOff: ["footer"] };
		expect(withSetting(file, "feature:recap", "false")).toEqual({ model: "x", featuresOff: ["footer", "recap"] });
		expect(withSetting({ model: "x", featuresOff: ["recap"] }, "feature:recap", "true")).toEqual({ model: "x" });
		expect(withSetting(file, "suggestNewerModels", "false")).toEqual({ ...file, suggestNewerModels: false });
		expect(withSetting({ suggestNewerModels: false }, "suggestNewerModels", "true")).toEqual({});
		expect(withSetting(file, "workflowSizeGuideline", "large")).toEqual({ ...file, workflowSizeGuideline: "large" });
		// Only the listed features, and only known values.
		expect(withSetting(file, "feature:hooks", "false")).toBeUndefined();
		expect(withSetting(file, "workflowSizeGuideline", "huge")).toBeUndefined();
	});
});

describe("/config panel", () => {
	it("decodes its keys and cycles a row's value round", () => {
		expect(decodeConfigKey("\x1b[A")).toBe("up");
		expect(decodeConfigKey("\x1b[B")).toBe("down");
		expect(decodeConfigKey("\r")).toBe("change");
		expect(decodeConfigKey(" ")).toBe("change");
		expect(decodeConfigKey("\x1b")).toBe("close");
		expect(nextValue({ id: "a", label: "A", description: "", currentValue: "unrestricted", values: ["small", "medium", "large", "unrestricted"] })).toBe("small");
	});

	it("draws the rows, the hints and the selected row's description", () => {
		const rows = configRows(view({}));
		const lines = renderConfig({ rows, cursor: 0, width: 100, saved: "~/.onecode/settings.json" }, plain);
		expect(lines).toContain(" ↑↓ to move · Enter/Space to change · Esc to close");
		expect(lines.some((line) => line.startsWith("❯ Session recap") && line.endsWith("true"))).toBe(true);
		expect(lines.some((line) => line.includes("Recap the session when you come back"))).toBe(true);
		for (const line of renderConfig({ rows, cursor: 2, width: 30, saved: "~/.onecode/settings.json", notice: "Could not save" }, plain)) expect(line.length).toBeLessThanOrEqual(30);
	});
});

describe("/config", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "config-command-"));
		stubHome(home);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	const settingsFile = () => productSettingsPath(home);
	const writeFile = (value: unknown) => {
		mkdirSync(dirname(settingsFile()), { recursive: true });
		writeFileSync(settingsFile(), JSON.stringify(value));
	};

	it("reads featuresOff leniently", () => {
		expect(readFeaturesOffSetting(home)).toEqual([]);
		writeFile({ featuresOff: ["recap", 3, " footer ", ""] });
		expect(readFeaturesOffSetting(home)).toEqual(["recap", "footer"]);
		writeFileSync(settingsFile(), "{ not json");
		expect(readFeaturesOffSetting(home)).toEqual([]);
	});

	it("saves each change as it is made, keeps other settings, and reports what changed", async () => {
		writeFile({ subagentModel: "openai/gpt-6" });
		const fake = createFakePi();
		configExtension(fake.pi as never);
		const reminders: Array<{ text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { text?: string }));
		let panel: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		const ctx = createFakeCtx({
			mode: "tui",
			hasUI: true,
			ui: {
				custom: (make: (...args: unknown[]) => typeof panel) =>
					new Promise<void>((resolve) => {
						panel = make({ requestRender: () => {} }, {}, {}, resolve);
					}),
			},
		});
		const result = fake.commands.get("config")?.handler("", ctx);
		await vi.waitFor(() => expect(panel).toBeDefined());
		panel?.handleInput("\r"); // Session recap → false
		expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ subagentModel: "openai/gpt-6", featuresOff: ["recap"] });
		expect(panel?.render(100).some((line) => line.startsWith("❯ Session recap") && line.endsWith("false"))).toBe(true);
		panel?.handleInput("\x1b");
		await result;
		// The model's breadcrumb names the change (lib/ui/local-command.ts).
		expect(reminders.some((r) => r.text === "<local-command-stdout>Session recap: false</local-command-stdout>\n")).toBe(true);
	});

	it("closes the panel before a contributed row's change opens its dialog, and reports the setting as it now is", async () => {
		const fake = createFakePi();
		configExtension(fake.pi as never);
		const order: string[] = [];
		fake.events.on(CONFIG_ROWS_CHANNEL, (data) => {
			(data as ConfigRowsQuery).rows.push(
				Promise.resolve({
					id: "externalIncludes",
					label: "External CLAUDE.md includes",
					description: "",
					currentValue: "false",
					values: ["true", "false"],
					opensDialog: (value: string) => value === "true",
					apply: async (value: string) => {
						order.push(`apply ${value}`);
						return `External CLAUDE.md includes: ${value}`;
					},
				}),
			);
		});
		const reminders: Array<{ text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { text?: string }));
		let panel: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		const ctx = createFakeCtx({
			mode: "tui",
			hasUI: true,
			ui: {
				custom: (make: (...args: unknown[]) => typeof panel) =>
					new Promise<void>((resolve) => {
						panel = make({ requestRender: () => {} }, {}, {}, () => {
							order.push("closed");
							resolve();
						});
					}),
			},
		});
		const result = fake.commands.get("config")?.handler("", ctx);
		await vi.waitFor(() => expect(panel).toBeDefined());
		const rows = panel?.render(100) ?? [];
		const at = rows.filter((line) => /^(❯ | {2})\S/.test(line)).findIndex((line) => line.includes("External CLAUDE.md includes"));
		for (let i = 0; i < at; i++) panel?.handleInput("\x1b[B");
		panel?.handleInput("\r");
		await result;
		expect(order).toEqual(["closed", "apply true"]);
		expect(reminders.some((r) => r.text === "<local-command-stdout>External CLAUDE.md includes: true</local-command-stdout>\n")).toBe(true);
	});

	it("names a settings file it cannot read and changes nothing", async () => {
		mkdirSync(dirname(settingsFile()), { recursive: true });
		writeFileSync(settingsFile(), "[1]");
		const fake = createFakePi();
		configExtension(fake.pi as never);
		const ctx = createFakeCtx({ mode: "tui", hasUI: true });
		await fake.commands.get("config")?.handler("", ctx);
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/settings\.json could not be read: .*root must be a JSON object/), "error");
		expect(readFileSync(settingsFile(), "utf8")).toBe("[1]");
	});
});
