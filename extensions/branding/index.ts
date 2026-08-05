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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NAME = "pincer";

interface ThemeLike {
	fg(color: string, text: string): string;
}

export interface BannerInput {
	version: string;
	model?: string;
	cwd: string;
	mode: string;
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
		["shift+tab", "thinking"],
		["ctrl+l", "model"],
		["ctrl+p", "cycle model"],
		["/permission-mode", "mode"],
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
	],
];

/** Kept pure so the layout is unit-testable without a terminal. */
export function bannerLines(input: BannerInput, paint: (color: string, text: string) => string): string[] {
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
	]
		.filter(Boolean)
		.join(paint("muted", " · "));

	const text = [`${title}  ${subtitle}`, ...hints, context];
	const logoWidth = Math.max(...LOGO_LINES.map((art) => [...art].length));
	const blankArt = " ".repeat(logoWidth);
	return text.map((line, i) => `${paint("accent", LOGO_LINES[i] ?? blankArt)}  ${line}`);
}

export default function brandingExtension(pi: ExtensionAPI) {
	if (process.env.CC_NO_BANNER === "1") return;

	pi.on("session_start", (_event, ctx) => {
		// Only the TUI has a header to replace; rpc/print modes have no chrome.
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		const version = process.env.CC_VERSION ?? "0.1.0";
		const model = ctx.model ? `${ctx.model.id}` : undefined;

		ctx.ui.setTitle(NAME);
		ctx.ui.setHeader((_tui: unknown, theme: unknown) => {
			const paint = (color: string, text: string) => {
				const themed = theme as ThemeLike | undefined;
				try {
					return themed?.fg ? themed.fg(color, text) : text;
				} catch {
					return text;
				}
			};
			const lines = bannerLines({ version, model, cwd: ctx.cwd, mode: "default" }, paint);
			return {
				render: () => ["", ...lines, ""],
				// Nothing is cached, so there is nothing to invalidate.
				invalidate: () => {},
			};
		});
	});
}
