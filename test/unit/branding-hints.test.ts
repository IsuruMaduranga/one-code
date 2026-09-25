import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARGUMENT_HINT_CHANNEL } from "../../extensions/lib/argument-hints.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

// The editor itself is not under test: capture the hint renderer it is given.
let renderHint: ((text: string) => string | undefined) | undefined;
vi.mock("../../extensions/branding/prompt-editor.ts", () => ({
	PROMPT_PADDING: 2,
	PromptEditor: class {
		constructor(_tui: unknown, _theme: unknown, _keybindings: unknown, _marker: unknown, hint: (text: string) => string | undefined) {
			renderHint = hint;
		}
	},
}));
const { default: brandingExtension } = await import("../../extensions/branding/index.ts");

describe("branding argument hints", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		renderHint = undefined;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a built-in or extension command's hint over a same-named command file's", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "branding-hints-"));
		dirs.push(agentDir);
		mkdirSync(join(agentDir, "prompts"));
		const template = (name: string, hint: string) => writeFileSync(join(agentDir, "prompts", `${name}.md`), `---\nargument-hint: "${hint}"\n---\nbody\n`);
		template("onecode-hint-announced", "[file]");
		template("onecode-hint-extension", "[file]");
		template("onecode-hint-file", "[mine]");
		template("model", "[file]");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("CC_NO_BANNER", "1");

		const fake = createFakePi();
		const extension = (name: string) => ({ name, source: "extension", sourceInfo: { path: `${name}.ts` } });
		(fake.pi as { getCommands: () => unknown[] }).getCommands = () => [extension("onecode-hint-announced"), extension("onecode-hint-extension")];
		brandingExtension(fake.pi as never);
		// An extension announces its hint at load, before the templates are scanned.
		fake.events.emit(ARGUMENT_HINT_CHANNEL, { command: "onecode-hint-announced", hint: "[question]" });
		let factory: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined;
		const ctx = createFakeCtx({ hasUI: true, mode: "tui", cwd: agentDir });
		(ctx.ui as { setEditorComponent: unknown }).setEditorComponent = (f: typeof factory) => (factory = f);
		await fake.fire("session_start", {}, ctx);
		factory!(undefined, undefined, undefined);

		expect(renderHint!("/onecode-hint-announced ")).toBe("[question]");
		// An extension command with no hint of its own shows none, not the file's.
		expect(renderHint!("/onecode-hint-extension ")).toBeUndefined();
		expect(renderHint!("/model ")).toBe("[model]");
		expect(renderHint!("/onecode-hint-file ")).toBe("[mine]");
	});
});
