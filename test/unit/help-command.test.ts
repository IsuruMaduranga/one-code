/**
 * `/help`: the command list comes from the slash menu's provider in the TUI
 * (so it matches the menu row for row), custom commands are the user's
 * command files, and RPC gets the same content as text. It records nothing:
 * no breadcrumb reaches the next request.
 */
import { describe, expect, it, vi } from "vitest";
import helpExtension from "../../extensions/commands/help/index.ts";
import { EDITOR_KEYS_CHANNEL, type EditorKeysQuery } from "../../extensions/lib/ui/editor-conveniences.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const commands = [
	{ name: "btw", description: "Ask a side question", source: "extension" },
	{ name: "review-file", description: "Review a file", source: "prompt" },
];

function setup() {
	const fake = createFakePi();
	fake.pi.getCommands = () => commands;
	helpExtension(fake.pi as never);
	return fake;
}

describe("/help", () => {
	it("prints shortcuts and commands as text in RPC", async () => {
		const fake = setup();
		const ctx = createFakeCtx({ mode: "rpc", hasUI: true });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await fake.commands.get("help")?.handler("", ctx);
		const ui = ctx.ui as { notify: ReturnType<typeof vi.fn>; custom: ReturnType<typeof vi.fn>; addAutocompleteProvider: ReturnType<typeof vi.fn> };
		expect(ui.custom).not.toHaveBeenCalled();
		expect(ui.addAutocompleteProvider).not.toHaveBeenCalled();
		const text = ui.notify.mock.calls[0]?.[0] as string;
		expect(text).toContain("Shortcuts:");
		expect(text).toContain("Commands:\n  /btw - Ask a side question");
		expect(text).toContain("Custom commands:\n  /review-file - Review a file");
		expect(fake.sentMessages).toEqual([]);
		expect(fake.appendedEntries).toEqual([]);
	});

	it("lists exactly the editor keys the prompt editor reports, and none without its answer", async () => {
		const helpText = async (answer?: EditorKeysQuery["keys"]) => {
			const fake = setup();
			if (answer) fake.events.on(EDITOR_KEYS_CHANNEL, (data: unknown) => ((data as EditorKeysQuery).keys = answer));
			const ctx = createFakeCtx({ mode: "rpc", hasUI: true });
			await fake.commands.get("help")?.handler("", ctx);
			return (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify.mock.calls[0]?.[0] as string;
		};
		// The user bound ctrl+r in pi: the editor reports only its stash key.
		const stashOnly = await helpText({ stash: "ctrl+s" });
		expect(stashOnly).toContain("ctrl+s to stash prompt");
		expect(stashOnly).not.toContain("to search history");
		const none = await helpText();
		expect(none).not.toContain("to stash prompt");
		expect(none).not.toContain("to search history");
		expect(none).not.toContain("to clear input");
	});

	it("lists the slash menu's own rows in the TUI panel", async () => {
		const fake = setup();
		let wrapper: ((current: unknown) => unknown) | undefined;
		let factory: ((...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) | undefined;
		const ctx = createFakeCtx({
			mode: "tui",
			hasUI: true,
			ui: {
				addAutocompleteProvider: (wrap: (current: unknown) => unknown) => (wrapper = wrap),
				custom: (make: typeof factory) => {
					factory = make;
					return Promise.resolve(null);
				},
			},
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const menu = {
			getSuggestions: async () => ({ prefix: "/", items: [{ value: "btw", label: "/btw", description: "Side question" }, { value: "review-file", label: "/review-file", description: "Review a file" }, { value: "settings", label: "/settings", description: "Open settings menu" }] }),
			applyCompletion: () => ({ lines: [""], cursorLine: 0, cursorCol: 0 }),
		};
		expect(wrapper?.(menu)).toBe(menu);
		await fake.commands.get("help")?.handler("", ctx);
		const tui = { requestRender: () => {}, terminal: { rows: 40 } };
		const panel = factory?.(tui, {}, {}, () => {});
		panel?.handleInput("\x1b[C");
		const lines = panel?.render(100) ?? [];
		expect(lines.some((line) => line.includes("/settings") && line.includes("Open settings menu"))).toBe(true);
		// The user's command file is on the Custom commands tab, not this one.
		expect(lines.some((line) => line.includes("/review-file"))).toBe(false);
	});
});
