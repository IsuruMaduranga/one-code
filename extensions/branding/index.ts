/**
 * branding extension — replaces pi's startup header.
 *
 * pi's own banner ("pi v0.83.0 … Ask it how to use or extend Pi") comes from its
 * `piConfig`, which resolves from pi's *own* installed package.json and so cannot
 * be changed by a dependent package. But `ctx.ui.setHeader()` replaces the header
 * component outright, which gets us the same result without a fork.
 *
 * A pi-tui `Component` is small enough to implement inline — `render(width)` plus
 * a no-op `invalidate()` (we have no cached layout to drop) — so this needs no
 * new dependency on pi-tui.
 *
 * Set `CC_NO_BANNER=1` to keep pi's original header.
 */

import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PERMISSION_STATUS_CHANNEL,
	permissionModeDisplay,
	type PermissionStatus,
	shortModelName,
} from "../permissions/modes.ts";
import { SUBAGENT_STATUS_CHANNEL, type SubagentStatus } from "../subagents/model-select.ts";
import { collectStartupSections, quietStartupEnabled, type StartupSection } from "./startup.ts";

const NAME = "pincer";

interface ThemeLike {
	fg(color: string, text: string): string;
}

export interface BannerInput {
	version: string;
	model?: string;
	cwd: string;
	mode: string;
	/** Default subagent model, shown only when it differs from the session model. */
	subagents?: string;
	/** Compact resource sections, shown when pi's own listing is silenced. */
	sections?: StartupSection[];
}

/**
 * Pixel π — our own mark, not a copy of anyone's mascot (Anthropic's branding
 * guidelines prohibit Claude Code-mimicking art; see docs/handoff.md). Half-block
 * characters pack two pixel rows per text row, so the glyph fits the banner's
 * three lines. All lines are the same width so the text column beside it aligns.
 */
export const LOGO_LINES = [
	"▀██▀▀▀▀██▀",
	" ██    ██ ",
	" ██    ██▄",
];

/**
 * pi's default keybindings (core/keybindings.ts) plus our own input prefixes
 * and commands, grouped one line each: session control, then everything that
 * changes what the model sees or does, then editor/clipboard conveniences.
 */
const HINT_LINES: [key: string, what: string][][] = [
	[
		// pi calls this dial "thinking" and reserves shift+tab for it; we present
		// it as Claude Code's "effort" so the key and /effort agree on the name.
		["shift+tab", "cycle effort"],
		["/effort", "effort + ultracode"],
		["ctrl+l", "model"],
		["ctrl+p", "cycle model"],
		// Claude Code cycles permission modes on shift+tab; pi owns that key, and
		// ctrl+q is the one ctrl+letter both pi and terminals leave free.
		["ctrl+q", "permission mode"],
		["ctrl+t", "thinking blocks"],
		["ctrl+o", "tool output"],
	],
	[
		["ctrl+g", "external editor"],
		["ctrl+v", "paste image"],
		["ctrl+x", "copy"],
		["alt+enter", "follow-up"],
		["ctrl+z", "suspend"],
	],
	[
		["escape", "interrupt"],
		["ctrl+c/ctrl+d", "clear/exit"],
		["/", "commands"],
		["!", "bash"],
		// A keyword rather than a binding, but this is the line for "type this,
		// get that" — and an opt-in feature nobody knows the word for is invisible.
		["ultracode", "multi-agent workflow"],
	],
];

/**
 * Cut a painted line to `width` visible columns without splitting ANSI escape
 * sequences, ending with an ellipsis and a reset so truncation cannot leak a
 * colour into the next line. pi-tui *crashes* the whole app on an overwide
 * line ("Rendered line exceeds terminal width"), and only validates a
 * component when its output changes — so the overflow hid in the static
 * banner until the mode line became live and re-renders began.
 */
