/**
 * The `/sandbox` panel (pure): Claude Code's three tabs. Mode picks whether
 * commands run in the sandbox and whether a sandboxed one still prompts;
 * Overrides picks whether the model may ask to run a command outside it;
 * Config shows the rules in force. A pick is an edit to the user's own
 * settings file (`applySandboxPick`); the wiring writes it and reads the
 * settings again. The key hints are on screen (a hidden key is an
 * undiscoverable key).
 */

import { isPlainObject } from "../../lib/core/plain-object.ts";
import type { SandboxSettings } from "../../lib/shell-run/sandbox-settings.ts";
import { keyId, keyText } from "../../lib/ui/key-input.ts";
import { panelTopRule, wrapHints, wrapProse } from "../../lib/ui/tui-render.ts";

export type SandboxTab = "mode" | "overrides" | "config";
export type SandboxMode = "auto-allow" | "regular" | "off";
export type SandboxOverride = "fallback" | "strict";
export type SandboxPick = { tab: "mode"; value: SandboxMode } | { tab: "overrides"; value: SandboxOverride };

const TABS: readonly { id: SandboxTab; label: string }[] = [
	{ id: "mode", label: "Mode" },
	{ id: "overrides", label: "Overrides" },
	{ id: "config", label: "Config" },
];

const MODES: readonly { value: SandboxMode; label: string }[] = [
	{ value: "auto-allow", label: "Sandbox commands, with auto-allow" },
	{ value: "regular", label: "Sandbox commands, with regular permissions" },
	{ value: "off", label: "No sandbox" },
];

const OVERRIDES: readonly { value: SandboxOverride; label: string }[] = [
	{ value: "fallback", label: "Allow unsandboxed fallback" },
	{ value: "strict", label: "Strict sandbox mode" },
];

const MODE_HELP = [
	"Auto-allow mode: Bash commands run in the sandbox without a prompt in default and acceptEdits modes, and a command that leaves the sandbox falls back to regular permissions. Explicit ask and deny rules are always respected.",
	"Turning the sandbox on or off applies from the next start.",
];

const OVERRIDES_HELP = [
	"Allow unsandboxed fallback: When a command fails due to sandbox restrictions, the model can retry it with dangerouslyDisableSandbox to run outside the sandbox (falling back to regular permissions).",
	"Strict sandbox mode: All commands invoked by the model must run in the sandbox unless they are explicitly listed in excludedCommands.",
];

/** The mode the settings amount to. */
export const sandboxModeOf = (settings: Pick<SandboxSettings, "enabled" | "autoAllowBashIfSandboxed">): SandboxMode => (!settings.enabled ? "off" : settings.autoAllowBashIfSandboxed ? "auto-allow" : "regular");

/** The override the settings amount to. */
export const sandboxOverrideOf = (settings: Pick<SandboxSettings, "allowUnsandboxedCommands">): SandboxOverride => (settings.allowUnsandboxedCommands ? "fallback" : "strict");

export interface SandboxPanelState {
	tab: SandboxTab;
	/** The highlighted row of the Mode or Overrides list. */
	row: number;
	/** The first Config line shown. */
	offset: number;
	/** The Config tab's rows at the last render (its lines wrap), for the scroll bound. */
	configRows?: number;
}

/** The panel as it opens: on the Mode tab, the current mode highlighted. */
export function openSandboxPanel(settings: SandboxSettings): SandboxPanelState {
	return { tab: "mode", row: MODES.findIndex((mode) => mode.value === sandboxModeOf(settings)), offset: 0 };
}

export type SandboxPanelKey = "up" | "down" | "left" | "right" | "select" | "close";

export function decodeSandboxPanelKey(data: string): SandboxPanelKey | undefined {
	switch (keyId(data)) {
		case "up":
			return "up";
		case "down":
			return "down";
		case "left":
		case "shift+tab":
			return "left";
		case "right":
		case "tab":
			return "right";
		case "enter":
			return "select";
		case "escape":
		case "ctrl+c":
			return "close";
		default:
			break;
	}
	switch (keyText(data)) {
		case "k":
			return "up";
		case "j":
			return "down";
		case "q":
			return "close";
		default:
			return undefined;
	}
}

