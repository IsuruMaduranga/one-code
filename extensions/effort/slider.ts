/**
 * The `/effort` slider (pure): choices, key decoding, and layout.
 *
 * Claude Code presents reasoning effort as a Faster→Smarter track with
 * `ultracode` sitting past the top, separated by a divider because it is not
 * simply "more thinking" — it is the top reasoning level plus standing workflow
 * orchestration.
 *
 * The plain stops are pi's own thinking ladder, deliberately *all* of it: pi
 * reserves shift+tab for `app.thinking.cycle` and refuses to let an extension
 * rebind it, so that key keeps cycling the full ladder no matter what we do.
 * A slider offering a different set would mean two dials disagreeing about the
 * same number, so this one covers the same stops and adds ultracode. Everything
 * user-facing calls it "effort"; "thinking level" is pi's internal name for it.
 *
 * Rendering and key handling live here so the layout is unit-testable without a
 * terminal; `index.ts` only wires it to pi.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The final stop on the track: top reasoning + workflows armed every turn. */
export const ULTRACODE = "ultracode";

/** The reasoning level ultracode pins, when the model can reach it. */
export const ULTRACODE_LEVEL: ThinkingLevel = "xhigh";

/** pi's thinking ladder, Faster→Smarter — the same stops shift+tab cycles. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Track stops: pi's ladder, then ultracode past the divider. */
export const EFFORT_CHOICES = [...THINKING_LEVELS, ULTRACODE] as const;
export type EffortChoice = (typeof EFFORT_CHOICES)[number];

export function isEffortChoice(value: string): value is EffortChoice {
	return (EFFORT_CHOICES as readonly string[]).includes(value);
}

/** Parse a typed argument (`/effort xhigh`). Returns undefined if unrecognised. */
export function parseEffortArg(arg: string): EffortChoice | undefined {
	const value = arg.trim().toLowerCase();
	return value && isEffortChoice(value) ? value : undefined;
}

export function acceptedEffortArgs(): string[] {
	return [...EFFORT_CHOICES];
}

/** The thinking level a choice maps to; ultracode pins the top plus a mode. */
export function thinkingLevelFor(choice: EffortChoice): ThinkingLevel {
	return choice === ULTRACODE ? ULTRACODE_LEVEL : (choice as ThinkingLevel);
}

/** Which choice a current thinking level should preselect on the track. */
export function choiceForState(level: ThinkingLevel | undefined, ultracodeActive: boolean): EffortChoice {
	if (ultracodeActive) return ULTRACODE;
	if (level && isEffortChoice(level)) return level;
	return "medium";
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
const HINTS = "←/→ adjust · Enter confirm · Esc cancel · shift+tab cycles the plain levels";
const SHORT_HINTS = "←/→ · Enter · Esc";
const ULTRACODE_SUBTITLE = `${ULTRACODE_LEVEL} + workflows`;

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

	// Rows are (plain content, styled content) pairs: nothing wraps for us, and a
	// wrapped line would shift the marker out from under its label, so widths are
	// measured on the unstyled text — escape codes would inflate the count.
	const rows: [plain: string, styled: string][] = [
		[TITLE, paint("accent", TITLE)],
		["", ""],
		[`Faster${" ".repeat(Math.max(1, plainWidth - 13))}Smarter`, endsRow],
		[trackRow.join(""), paint("muted", trackRow.join(""))],
		[`${" ".repeat(markerColumn)}▲`, markerRow],
		[labels, styledLabels],
	];
	if (subtitleRow) rows.push([`${" ".repeat(Math.max(0, positions[stops.length - 1]))}${ULTRACODE_SUBTITLE}`, subtitleRow]);
	rows.push(["", ""], [HINTS, paint("dim", HINTS)]);

	const fits = rows.every(([plainRow]) => [...plainRow].length <= view.width);
	if (fits) return rows.map(([, styled]) => styled);

	// Too narrow for the track (or for the hint line): drop to one stop list and
	// the shortest usable hint, both clipped, rather than let anything wrap.
	const clip = (text: string) => [...text].slice(0, view.width).join("");
	const list = stops.map((s) => s.label);
	return [
		paint("accent", clip(TITLE)),
		clip(list.join(" · ")).replace(list[view.index], (m) => paint("accent", m)),
		paint("dim", clip(SHORT_HINTS)),
	];
}
