import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { piDist, piTuiDist } from "./helpers/pi-install.ts";

/**
 * app/bin.mjs patches two pi prototypes and reads five unexported renderer
 * fields (the regular-mode clean-exit path and the suppressed "Operation
 * aborted" line). A pi pin bump that renames any of them would revert that UX
 * silently, so this pins their presence in the installed build. On failure:
 * re-verify the patch against the new pi source and update both bin.mjs and
 * this list.
 *
 * The FULLSCREEN half of the clean exit is no longer patched: pi 0.85.0 does
 * it natively when `fullscreenExitOutput` is not "transcript", and bin.mjs
 * seeds that setting instead. The last case below pins that native behavior,
 * because losing it would silently restore the transcript-dump exit.
 */
describe("app/bin.mjs pi-internal patch points (A3)", () => {
	it("InteractiveMode.prototype.stopInteractiveTui and AssistantMessageComponent.prototype.updateContent exist", async () => {
		const pi = (await import("@earendil-works/pi-coding-agent")) as unknown as {
			InteractiveMode: { prototype: Record<string, unknown> };
			AssistantMessageComponent: { prototype: Record<string, unknown> };
		};
		expect(typeof pi.InteractiveMode.prototype.stopInteractiveTui).toBe("function");
		expect(typeof pi.AssistantMessageComponent.prototype.updateContent).toBe("function");
	});

	it("the main-screen renderer still carries the fields the clean-exit patch reads", () => {
		// The regular-mode renderer (tui-main-screen.js) holds the scrollback fields;
		// the overlay API lives on the shared TUI class (tui.js).
		const renderer = readFileSync(join(piTuiDist, "tui-main-screen.js"), "utf8") + readFileSync(join(piTuiDist, "tui.js"), "utf8");
		for (const field of ["previousLines", "hardwareCursorRow", "previousViewportTop", "deleteKittyImages", "previousKittyImageIds"]) {
			expect(renderer, field).toContain(field);
		}
	});

	it("pi still exits fullscreen cleanly on its own, so bin.mjs need not patch that half", () => {
		const source = readFileSync(join(piDist, "modes", "interactive", "interactive-mode.js"), "utf8");
		// The repaint is now gated on the setting, and the stop preserves the
		// alt screen. Both halves must hold: gate without preserve still dumps.
		expect(source).toContain(`fullscreenExitOutput === "transcript"`);
		expect(source).toContain(`this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" })`);
	});

	it("pi still accepts the fullscreenExitOutput setting bin.mjs seeds", () => {
		const source = readFileSync(join(piDist, "core", "settings-manager.d.ts"), "utf8");
		expect(source).toContain("fullscreenExitOutput");
	});

	it("updateContent still keys the abort line off stopReason", () => {
		const source = readFileSync(join(piDist, "modes", "interactive", "components", "assistant-message.js"), "utf8");
		expect(source).toContain("updateContent");
		expect(source).toContain('"aborted"');
	});
});