export function truncateLine(line: string, width: number): string {
	if (width <= 0) return "";
	const ANSI = /^\x1b\[[0-9;]*m/;
	let visible = 0;
	for (let i = 0; i < line.length; ) {
		const escape = line.slice(i).match(ANSI);
		if (escape) {
			i += escape[0].length;
			continue;
		}
		visible++;
		i++;
	}
	if (visible <= width) return line;

	let out = "";
	let used = 0;
	for (let i = 0; i < line.length && used < width - 1; ) {
		const escape = line.slice(i).match(ANSI);
		if (escape) {
			out += escape[0];
			i += escape[0].length;
			continue;
		}
		out += line[i];
		used++;
		i++;
	}
	return `${out}\x1b[0m…`;
}

/** Kept pure so the layout is unit-testable without a terminal. */
export function bannerLines(
	input: BannerInput,
	paint: (color: string, text: string) => string,
	width?: number,
): string[] {
	const title = `${paint("accent", NAME)} ${paint("dim", `v${input.version}`)}`;
	const subtitle = paint("dim", "the Claude Code experience, on the pi harness");
	const hints = HINT_LINES.map((line) =>
		line
			.map(([key, what]) => `${paint("accent", key)} ${paint("muted", what)}`)
			.join(paint("muted", " · ")),
	);

	const context = [
		input.model ? `${paint("muted", "model")} ${input.model}` : undefined,
		`${paint("muted", "mode")} ${input.mode}`,
		input.subagents ? `${paint("muted", "subagents")} ${input.subagents}` : undefined,
	]
		.filter(Boolean)
		.join(paint("muted", " · "));

	const sections = (input.sections ?? []).map(
		(s) => `${paint("accent", s.label)} ${paint("dim", s.items.join(", "))}`,
	);

	const text = [`${title}  ${subtitle}`, ...hints, context, ...sections];
	const logoWidth = Math.max(...LOGO_LINES.map((art) => [...art].length));
	const blankArt = " ".repeat(logoWidth);
	const assembled = text.map((line, i) => `${paint("accent", LOGO_LINES[i] ?? blankArt)}  ${line}`);
	return width === undefined ? assembled : assembled.map((line) => truncateLine(line, width));
}

export default function brandingExtension(pi: ExtensionAPI) {
	if (process.env.CC_NO_BANNER === "1") return;

	/**
	 * Mode and classifier arrive over the bus from the permissions extension
	 * (jiti isolates module state, so this cannot be a shared variable). The
	 * banner re-renders on every update, so cycling modes or the classifier
	 * pinning mid-session keeps the header truthful instead of frozen at
	 * whatever was true at startup.
	 */
	let permissionStatus: PermissionStatus | undefined;
	let subagentStatus: SubagentStatus | undefined;
	let currentModelId: string | undefined;
	let requestHeaderRender: (() => void) | undefined;
	// The model line goes stale the same way the mode line did once the header
	// re-renders live, so it follows ctrl+p / /model changes too.
	pi.on("model_select", (event) => {
		currentModelId = event.model?.id ?? currentModelId;
		requestHeaderRender?.();
	});
	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		permissionStatus = data as PermissionStatus;
		requestHeaderRender?.();
	});
	pi.events.on(SUBAGENT_STATUS_CHANNEL, (data) => {
		subagentStatus = data as SubagentStatus;
		requestHeaderRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		// Only the TUI has a header to replace; rpc/print modes have no chrome.
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		const version = process.env.CC_VERSION ?? "0.1.0";
		currentModelId = ctx.model ? `${ctx.model.id}` : currentModelId;

		// With pi's own listing silenced, the banner carries compact sections
		// instead (minus the internal [Extensions] noise).
		const home = os.homedir();
		const sections = quietStartupEnabled(join(home, ".pi", "agent", "settings.json"))
			? collectStartupSections(ctx.cwd, home, join(dirname(fileURLToPath(import.meta.url)), "..", "..", "themes"))
			: undefined;

		ctx.ui.setTitle(NAME);
		ctx.ui.setHeader((tui: unknown, theme: unknown) => {
			const paint = (color: string, text: string) => {
				const themed = theme as ThemeLike | undefined;
				try {
					return themed?.fg ? themed.fg(color, text) : text;
				} catch {
					return text;
				}
			};
			requestHeaderRender = () => {
				(tui as { requestRender?: () => void } | undefined)?.requestRender?.();
			};
			return {
				// Rendered per paint rather than precomputed, so the mode line
				// follows ctrl+q cycles and the classifier pinning.
				render: (width: number) => [
					"",
					...bannerLines(
						{
							version,
							model: currentModelId,
							cwd: ctx.cwd,
							mode: permissionModeDisplay(permissionStatus ?? { mode: "default", paused: false }),
							subagents: subagentStatus?.model ? shortModelName(subagentStatus.model) : undefined,
							sections,
						},
						paint,
						width,
					),
					"",
				],
				// Nothing is cached, so there is nothing to invalidate.
				invalidate: () => {},
			};
		});
	});
}
