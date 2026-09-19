/**
 * Turn a language-server spawn failure into an actionable message.
 *
 * A missing binary (spawn ENOENT) is the common, fixable case: the built-in
 * table assumes its servers are on PATH, and Claude Code LSP plugins ship
 * config only — never the binary (findings §18.3). The raw
 * "spawn pyright-langserver ENOENT" tells the user nothing about what to do,
 * so it is rewritten here with the install command when we know it, and with
 * PATH/plugin guidance when we don't. Every other failure passes through
 * unchanged. Enrichment happens once, where the failure is recorded, so the
 * one-time warning, /lsp, and the lsp_diagnostics tool all show the same text.
 */

import { isAbsolute } from "node:path";

/**
 * Tools that come from the OS package manager, by platform. Homebrew is a
 * macOS answer; a Windows user needs winget (the doctor said `brew install
 * ripgrep` on Windows until 2026-09-19), a Linux user their distro's manager.
 */
const PACKAGE_MANAGER_HINTS: Record<string, { darwin: string; win32: string; linux: string }> = {
	ripgrep: { darwin: "brew install ripgrep", win32: "winget install BurntSushi.ripgrep.MSVC", linux: "apt install ripgrep (or your distribution's package manager)" },
	jdtls: { darwin: "brew install jdtls", win32: "download from https://download.eclipse.org/jdtls/ and put its bin\\jdtls.bat on PATH", linux: "download from https://download.eclipse.org/jdtls/ and put its bin/jdtls on PATH" },
};

/** The install command for a package-manager tool on `platform` (defaults to this one). */
export function installHint(tool: string, platform: string = process.platform): string {
	const byPlatform = PACKAGE_MANAGER_HINTS[tool];
	if (!byPlatform) return `install ${tool} and make sure it is on your PATH`;
	return platform === "win32" ? byPlatform.win32 : platform === "darwin" ? byPlatform.darwin : byPlatform.linux;
}

/**
 * The install command for a built-in server on `platform`: the package-manager
 * ones (jdtls) per platform, the rest as in `INSTALL_HINTS`. The doctor
 * renders a report for an injected platform, so it must not read the
 * module-load default frozen into `INSTALL_HINTS`.
 */
export function serverInstallHint(command: string, platform: string = process.platform): string | undefined {
	return PACKAGE_MANAGER_HINTS[command] ? installHint(command, platform) : INSTALL_HINTS[command];
}

/** Install commands for the built-in table's servers (and their npm siblings). */
export const INSTALL_HINTS: Record<string, string> = {
	"typescript-language-server": "npm install -g typescript-language-server (and typescript 5.x in the project: npm install -D typescript@5 — the server never uses a global TypeScript)",
	"pyright-langserver": "npm install -g pyright",
	gopls: "go install golang.org/x/tools/gopls@latest",
	"rust-analyzer": "rustup component add rust-analyzer",
	jdtls: installHint("jdtls"),
};

/** True when the failure is a spawn ENOENT — the binary itself is absent. */
export function isMissingBinary(failure: string): boolean {
	return /\bENOENT\b/.test(failure);
}

/**
 * Rewrite a missing-binary failure into install guidance; return anything
 * else verbatim. `pluginName` is set when a plugin's config (not the built-in
 * table) named the command.
 */
export function describeStartFailure(rawFailure: string, command: string, pluginName?: string): string {
	if (!isMissingBinary(rawFailure)) return rawFailure;
	const from = pluginName ? ` (configured by the ${pluginName} plugin)` : "";
	const hint = INSTALL_HINTS[command];
	if (hint) return `${command} is not installed${from}. Install it with: ${hint}`;
	if (isAbsolute(command)) {
		return `${command} does not exist${from}. ${pluginName ? "Check the plugin's installation." : "Check the configured path."}`;
	}
	const docs = pluginName ? " (the plugin's documentation should say how)" : "";
	return `${command} is not installed${from}. Install it and make sure it is on your PATH${docs}.`;
}