export type SandboxPanelEffect = { kind: "pick"; pick: SandboxPick } | { kind: "close" };

const rowsOf = (tab: SandboxTab): number => (tab === "mode" ? MODES.length : tab === "overrides" ? OVERRIDES.length : 0);

/**
 * Move within the panel; returns an effect for keys the wiring acts on.
 * `current` gives the row a tab opens on; `visible` is the Config tab's body
 * height, which bounds its scroll.
 */
export function applySandboxPanelKey(state: SandboxPanelState, key: SandboxPanelKey, current: { mode: SandboxMode; override: SandboxOverride }, visible: number): SandboxPanelEffect | undefined {
	const switchTab = (step: number) => {
		const next = TABS[(TABS.findIndex((tab) => tab.id === state.tab) + step + TABS.length) % TABS.length].id;
		state.tab = next;
		state.offset = 0;
		state.row = next === "mode" ? MODES.findIndex((mode) => mode.value === current.mode) : next === "overrides" ? OVERRIDES.findIndex((entry) => entry.value === current.override) : 0;
	};
	switch (key) {
		case "left":
			switchTab(-1);
			return undefined;
		case "right":
			switchTab(1);
			return undefined;
		case "close":
			return { kind: "close" };
		case "up":
		case "down": {
			const step = key === "up" ? -1 : 1;
			if (state.tab === "config") state.offset = Math.max(0, Math.min(Math.max(0, (state.configRows ?? 0) - visible), state.offset + step));
			else state.row = Math.max(0, Math.min(rowsOf(state.tab) - 1, state.row + step));
			return undefined;
		}
		case "select":
			if (state.tab === "mode") return { kind: "pick", pick: { tab: "mode", value: MODES[state.row].value } };
			if (state.tab === "overrides") return { kind: "pick", pick: { tab: "overrides", value: OVERRIDES[state.row].value } };
			return undefined;
	}
}

/** Rows taken by the top rule, the tab row, the blank under it, the blank above the hints and a one-line hint row. */
export const SANDBOX_PANEL_CHROME_ROWS = 5;

export interface SandboxPanelInput {
	state: SandboxPanelState;
	mode: SandboxMode;
	override: SandboxOverride;
	/** `/sandbox`'s status lines, for the Config tab. */
	config: readonly string[];
	width: number;
	/** Total rows the panel may occupy, chrome included. */
	height: number;
}

/** The Config tab's body rows at `height`, for the wiring's scroll bound. */
export const sandboxConfigRows = (height: number): number => Math.max(1, height - SANDBOX_PANEL_CHROME_ROWS);

export function renderSandboxPanel(input: SandboxPanelInput, paint: (color: string, text: string) => string, bold: (text: string) => string): string[] {
	const { state, width } = input;
	const inner = Math.max(10, width - 4);
	const tabs = TABS.map((tab) => (tab.id === state.tab ? bold(paint("accent", tab.label)) : paint("dim", tab.label))).join("   ");
	const lines = [panelTopRule(paint, width), `  ${bold("Sandbox")}  ${tabs}`, ""];
	const list = (entries: readonly { value: string; label: string }[], current: string) =>
		entries.map((entry, index) => {
			const text = `${index === state.row ? "❯" : " "} ${entry.value === current ? "✔" : " "} ${entry.label}`;
			return `  ${index === state.row ? paint("accent", text) : text}`;
		});
	const help = (paragraphs: readonly string[]) => paragraphs.flatMap((paragraph) => ["", ...wrapProse(paragraph, inner).map((line) => paint("dim", `  ${line}`))]);
	let hints: string;
	if (state.tab === "mode") {
		lines.push(...list(MODES, input.mode), ...help(MODE_HELP));
		hints = "↑/↓ to navigate · Enter to select · ←/→ to switch · Esc to close";
	} else if (state.tab === "overrides") {
		lines.push(...list(OVERRIDES, input.override), ...help(OVERRIDES_HELP));
		hints = "↑/↓ to navigate · Enter to select · ←/→ to switch · Esc to close";
	} else {
		const body = input.config.flatMap((line) => wrapProse(line, inner));
		const visible = sandboxConfigRows(input.height);
		state.configRows = body.length;
		const max = Math.max(0, body.length - visible);
		if (state.offset > max) state.offset = max;
		lines.push(...body.slice(state.offset, state.offset + visible).map((line) => `  ${line}`));
		hints = body.length > visible ? `↑/↓ to scroll (${state.offset + 1}-${Math.min(body.length, state.offset + visible)} of ${body.length}) · ←/→ to switch · Esc to close` : "←/→ to switch · Esc to close";
	}
	return [...lines, "", ...wrapHints(hints, Math.max(1, width - 3)).map((line) => paint("dim", `  ${line}`))];
}

