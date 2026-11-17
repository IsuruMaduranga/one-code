/**
 * effort extension — Claude Code's `/effort`, including the `ultracode` stop.
 *
 * Interactive low/medium/high/xhigh choices persist per model in pi's own
 * settings (`modelThinkingLevels`); max and ultracode stay session-only. pi
 * restores the saved level natively, so launch overrides and resume still win.
 *
 * Reasoning effort is pi's thinking level under another name, and shift+tab
 * already cycles it. pi reserves that key (`app.thinking.cycle` is on its
 * RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS list, so `registerShortcut` on
 * shift+tab is skipped with a warning), which settles the design: we cannot
 * retarget or disable it, so the slider covers the same ladder it cycles rather
 * than a different one, and both are presented as "effort" — pi's own wording
 * for the dial stays visible in its footer, but nothing we write calls it
 * "thinking".
 *
 * What the slider adds is the stop past the top: `ultracode`, the top reasoning
 * level *plus* standing multi-agent orchestration. The keyword in a message arms
 * one turn (see `extensions/agents/workflow`); this mode arms every turn until it is
 * switched off, via an `every-turn` reminder keyed so it can be withdrawn — the
 * same shape the permissions extension uses for plan mode.
 *
 * It also applies the profile's per-tier starting level
 * (`Profile.defaultThinkingLevels`; lib/models/tier-thinking.ts decides when):
 * at `session_start` for a new session, which every mode awaits before its
 * first request, and at `model_select`, where pi has just set its own level
 * and a switch opens an epoch anyway. It is set quietly, with no effort note,
 * since the user changed nothing.
 */

import { feature } from "../../lib/profile/feature.ts";
import os from "node:os";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effortSetMessage, isPersistedEffort, type PersistedEffort } from "./settings.ts";
import { activeProfile, requireText, toolLive } from "../../lib/profile/profile.ts";
import { thinkingLevelsFor } from "../../lib/models/thinking-levels.ts";
import { autoThinkingAction, branchHasMessages, declaredLevel, type LevelSource, levelOwnership, TIER_THINKING_STATE, tierThinkingAt, type TierThinkingState } from "../../lib/models/tier-thinking.ts";
import { REMINDER_CHANNEL, RENDER_CHANNEL, type RenderRequest, stickyFact, toldBlockFact } from "../../lib/request/reminders.ts";
import { readState, recordState } from "../../lib/request/ledger/state.ts";
import { dimRightAlignedWidget, safeThemePaint, truncateLine } from "../../lib/ui/tui-render.ts";
import {
	acceptedEffortArgs,
	choiceForState,
	decodeKey,
	type EffortChoice,
	EFFORT_CHOICES,
	effortNoteText,
	enabledStops,
	levelRank,
	moveIndex,
	nearestEnabled,
	parseEffortArg,
	renderEffortSlider,
	sliderNoteReader,
	thinkingLevelFor,
	ULTRACODE,
	ULTRACODE_LEVEL,
	ULTRACODE_MODE_CHANNEL,
	ULTRACODE_STATUS_KEY,
} from "../../lib/ui/effort-slider.ts";
import { registerLocalCommand } from "../../lib/ui/local-command.ts";
import { readWorkflowSettings } from "../../lib/profile/product-settings.ts";
import { panelUi } from "../../lib/ui/panel-focus.ts";
import { extendingCompletions } from "../../lib/ui/argument-hints.ts";

/** The levels pi says the active model can reach; the full ladder when unknown. */
function supportedLevels(ctx: ExtensionContext): ThinkingLevel[] {
	return [...thinkingLevelsFor(ctx.model).supported];
}

/** A short name for the model, for messages that name what does/doesn't support a level. */
function modelLabel(ctx: ExtensionContext): string {
	return ctx.model?.name ?? ctx.model?.id ?? "this model";
}

const REMINDER_KEY = "ultracode-mode";
const NOTE_KEY = "effort-note";
const NOTE_MS = 5000;

/**
 * The told key of the standing ultracode reminder (the profile's text, like
 * the off notice): a request that carries its first delivery records the
 * block's hash under it (system-reminder). The off notice is said once, when
 * ultracode is off while the model has read the standing block.
 */
const STANDING_TOLD_KEY = stickyFact({ key: REMINDER_KEY, text: "", since: 0 }).key;

/** The `one-code:state` key ultracode is recorded under on the branch. */
const ULTRACODE_STATE = "ultracode";

