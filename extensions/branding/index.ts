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

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { piVersionWarning } from "../lib/pi-version.ts";
import {
	PERMISSION_STATUS_CHANNEL,
	permissionModeDisplay,
	type PermissionStatus,
	shortModelName,
} from "../permissions/modes.ts";
import { SUBAGENT_STATUS_CHANNEL, type SubagentStatus } from "../subagents/model-select.ts";
import {
	collectStartupSections,
	quietStartupEnabled,
	shouldDefaultFlushOutputPad,
	shouldDefaultHideThinking,
	type StartupSection,
} from "./startup.ts";
import { safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { markAssistantMarkdown } from "./assistant-marker.ts";
import { PROMPT_PADDING, PromptEditor } from "./prompt-editor.ts";

export { truncateLine };

const NAME = "One Code";
/** Tagline under the wordmark — the "any model" positioning, matching the README. */
const SUBTITLE = "the Claude Code experience, on any model";

export interface BannerInput {
	version: string;
	model?: string;
	cwd: string;
	mode: string;
	/** Effective subagent/workflow default with its selection source. */
	subagents?: string;
	/** Compact resource sections, shown when pi's own listing is silenced. */
	sections?: StartupSection[];
}

/**
 * "ONE CODE" wordmark (figlet "ANSI Shadow"), ONE and CODE on a single line.
 * Rendered as its own block above the text column. Rows are normalised to a
 * single width at load, so a trailing-space trim in the source can never
 * misalign the block. Below WORDMARK_WIDTH a compact "One Code" title replaces
 * it, so a narrow pane never shows sheared glyphs.
 */
const WORDMARK_RAW = [
	" ██████╗ ███╗   ██╗███████╗   ██████╗ ██████╗ ██████╗ ███████╗",
	"██╔═══██╗████╗  ██║██╔════╝  ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
	"██║   ██║██╔██╗ ██║█████╗    ██║     ██║   ██║██║  ██║█████╗",
	"██║   ██║██║╚██╗██║██╔══╝    ██║     ██║   ██║██║  ██║██╔══╝",
	"╚██████╔╝██║ ╚████║███████╗  ╚██████╗╚██████╔╝██████╔╝███████╗",
	" ╚═════╝ ╚═╝  ╚═══╝╚══════╝   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];
/** Display width every wordmark row is padded to (the widest raw row). */
export const WORDMARK_WIDTH = Math.max(...WORDMARK_RAW.map((r) => [...r].length));
export const WORDMARK = WORDMARK_RAW.map((r) => r + " ".repeat(WORDMARK_WIDTH - [...r].length));

/**
 * One curated hint line, not a keymap dump: only the controls someone cannot
 * discover on their own — the dials this package renames or hides state behind
 * (effort, permission mode, collapsed thinking/output) plus the two input
 * prefixes and the opt-in keyword nobody could guess. Everything else lives in
 * pi's own /hotkeys listing, which the line points at.
 */
const HINTS: [key: string, what: string][] = [
	// First so it survives narrow terminals: the pointer to everything else.
	["/hotkeys", "all keys"],
	// pi calls this dial "thinking" and reserves shift+tab for it; we present
	// it as Claude Code's "effort" so the key and /effort agree on the name.
	["shift+tab", "effort"],
	// Claude Code cycles permission modes on shift+tab; pi owns that key, and
	// ctrl+q is the one ctrl+letter both pi and terminals leave free.
	["ctrl+q", "permissions"],
	["ctrl+t", "thinking"],
	["ctrl+o", "expand output"],
	["/", "commands"],
	["!", "bash"],
	// A keyword rather than a binding — an opt-in feature nobody knows the
	// word for is invisible.
	["ultracode", "max effort"],
];

/**
 * Keep only whole leading items that fit the budget (measured unpainted, so
 * ANSI codes don't count), rather than letting truncateLine cut mid-word.
 * Always keeps at least one item; truncateLine remains the backstop.
 */
export function fitItems<T>(items: T[], plainLength: (item: T) => number, budget: number | undefined, sepLength = 3): T[] {
	if (budget === undefined) return items;
	const kept: T[] = [];
	let used = 0;
	for (const item of items) {
		const extra = (kept.length ? sepLength : 0) + plainLength(item);
		if (kept.length > 0 && used + extra > budget) break;
		kept.push(item);
		used += extra;
	}
	return kept;
}

/**
 * Sections compressed to one line: context files and themes are few and short,
 * so their names carry information; skills/workflows lists are long and get
 * truncated into noise, so past three items they collapse to a count.
 */
export function sectionSummary(sections: StartupSection[], paint: (color: string, text: string) => string): string {
	return sections
		.filter((s) => s.items.length > 0)
		.map((s) =>
			s.items.length <= 3
				? `${paint("muted", s.label)} ${paint("dim", s.items.join(", "))}`
				: `${paint("muted", s.label)} ${paint("dim", String(s.items.length))}`,
		)
		.join(paint("muted", " · "));
}

/**
 * Banner layout: the wordmark block, then a one-space-indented text column
 * (tagline + version, context, hints, sections). Kept pure so the layout is
 * unit-testable without a terminal. Below WORDMARK_WIDTH the wordmark is
 * replaced by a compact "One Code" title, so a narrow pane never shows sheared
 * fragments of the art.
 */
export function bannerLines(
	input: BannerInput,
	paint: (color: string, text: string) => string,
	width?: number,
): string[] {
	const indent = " ";
	const budget = width === undefined ? undefined : width - indent.length;

	const subtitle = `${paint("dim", SUBTITLE)}${paint("muted", " · ")}${paint("dim", `v${input.version}`)}`;
	const context = [
		input.model ? `${paint("muted", "model")} ${input.model}` : undefined,
		`${paint("muted", "mode")} ${input.mode}`,
		input.subagents ? `${paint("muted", "subagents")} ${input.subagents}` : undefined,
	]
		.filter(Boolean)
		.join(paint("muted", " · "));
	// Narrow terminals drop whole trailing hints (the /hotkeys pointer is
	// first, so it always survives) instead of cutting one mid-word.
	const hints = fitItems(HINTS, ([key, what]) => key.length + 1 + what.length, budget)
		.map(([key, what]) => `${paint("accent", key)} ${paint("muted", what)}`)
		.join(paint("muted", " · "));
	const sections = sectionSummary(input.sections ?? [], paint);

	const textColumn = [subtitle, context, hints, ...(sections ? [sections] : [])].map((line) => `${indent}${line}`);

	// The wordmark is a fixed-width block; if it cannot fit, show a text title
	// rather than let truncateLine shear the glyphs mid-row.
	const head =
		width !== undefined && width < WORDMARK_WIDTH ? [paint("accent", NAME)] : WORDMARK.map((row) => paint("accent", row));

	const assembled = [...head, ...textColumn];
	return width === undefined ? assembled : assembled.map((line) => truncateLine(line, width));
}

/** Collapsed-thinking placeholder — pi paints it in thinkingText + italic. */
const THINKING_LABEL = "✻ Thinking… (ctrl+t to expand)";

/** Claude Code-style input marker, painted in the editor's left gutter. A heavy
 * chevron (U+276F), one column wide so the two-column gutter still aligns. */
const PROMPT_GLYPH = "❯";

/**
 * `pi.registerMarkdownTransformer` typed locally: the runtime (pi ≥ 0.84) exposes
 * it, but the pinned 0.83 type declarations do not, so we cast and feature-detect
 * — the same "older pi may lack the hook" handling as the prompt marker.
 */
interface MarkdownTransformerHost {
	registerMarkdownTransformer?: (
		transformer: (
			markdown: string,
			context: { messageType: "user" | "assistant" | "assistant-thinking"; isStreaming: boolean; availableWidth: number },
		) => string,
	) => void;
}

/** The slice of the UI context the prompt marker needs (older pi may lack the hook). */
interface BrandingEditorUI {
	setEditorComponent?: (factory: (tui: unknown, theme: unknown, keybindings: unknown) => unknown) => void;
	theme?: unknown;
}

/**
 * Replace the core input editor with one that paints a "›" prompt marker, the
 * way Claude Code does. TUI-only (print/rpc have no editor), skipped when pi is
 * too old to expose the hook, and disableable with CC_NO_INPUT_MARKER=1 in case
 * a pi-tui render change ever makes the marker misplace (cosmetic only — typing
 * is never affected; see prompt-marker.ts).
 */
function installPromptMarker(ctx: { hasUI: boolean; mode: string; ui: BrandingEditorUI }): void {
	if (process.env.CC_NO_INPUT_MARKER === "1") return;
	if (!ctx.hasUI || ctx.mode !== "tui") return;
	const ui = ctx.ui;
	if (typeof ui.setEditorComponent !== "function") return;
	// The marker follows live theme changes because it is re-read per render.
	const renderMarker = () => {
		// Bold makes the chevron read heavier than the input text beside it.
		return `\x1b[1m${safeThemePaint(ui.theme)("accent", PROMPT_GLYPH)}\x1b[0m${" ".repeat(PROMPT_PADDING - 1)}`;
	};
	ui.setEditorComponent((tui: unknown, theme: unknown, keybindings: unknown) => new PromptEditor(tui as never, theme as never, keybindings as never, renderMarker));
}

/**
 * Default thinking blocks to collapsed, once, respecting any user choice.
 * pi caches settings in memory at startup, so a write here lands from the
 * *next* session; the current one keeps whatever the file said at launch
 * (ctrl+t still works immediately and persists the user's own preference).
 */
function applyThinkingDefault(): void {
	try {
		const agentDir = getAgentDir();
		const settingsPath = join(agentDir, "settings.json");
		const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
		if (shouldDefaultHideThinking(raw)) {
			SettingsManager.create(process.cwd(), agentDir).setHideThinkingBlock(true);
		}
	} catch {
		// Presentation-only default — never let a settings hiccup break startup.
	}
}

/**
 * Default pi's output padding to 0 so the assistant "●" marker sits flush at
 * column 0, aligned with the tool bullets (which render there). Only when the
 * user hasn't set `outputPad` themselves; like the thinking default, pi caches
 * settings at startup, so this lands from the *next* session (the current one
 * keeps whatever pad it launched with). Skipped when the marker is disabled, so
 * the two travel together.
 */
function applyOutputPadDefault(): void {
	if (process.env.CC_NO_ASSISTANT_MARKER === "1") return;
	try {
		const agentDir = getAgentDir();
		const settingsPath = join(agentDir, "settings.json");
		const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
		if (shouldDefaultFlushOutputPad(raw)) {
			SettingsManager.create(process.cwd(), agentDir).setOutputPad(0);
		}
	} catch {
		// Presentation-only default — never let a settings hiccup break startup.
	}
}

export default function brandingExtension(pi: ExtensionAPI) {
	applyThinkingDefault();
	applyOutputPadDefault();
	// Mark each block of assistant prose with Claude Code's "●" bullet. Only
	// assistant text is transformed (not thinking or user turns); the transformer
	// runs in markdown rendering, so print/rpc output is untouched.
	// CC_NO_ASSISTANT_MARKER=1 opts out, mirroring CC_NO_INPUT_MARKER.
	const transformerHost = pi as unknown as MarkdownTransformerHost;
	if (process.env.CC_NO_ASSISTANT_MARKER !== "1" && typeof transformerHost.registerMarkdownTransformer === "function") {
		transformerHost.registerMarkdownTransformer((markdown, context) =>
			context.messageType === "assistant" ? markAssistantMarkdown(markdown) : markdown,
		);
	}
	// The label and prompt marker apply in every session; CC_NO_BANNER only
	// disables the header.
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setHiddenThinkingLabel(THINKING_LABEL);
		installPromptMarker(ctx as unknown as { hasUI: boolean; mode: string; ui: BrandingEditorUI });
		// Soft drift guard: warn once at startup when the hosting pi is outside
		// the range this release was tested against (see lib/pi-version.ts).
		const versionWarning = piVersionWarning(PI_VERSION);
		if (versionWarning) ctx.ui.notify(versionWarning, "warning");
	});

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
		// Resolve pi's live agent dir (honours PI_CODING_AGENT_DIR) so an
		// isolated one-code app reads its own settings/skills, never ~/.pi.
		const agentDir = getAgentDir();
		const sections = quietStartupEnabled(join(agentDir, "settings.json"))
			? collectStartupSections(ctx.cwd, home, join(dirname(fileURLToPath(import.meta.url)), "..", "..", "themes"), agentDir)
			: undefined;

		ctx.ui.setTitle(NAME);
		ctx.ui.setHeader((tui: unknown, theme: unknown) => {
			const paint = safeThemePaint(theme);
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
							subagents: subagentStatus?.model
								? `${shortModelName(subagentStatus.model)}${subagentStatus.via ? ` (${subagentStatus.via})` : ""}`
								: undefined,
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