/** The user's settings file with `pick` written into its `sandbox` block; every other key is kept. */
export function applySandboxPick(file: Record<string, unknown>, pick: SandboxPick): Record<string, unknown> {
	const sandbox = isPlainObject(file.sandbox) ? { ...file.sandbox } : {};
	if (pick.tab === "mode") {
		sandbox.enabled = pick.value !== "off";
		// "No sandbox" also withdraws auto-allow: a project's file may turn the sandbox on, and an earlier
		// auto-allow left in the user's file would then run that project's commands without a prompt.
		sandbox.autoAllowBashIfSandboxed = pick.value === "auto-allow";
	} else {
		sandbox.allowUnsandboxedCommands = pick.value === "fallback";
	}
	return { ...file, sandbox };
}

/**
 * What to tell the user after a pick was written. `running` is whether this
 * process was started with the sandbox on; `loaded` is what the settings
 * files say now. Another file can hold a key against the user's own (a
 * project that turns the sandbox on, a file that forbids leaving it), and
 * on or off waits for the next start.
 */
export function sandboxPickOutcome(pick: SandboxPick, running: boolean, loaded: SandboxSettings): string {
	const lock = "the product locks the sandbox's settings";
	const locked = loaded.product?.locked === true;
	if (pick.tab === "overrides") {
		if (pick.value === "strict") return "Strict sandbox mode: no command the model runs leaves the sandbox, except your excluded commands.";
		if (loaded.allowUnsandboxedCommands) return "Unsandboxed fallback allowed: the model may ask to run a command outside the sandbox, through the permission gate.";
		return locked ? `Saved, but ${lock}, so strict sandbox mode stays.` : "Saved, but another settings file sets sandbox.allowUnsandboxedCommands to false, so strict sandbox mode stays.";
	}
	const wanted = pick.value !== "off";
	if (loaded.enabled !== wanted) return wanted ? "Saved, but the sandbox stays off." : locked ? `Saved, but ${lock}, so it stays on.` : "Saved, but another settings file turns the sandbox on, so it stays on.";
	const restart = loaded.enabled !== running ? ` The sandbox turns ${wanted ? "on" : "off"} at the next start.` : "";
	if (!wanted) return `No sandbox.${restart}`;
	if (pick.value === "auto-allow") {
		return loaded.autoAllowBashIfSandboxed
			? `Sandbox with auto-allow: a sandboxed Bash command runs without a prompt in default and acceptEdits modes.${restart}`
			: `Saved, but ${locked ? lock : "another settings file turns auto-allow off"}, so sandboxed commands keep their prompts.${restart}`;
	}
	return loaded.autoAllowBashIfSandboxed
		? `Saved, but another settings file turns auto-allow on, so sandboxed Bash commands still run without a prompt.${restart}`
		: `Sandbox with regular permissions: every prompt stays.${restart}`;
}
