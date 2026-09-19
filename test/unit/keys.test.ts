import { describe, expect, it } from "vitest";
import { modeCycleKey, useWindowsKeybindings } from "../../extensions/lib/keys.ts";
import { installHint } from "../../extensions/lsp/install-hints.ts";

describe("useWindowsKeybindings (pi's rule, copied)", () => {
	it("is on for native Windows", () => {
		expect(useWindowsKeybindings("win32", {})).toBe(true);
	});
	it("is on for a WSL distro, off for plain Linux and macOS", () => {
		expect(useWindowsKeybindings("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
		expect(useWindowsKeybindings("linux", { WSL_INTEROP: "/run/WSL/1_interop" })).toBe(true);
		expect(useWindowsKeybindings("linux", {})).toBe(false);
		expect(useWindowsKeybindings("darwin", { WSL_DISTRO_NAME: "irrelevant" })).toBe(false);
	});
});

describe("modeCycleKey", () => {
	it("is ctrl+q where pi leaves it free", () => {
		expect(modeCycleKey("darwin", {})).toBe("ctrl+q");
		expect(modeCycleKey("linux", {})).toBe("ctrl+q");
	});
	it("is alt+m on Windows and WSL, where pi binds ctrl+q to queue-follow-up", () => {
		expect(modeCycleKey("win32", {})).toBe("alt+m");
		expect(modeCycleKey("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe("alt+m");
	});
});

describe("installHint", () => {
	it("names the platform's package manager for ripgrep", () => {
		expect(installHint("ripgrep", "darwin")).toBe("brew install ripgrep");
		expect(installHint("ripgrep", "win32")).toMatch(/^winget install /);
		expect(installHint("ripgrep", "linux")).toMatch(/^apt install ripgrep/);
	});
	it("never sends a Windows user to Homebrew", () => {
		expect(installHint("jdtls", "win32")).not.toMatch(/brew/);
		expect(installHint("jdtls", "win32")).toMatch(/eclipse\.org\/jdtls/);
	});
	it("falls back to a generic line for an unknown tool", () => {
		expect(installHint("frobnicate", "win32")).toBe("install frobnicate and make sure it is on your PATH");
	});
});
