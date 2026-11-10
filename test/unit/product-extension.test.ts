/**
 * A product's own extensions (working-docs/decisions/bi-fork.md): the main
 * session loads `profile/extensions/<name>/index.ts` through the manifest's
 * last entry, and each reaches the request only through the channels
 * `extensions/sdk/extension.ts` re-exports. One Code ships none, so the
 * loading cases run in the base suite, on the fixture profile's `probe`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CHILD_EXTENSIONS } from "../../extensions/lib/agents/child-extensions.ts";
import { PRODUCT_EXTENSIONS_DIR, PRODUCT_EXTENSIONS_ENTRY } from "../../extensions/lib/profile/features.ts";
import { PROFILE_DIR } from "../../extensions/lib/profile/profile.ts";
import { redactSecrets } from "../../extensions/lib/profile/secrets.ts";
import { DEFER_CHANNEL, REMINDER_CHANNEL, SYSTEM_PROMPT_SECTION_CHANNEL, type SystemPromptSection } from "../../extensions/sdk/extension.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const root = join(PROFILE_DIR, PRODUCT_EXTENSIONS_DIR);
const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
const probe = join(root, "probe", "index.ts");

describe("a product's own extensions", () => {
	it("sit where the manifest's product entry looks", () => {
		expect(PRODUCT_EXTENSIONS_ENTRY).toBe(`profile/${PRODUCT_EXTENSIONS_DIR}/*/index.ts`);
		// pi's glob skips dot folders; any other folder without an index.ts
		// would hold an extension the main session silently never loads.
		for (const name of folders.filter((name) => !name.startsWith("."))) expect(existsSync(join(root, name, "index.ts")), name).toBe(true);
	});

	it("announce a prompt section only to the main session: a child has no listener", () => {
		// A child sends its agent's own prompt, or as a fork the parent's (which
		// already carries the section), so the system-prompt extension never
		// loads there and an announcement in a child is ignored.
		expect(CHILD_EXTENSIONS.some((entry) => entry.startsWith("request/system-prompt/"))).toBe(false);
	});

	it.skipIf(!existsSync(probe))("the fixture's probe reaches the request through the SDK's channels", async () => {
		const module = (await import(pathToFileURL(probe).href)) as { default: (pi: never) => void; PROBE_TOOL: string; PROBE_SECTION: string; PROBE_REMINDER: string; PROBE_SECRET: string };
		const fake = createFakePi();
		const seen = { deferred: [] as unknown[], sections: [] as SystemPromptSection[], reminders: [] as unknown[] };
		fake.events.on(DEFER_CHANNEL, (data) => seen.deferred.push(data));
		fake.events.on(SYSTEM_PROMPT_SECTION_CHANNEL, (data) => seen.sections.push(data as SystemPromptSection));
		fake.events.on(REMINDER_CHANNEL, (data) => seen.reminders.push(data));
		module.default(fake.pi as never);
		expect(fake.tools.has(module.PROBE_TOOL)).toBe(true);
		// The base's rows in the terminal, through the SDK.
		expect(fake.tools.get(module.PROBE_TOOL)?.renderShell).toBe("self");
		expect(seen.deferred).toEqual([{ name: module.PROBE_TOOL }]);
		expect(seen.sections.map((section) => [section.place, section.render({ tier: "cheap", taskTools: false, tools: undefined })])).toEqual([["tail", module.PROBE_SECTION]]);
		expect(redactSecrets(`out: ${module.PROBE_SECRET}`)).toBe("out: [secret:fixture]");
		// The reminder waits for the session: nothing is queued while extensions load.
		expect(seen.reminders).toEqual([]);
		for (const handler of fake.handlers.get("session_start") ?? []) await handler({}, {});
		expect(seen.reminders).toEqual([expect.objectContaining({ text: module.PROBE_REMINDER, placement: "last-append" })]);
	});
});
