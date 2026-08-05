/**
 * effort extension — Claude Code's `/effort`, including the `ultracode` stop.
 *
 * Reasoning effort is pi's thinking level, which shift+tab already cycles; what
 * this adds is Claude Code's framing, where the track runs past `max` to
 * `ultracode` — xhigh reasoning *plus* standing multi-agent orchestration. The
 * keyword in a message arms one turn (see `extensions/workflow`); this mode arms
 * every turn until it is switched off, via an `every-turn` reminder keyed so it
 * can be withdrawn, the same shape the permissions extension uses for plan mode.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import {
	acceptedEffortArgs,
	choiceForState,
	decodeKey,
	type EffortChoice,
	EFFORT_CHOICES,
	moveIndex,
	parseEffortArg,
	renderEffortSlider,
	thinkingLevelFor,
	ULTRACODE,
} from "./slider.ts";

const REMINDER_KEY = "ultracode-mode";
const STATUS_KEY = "ultracode";

/**
 * The standing instruction for ultracode mode. Deliberately stronger than the
 * single-turn keyword reminder: it makes orchestration the default for
 * substantive work rather than something to consider, and still carves out the
 * trivial cases so the mode does not spawn a fleet to rename a variable.
 */
const ULTRACODE_STANDING_REMINDER =
	"Ultracode mode is on, so the user's opt-in to multi-agent orchestration is standing: author and run a workflow for every substantive task by default, and lean toward adversarially verifying your findings. " +
	"For multi-phase work (understand → design → implement → review) that often means several workflows in sequence — one per phase — so you stay in the loop between them. " +
	"Token cost is not the constraint here; the most exhaustive correct answer is. " +
	"Work solo only on conversational turns and trivial mechanical edits.";

export default function effortExtension(pi: ExtensionAPI) {
	let ultracodeActive = false;
	/**
	 * The level ultracode actually settled on. Not always xhigh: pi clamps to
	 * model capability, so on a model that caps lower this is that cap — and the
	 * shift+tab hygiene below must compare against it, or the mode would drop
	 * itself the moment anything re-announced the clamped level.
	 */
	let ultracodeLevel: ThinkingLevel | undefined;

	const applyStatus = (ctx: ExtensionContext) => {
		// No-op outside the TUI, so this is safe to call unconditionally.
		ctx.ui.setStatus(STATUS_KEY, ultracodeActive ? "✦ ultracode" : undefined);
	};

	const setUltracode = (on: boolean, level?: ThinkingLevel) => {
		ultracodeActive = on;
		ultracodeLevel = on ? level : undefined;
		if (on) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: ULTRACODE_STANDING_REMINDER,
				scope: "every-turn",
				key: REMINDER_KEY,
			});
		} else {
			pi.events.emit(REMINDER_CHANNEL, { remove: true, key: REMINDER_KEY });
		}
	};

	/** Apply a chosen stop and report what actually took effect. */
	const applyChoice = (choice: EffortChoice, ctx: ExtensionContext) => {
		const wanted = thinkingLevelFor(choice);
		pi.setThinkingLevel(wanted);
		const actual = pi.getThinkingLevel();

		setUltracode(choice === ULTRACODE, actual);
		applyStatus(ctx);

		// setThinkingLevel clamps to model capability silently, so compare rather
		// than claiming a level the model never accepted.
		const clamped = actual !== wanted ? ` (this model caps reasoning at ${actual})` : "";
		if (choice === ULTRACODE) {
			ctx.ui.notify(`Effort: ultracode — ${actual} reasoning, workflows armed every turn${clamped}`, "info");
		} else {
			ctx.ui.notify(`Effort: ${actual}${clamped}`, "info");
		}
	};

	const applyPlainLevel = (level: ThinkingLevel, ctx: ExtensionContext) => {
		pi.setThinkingLevel(level);
		const actual = pi.getThinkingLevel();
		setUltracode(false);
		applyStatus(ctx);
		ctx.ui.notify(`Effort: ${actual}${actual !== level ? ` (this model caps reasoning at ${actual})` : ""}`, "info");
	};

	const showSlider = async (ctx: ExtensionContext): Promise<void> => {
		let index = EFFORT_CHOICES.indexOf(choiceForState(pi.getThinkingLevel(), ultracodeActive));
		if (index < 0) index = 0;

		const chosen = await ctx.ui.custom<EffortChoice | null>((tui, theme, _keybindings, done) => {
			const paint = (color: string, text: string) => {
				const themed = theme as { fg?(c: string, t: string): string } | undefined;
				try {
					return themed?.fg ? themed.fg(color, text) : text;
				} catch {
					return text;
				}
			};
			return {
				render: (width: number) => ["", ...renderEffortSlider({ index, width }, paint), ""],
				handleInput: (data: string) => {
					const key = decodeKey(data);
					if (!key) return;
					if (key === "cancel") {
						done(null);
						return;
					}
					if (key === "confirm") {
						done(EFFORT_CHOICES[index]);
						return;
					}
					index = moveIndex(index, key, EFFORT_CHOICES.length);
					tui.requestRender();
				},
				invalidate: () => {},
			};
		});

		if (chosen) applyChoice(chosen, ctx);
	};

	pi.registerCommand("effort", {
		description: `Set reasoning effort: /effort [${EFFORT_CHOICES.join("|")}] — ultracode is xhigh + workflows`,
		getArgumentCompletions: (prefix) => {
			const matches = acceptedEffortArgs().filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const typed = args.trim();
			if (typed) {
				const parsed = parseEffortArg(typed);
				if (!parsed) {
					ctx.ui.notify(`Unknown effort "${typed}". Use one of: ${acceptedEffortArgs().join(", ")}`, "error");
					return;
				}
				if (parsed === ULTRACODE || (EFFORT_CHOICES as readonly string[]).includes(parsed)) {
					applyChoice(parsed as EffortChoice, ctx);
				} else {
					applyPlainLevel(parsed as ThinkingLevel, ctx);
				}
				return;
			}

			// The picker needs focus and a terminal; elsewhere say what to type.
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(
					`Current effort: ${ultracodeActive ? `ultracode (${pi.getThinkingLevel()} + workflows)` : pi.getThinkingLevel()}. ` +
						`Set one with /effort <${acceptedEffortArgs().join("|")}>.`,
					"info",
				);
				return;
			}
			await showSlider(ctx);
		},
	});

	// Cycling thinking with shift+tab away from ultracode's level makes the
	// footer indicator a lie, so drop the mode instead of letting the two drift.
	pi.on("thinking_level_select", (event, ctx) => {
		if (ultracodeActive && ultracodeLevel !== undefined && event.level !== ultracodeLevel) {
			setUltracode(false);
			applyStatus(ctx);
			ctx.ui.notify(`Ultracode off — reasoning is now ${event.level}`, "info");
		}
	});

	pi.on("session_start", (_event, ctx) => {
		applyStatus(ctx);
	});
}