function effortExtension(pi: ExtensionAPI) {
	const text = requireText("effort");
	/**
	 * What the off notice tells, under the same key: the model last read "off".
	 * The standing block switched on again is then a first delivery once more,
	 * and a later off is told again only after that delivery.
	 */
	const offTold = toldBlockFact(STANDING_TOLD_KEY, text.ultracodeOff);
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
		ctx.ui.setStatus(ULTRACODE_STATUS_KEY, ultracodeActive ? "✦ ultracode" : undefined);
	};

	/**
	 * Claude Code's effort-changed note: "● high · /effort", right-aligned above
	 * the input for a few seconds after the level changes.
	 */
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	const showEffortNote = (ctx: ExtensionContext, level: ThinkingLevel) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(NOTE_KEY, dimRightAlignedWidget(effortNoteText(level, ultracodeActive)), {
			placement: "aboveEditor",
		});
		if (noteTimer) clearTimeout(noteTimer);
		noteTimer = setTimeout(() => ctx.ui.setWidget(NOTE_KEY, undefined), NOTE_MS);
		noteTimer.unref?.();
	};
	// The timer captured the ctx of the turn that changed the level; a /clear or
	// shutdown inside the note's few seconds invalidates that ctx, and pi throws
	// on a stale ctx use. Drop the timer with the session instead.
	const cancelEffortNote = () => {
		if (noteTimer) clearTimeout(noteTimer);
		noteTimer = undefined;
	};
	pi.on("session_start", cancelEffortNote);
	pi.on("session_shutdown", cancelEffortNote);
	const hideEffortNote = (ctx: ExtensionContext) => {
		cancelEffortNote();
		if (ctx.hasUI) ctx.ui.setWidget(NOTE_KEY, undefined);
	};

	/**
	 * The level the tier default is setting: its `thinking_level_select` shows
	 * no note. Set before `setThinkingLevel`, since pi may call this handler
	 * inside that call, and consumed by the matching event.
	 */
	let quietLevel: ThinkingLevel | undefined;
	/** Whether the profile declares any tier level: without one, nothing here runs or records. */
	const declaresLevels = () => Object.keys(activeProfile().defaultThinkingLevels).length > 0;
	/** Record who owns the live level, so a later switch, a resume or a /tree move reads it from the branch. */
	const recordSource = (source: LevelSource, auto = false) => {
		if (declaresLevels()) recordState(pi, TIER_THINKING_STATE, { source, level: pi.getThinkingLevel(), ...(auto ? { auto: true } : {}) } satisfies TierThinkingState);
	};
	/** Set `level` and record who owns it. `quiet`: no effort note for it. `auto`: `/effort auto` set it. */
	const setRecorded = (ctx: ExtensionContext, level: string, source: LevelSource, { quiet = false, auto = false } = {}) => {
		// pi fits the level to the model; the note is skipped for the level it will settle on.
		const settles = thinkingLevelsFor(ctx.model).settle(level as ThinkingLevel);
		if (quiet) quietLevel = settles !== pi.getThinkingLevel() ? settles : undefined;
		pi.setThinkingLevel(level as ThinkingLevel);
		recordSource(source, auto);
	};
	/**
	 * The tier default at a boundary, unless the user chose a level. Applied
	 * as declared: pi fits it to the model, so the level that runs can be
	 * higher than the profile's (`medium` runs as `high` on DeepSeek V4.1
	 * Flash, which has no `medium`). A switch always records who owns the
	 * level after it, so a pick right after the switch reads as the user's.
	 */
	const applyTierDefault = (ctx: ExtensionContext, boundary: "start" | "switch", model: ExtensionContext["model"]) => {
		// getSettings arrived in pi 1.0.1: without it a saved level cannot be seen, so the user's level stays.
		const settings = pi.getSettings?.();
		if (!model || !settings || !declaresLevels()) return;
		// Ultracode's level is the user's: the default never replaces it, and a switch says so.
		if (ultracodeActive) {
			if (boundary === "switch") recordSource("user");
			return;
		}
		const action = tierThinkingAt(boundary, model, settings, levelOwnership(ctx.sessionManager.getBranch()));
		if (action.level !== undefined) {
			setRecorded(ctx, action.level, action.source, { quiet: true });
			// A switch may already show pi's carried level; the default replaced it.
			if (boundary === "switch") hideEffortNote(ctx);
		} else if (boundary === "switch") {
			recordSource(action.source);
		}
	};
	// A new session only: a resumed, forked or reloaded one runs at the level its branch recorded.
	pi.on("session_start", (event, ctx) => {
		if ((event.reason === "startup" || event.reason === "new") && !branchHasMessages(ctx.sessionManager.getBranch())) applyTierDefault(ctx, "start", ctx.model);
	});
	pi.on("model_select", (event, ctx) => {
		if (event.source !== "restore") applyTierDefault(ctx, "switch", event.model);
	});
	// pi keeps the live level across a /tree move: its owner is the one the branch left behind, not the new branch's.
	// Registered before ultracode's own /tree handler (below), which may then set the branch's level as the user's.
	pi.on("session_tree", (event, ctx) => {
		const left = levelOwnership(event.oldLeafId ? ctx.sessionManager.getBranch(event.oldLeafId) : []);
		// An /effort auto on the branch left behind still released the launch level.
		recordSource(left.source, left.launchReleased);
	});

	/** Whether workflows are on for this session, read with workflow's own settings at session start. */
	let workflowsOn = true;
	/** `record` false when the state comes from the branch itself (a resume, a /tree switch). */
	const setUltracode = (on: boolean, level?: ThinkingLevel, { record = true }: { record?: boolean } = {}) => {
		const changed = ultracodeActive !== on || (on && ultracodeLevel !== level);
		ultracodeActive = on;
		ultracodeLevel = on ? level : undefined;
		if (changed) pi.events.emit(ULTRACODE_MODE_CHANNEL, { active: on });
		// Ultracode follows the branch: recorded on every change.
		if (changed && record) recordState(pi, ULTRACODE_STATE, on ? { on, level } : { on });
		// With workflows turned off (enableWorkflows/disableWorkflows) the block's
		// "run a workflow for every task" would steer to a tool the session does
		// not offer, so ultracode is only its reasoning level there (R3-M21).
		if (on && workflowsOn) {
			pi.events.emit(REMINDER_CHANNEL, {
				text: text.ultracodeOn,
				key: REMINDER_KEY,
				placement: "sticky-append",
			});
		} else {
			pi.events.emit(REMINDER_CHANNEL, { remove: true, key: REMINDER_KEY });
		}
	};

	// The off notice derives from what the epoch told, when a request goes out:
	// only a model that read the standing block hears it ended, a switch off and
	// on again before the request says nothing, and the notice's own told fact
	// keeps a /reload or a resume from saying it twice.
	pi.events.on(RENDER_CHANNEL, (data) => {
		const request = data as RenderRequest;
		if (request.epoch || ultracodeActive) return;
		const told = request.toldBlocks.get(STANDING_TOLD_KEY);
		if (told === undefined || told === offTold.hash) return;
		request.blocks.push({ text: text.ultracodeOff, facts: [offTold] });
	});

	const canPersist = (ctx: ExtensionContext) => ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc") && !!ctx.model;
	/** Through pi's own settings writer: its key format, file lock and merge of changed fields. */
	const persist = async (ctx: ExtensionContext, level: PersistedEffort | undefined): Promise<string | undefined> => {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir());
		const loadError = settings.drainErrors().find((entry) => entry.scope === "global");
		// An unreadable file would be rewritten from empty settings; leave it for the user.
		if (loadError) return `Failed to set effort level: ${loadError.error.message}`;
		if (level === undefined) settings.removeModelThinkingLevel(ctx.model!.provider, ctx.model!.id);
		else settings.setModelThinkingLevel(ctx.model!.provider, ctx.model!.id, level);
		await settings.flush();
		const writeError = settings.drainErrors()[0];
		if (writeError) return `Failed to set effort level: ${writeError.error.message}`;
	};
	const report = (ctx: ExtensionContext, message: string, error = false) => {
		ctx.ui.notify(message, error ? "error" : "info");
		return message;
	};

	/** Apply a chosen stop and report what actually took effect. */
	const applyChoice = async (choice: EffortChoice, ctx: ExtensionContext, asDefault = true): Promise<string> => {
		const wasUltracode = ultracodeActive;
		const previous = pi.getThinkingLevel();
		const wanted = thinkingLevelFor(choice);
		pi.setThinkingLevel(wanted);
		const actual = pi.getThinkingLevel();

		setUltracode(choice === ULTRACODE, actual);
		applyStatus(ctx);
		showEffortNote(ctx, actual);

		// setThinkingLevel clamps to model capability silently. Only flag a genuine
		// downward clamp (the model can't reach the requested level); an upward clamp
		// toward the model's floor isn't a "cap" and saying so reads as a bug.
		const wr = levelRank(wanted);
		const ar = levelRank(actual);
		const cappedDown = ar >= 0 && wr >= 0 && ar < wr;
		const note = cappedDown ? ` (${modelLabel(ctx)} tops out at ${actual})` : "";
		// The user's pick, even one equal to the level before (pi records no change then): the tier default leaves it alone.
		const markPicked = () => recordSource("user");
		if (choice === ULTRACODE) {
			markPicked();
			return report(ctx, `Effort: ultracode — ${actual} reasoning, workflows armed every turn${note}`);
		}
		const saved = asDefault && canPersist(ctx) && isPersistedEffort(choice) && actual === wanted;
		if (saved) {
			const error = await persist(ctx, choice);
			if (error) {
				// Claude Code changes nothing when the save fails.
				pi.setThinkingLevel(previous);
				setUltracode(wasUltracode, previous);
				applyStatus(ctx);
				showEffortNote(ctx, previous);
				return report(ctx, error, true);
			}
		}
		markPicked();
		if (isPersistedEffort(actual) || actual === "max") return report(ctx, `${effortSetMessage(actual, saved)}${wasUltracode ? " · Ultracode off" : ""}`);
		return report(ctx, `Effort: ${actual}${note}`);
	};

	const showSlider = async (ctx: ExtensionContext): Promise<string | void> => {
		const supported = supportedLevels(ctx);
		if (!supported.some((level) => level !== "off")) {
			ctx.ui.notify(`${modelLabel(ctx)} doesn't support reasoning effort.`, "info");
			return;
		}
		const enabled = enabledStops(supported);

		// Start on the current stop, snapped onto a stop this model can actually
		// reach so the marker never opens on a dimmed, unselectable level.
		let index = EFFORT_CHOICES.indexOf(choiceForState(pi.getThinkingLevel(), ultracodeActive));
		if (index < 0) index = 0;
		index = nearestEnabled(index, enabled);

		const label = modelLabel(ctx);
		const noteFor = sliderNoteReader(text.sliderNote, (error) =>
			ctx.ui.notify(`The profile's effort slider note failed, so the slider shows none: ${error instanceof Error ? error.message : String(error)}`, "warning"),
		);
		const chosen = await panelUi(pi.events, ctx.ui).custom<{ choice: EffortChoice; asDefault: boolean } | null>((tui, theme, _keybindings, done) => {
			const paint = safeThemePaint(theme);
			return {
				// The slider's own layout is column-safe for its ASCII labels, but this
				// dialog has no linesComponent wrap, so a final truncate is the safety
				// net that guarantees no overwide line reaches pi-tui (TUI-REVIEW H1/H2).
				render: (width: number) =>
					["", ...renderEffortSlider({ index, enabled, width, modelLabel: label, note: noteFor(EFFORT_CHOICES[index]) }, paint), ""].map((line) => truncateLine(line, width)),
				handleInput: (data: string) => {
					const key = decodeKey(data);
					if (!key) return;
					if (key === "cancel") {
						done(null);
						return;
					}
					if (key === "confirm" || key === "session") {
						done({ choice: EFFORT_CHOICES[index], asDefault: key === "confirm" });
						return;
					}
					index = moveIndex(index, key, enabled);
					tui.requestRender();
				},
				invalidate: () => {},
			};
		});

		if (!chosen) return "Cancelled";
		return applyChoice(chosen.choice, ctx, chosen.asDefault);
	};

	registerLocalCommand(pi, "effort", {
		description: `Set reasoning effort (shift+tab cycles the plain levels): /effort [${EFFORT_CHOICES.join("|")}|auto] — ultracode is ${ULTRACODE_LEVEL} + workflows`,
		argumentHint: `[${EFFORT_CHOICES.join("|")}|auto]`,
		reportsResult: true,
		getArgumentCompletions: (prefix) => extendingCompletions(prefix, [...acceptedEffortArgs(), "auto", "unset"].map((value) => ({ value, label: value }))),
		handler: async (args, ctx) => {
			const typed = args.trim();
			if (typed) {
				if (typed.toLowerCase() === "auto" || typed.toLowerCase() === "unset") {
					// Clear the saved level first: a failed save changes nothing.
					const saved = canPersist(ctx);
					if (saved) {
						const error = await persist(ctx, undefined);
						if (error) return report(ctx, error, true);
					}
					// pi's global default, else the tier's, else pi's own. getSettings arrived in pi 1.0.1; a 1.0.0 install has no global default to read.
					const auto = autoThinkingAction({ declared: ctx.model ? declaredLevel(ctx.model) : undefined, globalDefault: pi.getSettings?.().defaultThinkingLevel });
					setRecorded(ctx, auto.level, auto.source, { auto: true });
					setUltracode(false);
					applyStatus(ctx);
					showEffortNote(ctx, pi.getThinkingLevel());
					return report(ctx, `Effort level set to auto${saved ? "" : " (this session only)"}`);
				}
				const parsed = parseEffortArg(typed);
				if (!parsed) {
					ctx.ui.notify(`Unknown effort "${typed}". Use one of: ${acceptedEffortArgs().join(", ")}`, "error");
					return;
				}
				// A plain level the model can't reach would silently clamp to something
				// else; refuse it and name what this model does support instead.
				if (parsed !== ULTRACODE) {
					const supported = supportedLevels(ctx);
					if (!supported.includes(parsed as ThinkingLevel)) {
						ctx.ui.notify(
							`Effort "${parsed}" isn't supported by ${modelLabel(ctx)} — it supports ${supported.join(", ")} (shift+tab cycles these).`,
							"error",
						);
						return;
					}
				}
				return applyChoice(parsed, ctx);
			}

			// The picker needs focus and a terminal; elsewhere say what to type.
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(
					`Current effort: ${ultracodeActive ? `ultracode (${pi.getThinkingLevel()} + workflows)` : pi.getThinkingLevel()}. ` +
						`Set one with /effort <${acceptedEffortArgs().join("|")}|auto>.`,
					"info",
				);
				return;
			}
			return await showSlider(ctx);
		},
	});

	// Cycling thinking with shift+tab away from ultracode's level makes the
	// footer indicator a lie, so drop the mode instead of letting the two drift.
	pi.on("thinking_level_select", (event, ctx) => {
		if (event.level === quietLevel) {
			quietLevel = undefined;
			return;
		}
		if (ultracodeActive && ultracodeLevel !== undefined && event.level !== ultracodeLevel) {
			setUltracode(false);
			applyStatus(ctx);
			ctx.ui.notify(`Ultracode off — reasoning is now ${event.level}`, "info");
		}
		// pi emits without waiting: a level the session has since left (a switch the tier default followed) is not news.
		if (event.level === pi.getThinkingLevel()) showEffortNote(ctx, event.level);
	});

	/**
	 * Take the branch's ultracode state (a resume, /reload, a fork, a /tree
	 * switch). At a session start it is on only while pi's reasoning level,
	 * which pi restores from the branch itself, is still the level ultracode
	 * settled on (a launch `--thinking` flag wins). pi restores no level at a
	 * /tree switch, so there the branch's level is put back with the mode.
	 * When the branch's model read it on and it resolves off, the next request
	 * tells it (the RENDER_CHANNEL listener above).
	 */
	const followBranch = (ctx: ExtensionContext, tree: boolean) => {
		const stored = readState(ctx, ULTRACODE_STATE) as { on?: unknown; level?: unknown } | undefined;
		const storedOn = stored?.on === true && typeof stored.level === "string";
		const on = storedOn && (tree || stored.level === pi.getThinkingLevel());
		setUltracode(on, on ? (stored?.level as ThinkingLevel) : undefined, { record: false });
		if (on && tree && pi.getThinkingLevel() !== stored?.level) pi.setThinkingLevel(stored?.level as ThinkingLevel);
		// Back on a branch that runs ultracode: its level is the user's again, even at the level the old branch's owner left.
		if (on && tree) recordSource("user");
		applyStatus(ctx);
	};
	pi.on("session_start", (_event, ctx) => {
		// Ultracode tells the model to run workflows: never when the workflow tool is off.
		workflowsOn = readWorkflowSettings(ctx.cwd, os.homedir()).enabled && toolLive("workflow");
		followBranch(ctx, false);
	});
	pi.on("session_tree", (_event, ctx) => followBranch(ctx, true));
}

export default feature("effort", effortExtension);
