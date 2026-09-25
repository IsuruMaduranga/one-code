/**
 * Keys that depend on the platform.
 *
 * pi rebinds a handful of its own shortcuts on Windows and WSL, where
 * alt+enter and ctrl+shift+letter do not reach the process reliably: queue
 * follow-up moves from alt+enter to ctrl+q, fork from ctrl+shift+f to ctrl+f,
 * paste to alt+v, model select to alt+p (pi-coding-agent core/keybindings.js,
 * `useWindowsKeybindings`, which pi does not export — the rule is copied
 * here). So the ctrl+q that cycles permission modes everywhere else collides
 * there: pi skips a `registerShortcut` on a built-in key with a startup
 * warning, and mode cycling had no key at all on Windows (seen on the Vultr
 * VM, 2026-09-19). No ctrl+letter is free on Windows once pi's app and editor
 * bindings are counted, and pi itself reaches for alt there, so mode cycling
 * is alt+m on Windows and WSL — working-docs/decisions/windows.md.
 */

/** pi's rule for its Windows key table: native Windows, or a WSL distro. */
export function useWindowsKeybindings(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
	return platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
}

/** The key that cycles permission modes: ctrl+q, or alt+m where pi owns ctrl+q. */
export function modeCycleKey(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): "ctrl+q" | "alt+m" {
	return useWindowsKeybindings(platform, env) ? "alt+m" : "ctrl+q";
}

/**
 * The key that shows or hides the pinned task list. Claude Code uses ctrl+t,
 * which pi reserves for its thinking-block toggle (an extension shortcut on a
 * reserved key is skipped), so One Code uses alt+t, free in pi's key tables
 * on every platform.
 */
export const TASKS_TOGGLE_KEY = "alt+t";

/**
 * The footer badge's pause icon. Claude Code's is U+23F8 (⏸); Windows Terminal
 * draws that code point with its emoji font, two cells wide and coloured,
 * while pi measures one cell, so the icon overlapped the mode name — and the
 * text-presentation selector (U+FE0E) is ignored there (verified on the Vultr
 * VM, 2026-09-19: rows A and B of the width test). U+2016 (‖) is a plain
 * single-cell glyph in Windows Terminal, so it stands in on Windows and WSL,
 * where the terminal is Windows Terminal either way.
 */
export function pauseGlyph(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): "⏸" | "‖" {
	return useWindowsKeybindings(platform, env) ? "‖" : "⏸";
}
