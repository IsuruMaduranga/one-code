/**
 * The `/effort` slider (pure): choices, key decoding, and layout.
 *
 * Claude Code presents reasoning effort as a Faster→Smarter track with
 * `ultracode` sitting past `max`, separated by a divider because it is not
 * simply "more thinking" — it is xhigh plus standing workflow orchestration.
 * Rendering and key handling live here so the layout is unit-testable without
 * a terminal; `index.ts` only wires it to pi.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The final stop on the track: xhigh reasoning + workflows armed every turn. */
export const ULTRACODE = "ultracode";

/** Track stops, in Faster→Smarter order. Mirrors Claude Code's own slider. */
export const EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "max", ULTRACODE] as const;
export type EffortChoice = (typeof EFFORT_CHOICES)[number];

/**
 * Levels the slider omits but a typed `/effort off` should still accept — pi
 * supports them and shift+tab cycles through them, so refusing them here would
 * make the command less capable than the harness it fronts.
 */
const EXTRA_LEVELS = ["off", "minimal"] as const;

export function isEffortChoice(value: string): value is EffortChoice {
	return (EFFORT_CHOICES as readonly string[]).includes(value);
}

/** Parse a typed argument (`/effort xhigh`). Returns undefined if unrecognised. */
export function parseEffortArg(arg: string): EffortChoice | ThinkingLevel | undefined {
	const value = arg.trim().toLowerCase();
	if (!value) return undefined;
	if (isEffortChoice(value)) return value;
	if ((EXTRA_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
	return undefined;
}

export function acceptedEffortArgs(): string[] {
	return [...EFFORT_CHOICES, ...EXTRA_LEVELS];
}

/** The thinking level a choice maps to; ultracode is xhigh plus a standing mode. */
export function thinkingLevelFor(choice: EffortChoice): ThinkingLevel {
	return choice === ULTRACODE ? "xhigh" : (choice as ThinkingLevel);
}

/** Which choice a current thinking level should preselect on the track. */
export function choiceForState(level: ThinkingLevel | undefined, ultracodeActive: boolean): EffortChoice {
	if (ultracodeActive) return ULTRACODE;
	if (level && isEffortChoice(level)) return level;
	// off/minimal sit below the track's first stop; xhigh-only models may report
	// something else entirely. Land on the nearest sensible stop either way.
	return level === "off" || level === "minimal" ? "low" : "high";
}

export type SliderKey = "left" | "right" | "first" | "last" | "confirm" | "cancel";

/**
 * Decode a raw terminal chunk. `Component.handleInput` hands over bytes, not key
 * names, so the sequences are matched directly: CSI C/D for arrows (plus the
 * older SS3 form some terminals still send), CR/LF to confirm, ESC to cancel.
 */
export function decodeKey(data: string): SliderKey | undefined {
	switch (data) {
		case "\x1b[C":
		case "\x1bOC":
		case "l":
			return "right";
		case "\x1b[D":
		case "\x1bOD":
		case "h":
			return "left";
		case "\x1b[H":
		case "\x1b[1~":
			return "first";
		case "\x1b[F":
		case "\x1b[4~":
			return "last";
		case "\r":
		case "\n":
			return "confirm";
		case "\x1b":
		case "\x03": // ctrl+c — same intent as escape while a picker is focused
			return "cancel";
		default:
			return undefined;
	}
}

export function moveIndex(index: number, key: SliderKey, length: number): number {
	switch (key) {
		case "left":
			return Math.max(0, index - 1);
		case "right":
			return Math.min(length - 1, index + 1);
		case "first":
			return 0;
		case "last":
			return length - 1;
		default:
			return index;
	}
}

export type Paint = (color: string, text: string) => string;

export interface SliderView {
	index: number;
	/** Terminal width, so a narrow pane degrades instead of wrapping. */
	width: number;
}

const TITLE = "Effort";
const HINTS = "←/→ to adjust · Enter to confirm · Esc to cancel";
const ULTRACODE_SUBTITLE = "xhigh + workflows";

/**
 * One label cell per stop, padded so the marker row lines up under the label
 * it belongs to. The divider before `ultracode` is what tells the user it is a
 * different kind of thing rather than one more notch of thinking.
 */
function cells(): { label: string; divider: boolean }[] {
	return EFFORT_CHOICES.map((choice) => ({ label: choice, divider: choice === ULTRACODE }));
}

export function renderEffortSlider(view: SliderView, paint: Paint): string[] {
	const stops = cells();
	const gap = 2;
	const divider = " │ ";

	// Lay the label row out first, recording where each label starts, so the
	// track and marker rows can be built against real column positions.
	let labels = "";
	const positions: number[] = [];
	for (const [i, stop] of stops.entries()) {
		if (i > 0) labels += stop.divider ? divider : " ".repeat(gap);
		positions.push([...labels].length);
		labels += stop.label;
	}
	const plainWidth = [...labels].length;

	const selected = stops[view.index];
	const markerColumn = positions[view.index] + Math.floor([...selected.label].length / 2);

	const trackRow = Array.from({ length: plainWidth }, () => "─");
	// Keep the divider visible on the track itself, not just under the labels.
	const dividerIndex = stops.findIndex((s) => s.divider);
	if (dividerIndex > 0) {
		const at = positions[dividerIndex] - 2;
		if (at >= 0 && at < trackRow.length) trackRow[at] = "│";
	}

	const styledLabels = stops
		.map((stop, i) => {
			const text = i === view.index ? paint("accent", stop.label) : paint("muted", stop.label);
			return { text, divider: stop.divider };
		})
		.reduce((acc, cur, i) => acc + (i > 0 ? (cur.divider ? paint("dim", divider) : " ".repeat(gap)) : "") + cur.text, "");

	const endsRow = `${paint("dim", "Faster")}${" ".repeat(Math.max(1, plainWidth - "Faster".length - "Smarter".length))}${paint("dim", "Smarter")}`;
	const markerRow = `${" ".repeat(markerColumn)}${paint("accent", "▲")}`;
	const subtitleRow =
		selected.label === ULTRACODE
			? `${" ".repeat(Math.max(0, positions[stops.length - 1]))}${paint("dim", ULTRACODE_SUBTITLE)}`
			: "";

	const lines = [
		paint("accent", TITLE),
		"",
		endsRow,
		paint("muted", trackRow.join("")),
		markerRow,
		styledLabels,
	];
	if (subtitleRow) lines.push(subtitleRow);
	lines.push("", paint("dim", HINTS));

	// A pane narrower than the track would wrap and break the alignment the
	// marker row depends on; fall back to a plain list of stops.
	if (plainWidth > view.width) {
		return [
			paint("accent", TITLE),
			paint("muted", stops.map((s, i) => (i === view.index ? paint("accent", s.label) : s.label)).join(" · ")),
			paint("dim", HINTS),
		];
	}
	return lines;
}
