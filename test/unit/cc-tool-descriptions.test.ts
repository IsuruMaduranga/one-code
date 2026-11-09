/**
 * Tool texts per tier and permission mode (lib/profile/tool-variants.ts,
 * decisions/system-prompt.md "Four registers"): frontier and workhorse carry
 * the short forms, cheap and tiny the long ones, and Bash's form also follows
 * whether the first request is in auto mode. The wiring tests check that a
 * tool is registered again only when its text changes, which is what keeps the
 * tools array byte-stable within a session. One Code's shipped texts are
 * locked in profile/test/cc-tool-descriptions-wording.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import askUserExtension from "../../extensions/ask-user/index.ts";
import bashExtension from "../../extensions/bash/index.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/lib/rules/modes.ts";
import toolStyleExtension from "../../extensions/tool-style/index.ts";
import webSearchExtension from "../../extensions/web/index.ts";
import webFetchExtension from "../../extensions/web-fetch/index.ts";
import { descriptionForm, registerVariantTool } from "../../extensions/lib/profile/tool-variants.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

/** The profile's bash description for a form, the permission mode and the search-tools pointer. */
const bashText = (form: "short" | "long", autoMode: boolean, searchTools = false) => requireText("shell").bashDescription({ form, autoMode, searchTools });

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("description form by tier", () => {
	it("gives frontier and workhorse the short forms, cheap and tiny the long ones", () => {
		expect(descriptionForm("frontier")).toBe("short");
		expect(descriptionForm("workhorse")).toBe("short");
		expect(descriptionForm("cheap")).toBe("long");
		expect(descriptionForm("tiny")).toBe("long");
	});
});

/** A stand-in session model; CC_PROMPT_TIER picks the tier. */
const someModel = { provider: "openai", id: "gpt-test", name: "gpt-test", input: ["text"], cost: { input: 1, output: 4 } };

async function switchTier(fake: FakePi, tier: string) {
	vi.stubEnv("CC_PROMPT_TIER", tier);
	await fake.fire("model_select", { type: "model_select", model: someModel, previousModel: undefined, source: "set" });
}

/** Counts registrations per tool name, so a test sees a re-registration. */
function countRegistrations(fake: FakePi): Map<string, number> {
	const counts = new Map<string, number>();
	const register = fake.pi.registerTool as (tool: { name: string }) => void;
	fake.pi.registerTool = (tool: { name: string }) => {
		counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
		register(tool);
	};
	return counts;
}

describe("switching forms mid-session", () => {
	it.each([["plan", "auto"], ["auto", "plan"]])("bash follows a %s → %s switch: an epoch renders the live form, and inside one the ledger keeps the recorded definition", async (from, to) => {
		vi.stubEnv("CC_PROMPT_TIER", "workhorse");
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: from, paused: false });
		await fake.fire("session_start", {}, createFakeCtx({ model: someModel }));
		const before = fake.tools.get("bash")!.description;
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: to, paused: false });
		expect(fake.tools.get("bash")!.description).not.toBe(before);
		expect(fake.tools.get("bash")!.description).toBe(bashText("short", to === "auto"));
		vi.unstubAllEnvs();
	});

	it("bash follows the tier and the initial permission mode, and re-registers only on a change", async () => {
		const fake = createFakePi();
		const counts = countRegistrations(fake);
		bashExtension(fake.pi as never);
		expect(fake.tools.get("bash")!.description).toBe(bashText("short", false));

		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "auto", paused: false });
		expect(fake.tools.get("bash")!.description).toBe(bashText("short", true));
		// The badge re-announces the mode on every turn: no new registration.
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "auto", paused: false });
		await switchTier(fake, "frontier");
		expect(counts.get("bash")).toBe(2);

		await switchTier(fake, "cheap");
		expect(fake.tools.get("bash")!.description).toBe(bashText("long", true));
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "default", paused: false });
		expect(fake.tools.get("bash")!.description).toBe(bashText("long", false));
		// A profile whose long form ignores the mode is not registered again.
		expect(counts.get("bash")).toBe(bashText("long", true) === bashText("long", false) ? 3 : 4);

		await switchTier(fake, "workhorse");
		expect(fake.tools.get("bash")!.description).toBe(bashText("short", false));
	});

	it("the form is applied at session start from the session's model", async () => {
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		vi.stubEnv("CC_PROMPT_TIER", "tiny");
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, createFakeCtx({ model: someModel }));
		expect(fake.tools.get("bash")!.description).toBe(bashText("long", false, true));
	});

	it("on tiny, the long form asks for the search-tools pointer; cheap does not", async () => {
		const fake = createFakePi();
		bashExtension(fake.pi as never);
		await switchTier(fake, "tiny");
		expect(fake.tools.get("bash")!.description).toBe(bashText("long", false, true));
		await switchTier(fake, "cheap");
		expect(fake.tools.get("bash")!.description).toBe(bashText("long", false));
	});

	it.each([
		["ask_user_question", askUserExtension, (form: "short" | "long") => requireText("askUser").description(form)],
		["web_fetch", webFetchExtension, (form: "short" | "long") => requireText("webFetch").description(form)],
		["web_search", webSearchExtension, (form: "short" | "long") => requireText("webSearch").description(form)],
		["write", toolStyleExtension, (form: "short" | "long") => requireText("toolStyle").writeDescription(form)],
	] as const)("%s carries the short form, then the long one on a cheap model", async (name, extension, text) => {
		const short = text("short");
		const long = text("long");
		const fake = createFakePi();
		(extension as (pi: never) => void)(fake.pi as never);
		expect(fake.tools.get(name)!.description).toBe(short);
		await switchTier(fake, "cheap");
		expect(fake.tools.get(name)!.description).toBe(long);
		await switchTier(fake, "frontier");
		expect(fake.tools.get(name)!.description).toBe(short);
	});

	it("tool-style leaves read and edit with pi's own descriptions", async () => {
		const fake = createFakePi();
		toolStyleExtension(fake.pi as never);
		const before = { read: fake.tools.get("read")!.description, edit: fake.tools.get("edit")!.description };
		await switchTier(fake, "tiny");
		expect(fake.tools.get("read")!.description).toBe(before.read);
		expect(fake.tools.get("edit")!.description).toBe(before.edit);
		expect(before.read).toMatch(/^Read the contents of a file/);
	});

	it("registerVariantTool keeps the rest of the definition", () => {
		const fake = createFakePi();
		const execute = vi.fn();
		const set = registerVariantTool<string>(fake.pi as never, "a", (v: string) => ({ name: "probe", label: "Probe", description: v, parameters: {} as never, execute }) as never);
		set("b");
		expect(fake.tools.get("probe")!.description).toBe("b");
		expect(fake.tools.get("probe")!.execute).toBe(execute);
	});
});
