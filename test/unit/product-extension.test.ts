/**
 * A product's own extensions (working-docs/decisions/bi-fork.md): the main
 * session loads `profile/extensions/<name>/index.ts` through the manifest's
 * last entry, and each reaches the request only through the channels
 * `extensions/sdk/extension.ts` re-exports. One Code ships none, so the
 * loading cases run in the base suite, on the fixture profile's `probe`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHILD_EXTENSIONS, LAST_CHILD_EXTENSION } from "../../extensions/lib/agents/child-extensions.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { PRODUCT_EXTENSIONS_DIR, PRODUCT_EXTENSIONS_ENTRY } from "../../extensions/lib/profile/features.ts";
import { PROFILE_DIR } from "../../extensions/lib/profile/profile.ts";
import { redactSecretValues } from "../../extensions/lib/profile/secrets.ts";
import * as sdk from "../../extensions/sdk/extension.ts";
import { DEFER_CHANNEL, REMINDER_CHANNEL, SYSTEM_PROMPT_SECTION_CHANNEL, type SystemPromptSection } from "../../extensions/sdk/extension.ts";
import { sessionModelTier } from "../../extensions/lib/models/session-model-tier.ts";
import { tiersBelow } from "../../extensions/lib/models/model-tier.ts";
import { queueNotice } from "../../extensions/lib/notify/notices.ts";
import { notifyOrPrint } from "../../extensions/lib/notify/headless-output.ts";
import { LSP_FILES_CHANGED_CHANNEL, type LspFilesChangedEvent } from "../../extensions/tools/lsp/request-channel.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { deferralChanges } from "./helpers/tool-mentions.ts";

const root = join(PROFILE_DIR, PRODUCT_EXTENSIONS_DIR);
const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
const probe = join(root, "probe", "index.ts");

describe("a product's own extensions", () => {
	// A stubbed tier or state folder never outlives its test, a failing one included.
	afterEach(() => vi.unstubAllEnvs());

	it("sit where the manifest's product entry looks", () => {
		expect(PRODUCT_EXTENSIONS_ENTRY).toBe("profile/extensions/*/index.ts");
		// pi's glob skips dot folders; any other folder without an index.ts
		// would hold an extension the main session silently never loads.
		for (const name of folders.filter((name) => !name.startsWith("."))) expect(existsSync(join(root, name, "index.ts")), name).toBe(true);
	});

	it("announce a prompt section only to the main session: a child has no listener", () => {
		// A child sends its agent's own prompt, or as a fork the parent's (which
		// already carries the section), so the system-prompt extension never
		// loads there and an announcement in a child is ignored.
		expect([...CHILD_EXTENSIONS, LAST_CHILD_EXTENSION].some((entry) => entry.startsWith("request/system-prompt/"))).toBe(false);
	});

	it.skipIf(!existsSync(probe))("the fixture's probe reaches the request through the SDK's channels", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TOOL: string; PROBE_SECTION: string; PROBE_SECTION_TOOL: string; PROBE_REMINDER: string; PROBE_SECRET: string };
		const fake = createFakePi();
		const seen = { deferred: [] as unknown[], sections: [] as SystemPromptSection[], reminders: [] as unknown[] };
		fake.events.on(DEFER_CHANNEL, (data) => seen.deferred.push(data));
		fake.events.on(SYSTEM_PROMPT_SECTION_CHANNEL, (data) => seen.sections.push(data as SystemPromptSection));
		fake.events.on(REMINDER_CHANNEL, (data) => seen.reminders.push(data));
		// A tier at the probe's floor: no notice joins the session_start handlers' work below.
		vi.stubEnv(envName("PROMPT_TIER"), "frontier");
		module.default(fake.pi as never);
		expect(fake.tools.has(module.PROBE_TOOL)).toBe(true);
		// The base's rows in the terminal, through the SDK.
		expect(fake.tools.get(module.PROBE_TOOL)?.renderShell).toBe("self");
		expect(seen.deferred).toEqual([{ name: module.PROBE_TOOL }]);
		// The section cuts the passage naming its tool when the session cannot have it, whatever the active list says.
		const rendered = (has: boolean) => seen.sections.map((section) => [section.place, section.render({ tier: "cheap", taskTools: false, tools: [], live: { has: () => has } })]);
		expect(rendered(true)).toEqual([["tail", `${module.PROBE_SECTION}${module.PROBE_SECTION_TOOL}`]]);
		expect(rendered(false)).toEqual([["tail", module.PROBE_SECTION]]);
		expect(deferralChanges((session) => seen.sections[0].render(session), { deferred: [module.PROBE_TOOL] })).toEqual([]);
		expect(redactSecretValues(`out: ${module.PROBE_SECRET}`)).toBe("out: [secret:fixture]");
		// The reminder waits for the session: nothing is queued while extensions load.
		expect(seen.reminders).toEqual([]);
		for (const handler of fake.handlers.get("session_start") ?? []) await handler({}, {});
		expect(seen.reminders).toEqual([expect.objectContaining({ text: module.PROBE_REMINDER, placement: "last-append" })]);
	});

	it("offer the session's tier and the notice helpers the base itself uses", () => {
		// The same functions, so a product's tier is the one the request was built for and its notices join the base's.
		expect([sdk.sessionModelTier, sdk.tiersBelow, sdk.queueNotice, sdk.notifyOrPrint]).toEqual([sessionModelTier, tiersBelow, queueNotice, notifyOrPrint]);
		expect(sdk.tiersBelow("cheap", "workhorse")).toBe(1);
	});

	it.skipIf(!existsSync(probe))("the fixture's probe tells the user when the session model sits below its tier, in the TUI and in print mode", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TIER_NOTICE: string };
		const start = async (tier: string, hasUI: boolean) => {
			vi.stubEnv(envName("PROMPT_TIER"), tier);
			const fake = createFakePi();
			module.default(fake.pi as never);
			const notices: Array<[string, string]> = [];
			await fake.fire("session_start", {}, createFakeCtx({ hasUI, ui: { notify: (text: string, level: string) => notices.push([text, level]) } }));
			// The lifecycle notices close their batch on the next macrotask.
			await new Promise((resolve) => setTimeout(resolve, 0));
			return notices;
		};
		const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(await start("cheap", true)).toEqual([[module.PROBE_TIER_NOTICE, "warning"]]);
			expect(await start("workhorse", true)).toEqual([]);
			expect(await start("tiny", false)).toEqual([]);
			expect(stderr).toHaveBeenCalledWith(module.PROBE_TIER_NOTICE);
		} finally {
			stderr.mockRestore();
			vi.unstubAllEnvs();
		}
	});

	it.skipIf(!existsSync(probe))("the fixture's probe writes into the product's state folder and opens it, or says why not", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_COMMAND: string };
		const fake = createFakePi();
		module.default(fake.pi as never);
		const state = mkdtempSync(join(tmpdir(), "probe-state-"));
		// The state-dir variable moves the folder; an SSH session means no browser is started.
		vi.stubEnv(envName("STATE_DIR"), state);
		vi.stubEnv("SSH_CONNECTION", "10.0.0.1 1 10.0.0.2 22");
		try {
			const notices: Array<[string, string]> = [];
			await fake.commands.get(module.PROBE_COMMAND)!.handler("", createFakeCtx({ ui: { notify: (text: string, level: string) => notices.push([text, level]) } }));
			const page = join(state, "fixture-probe", "page.html");
			expect(readFileSync(page, "utf8")).toBe("<p>[fixture:probe-page]</p>\n");
			expect(notices).toEqual([[`[fixture:no-browser:ssh] ${page}`, "warning"]]);
		} finally {
			vi.unstubAllEnvs();
			rmSync(state, { recursive: true, force: true });
		}
	});

	it.skipIf(!existsSync(probe))("the fixture's probe reports the file its tool writes to the language server", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TOOL: string; PROBE_FILE: string };
		const fake = createFakePi();
		const reports: LspFilesChangedEvent[] = [];
		fake.events.on(LSP_FILES_CHANGED_CHANNEL, (data) => {
			const report = data as LspFilesChangedEvent;
			reports.push(report);
			report.reply(Promise.resolve());
		});
		module.default(fake.pi as never);
		const cwd = mkdtempSync(join(tmpdir(), "probe-"));
		try {
			await fake.tools.get(module.PROBE_TOOL)!.execute("t", {}, undefined, undefined, createFakeCtx({ cwd }));
			const path = join(cwd, module.PROBE_FILE);
			expect(readFileSync(path, "utf8")).toBe("[fixture:probe-file]\n");
			expect(reports.map(({ server, changes }) => ({ server, changes }))).toEqual([{ server: "fixture", changes: [{ path, type: "created" }] }]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
