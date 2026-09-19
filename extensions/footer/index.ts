/**
 * footer extension — replaces pi's built-in status line with One Code's own via
 * `ctx.ui.setFooter`. A single line: path + branch on the left; context fill,
 * all-in cost, cache-hit health, PR number, model, and effort on the right.
 *
 * pi's footer only ever sees the main session's usage. Here the cost figure is a
 * true total: the main session (from its entries, exactly as pi computes it)
 * plus every out-of-band LLM call (in-process subagents, the auto-mode
 * classifier, and the reader-style one-shots — web-fetch, recap, and auto-mode
 * setup — via the shared withReasoningFallback wrapper). Those are persisted as
 * `one-code:usage` session entries by `recordUsage`, so the total survives a
 * `--continue`/`--session` restart; the usage bus is only the live repaint
 * signal. The effort label
 * after the model reads the live thinking level, and swaps to "✦ ultracode" when
 * the effort extension has published that status.
 *
 * Set CC_FOOTER=0 to keep pi's built-in footer instead.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { linesComponent, safeThemePaint } from "../lib/tui-render.ts";
import { formatModel, isRealModel } from "../permissions/modes.ts";
import { ULTRACODE_STATUS_KEY } from "../effort/slider.ts";
import { USAGE_CHANNEL } from "../lib/usage-bus.ts";
import { buildFooterLines, computeMainUsage, footerLocation, type FooterData } from "./footer-line.ts";
import { WORKTREE_CHANNEL, type WorktreeLocation } from "../lib/worktree-channel.ts";
import { fetchPrNumber } from "./pr.ts";

export default function footerExtension(pi: ExtensionAPI) {
	if (process.env.CC_FOOTER === "0") return;

	// All-in cost + latest cache-hit, recomputed only when the session's entries
	// change (message_end/agent_end, and a usage entry landing) — an O(n)
	// transcript scan that must NOT run on every repaint (model/effort events
	// change no entry).
	let mainUsage: { cost: number; cacheHitPercent?: number } = { cost: 0 };
	let lastCtx: ExtensionContext | undefined;
	let pr: number | undefined;
	/** Bumped per branch change so a slow gh lookup for an old branch is ignored. */
	let prToken = 0;

	/** Invalidate the memoized line and repaint; set once the footer mounts. */
	let repaint = () => {};
	/** The active worktree session, if any; shown in place of the process cwd + branch. */
	let worktree: WorktreeLocation | null = null;
	/** Re-point the PR lookup at the location currently shown; set once the footer mounts. */
	let refreshLocation = () => {};

	pi.events.on(WORKTREE_CHANNEL, (data: unknown) => {
		worktree = data as WorktreeLocation | null;
		refreshLocation();
		repaint();
	});

	const recomputeMain = (ctx: ExtensionContext) => {
		lastCtx = ctx;
		mainUsage = computeMainUsage(ctx.sessionManager.getEntries());
	};

	// A usage entry was just appended (recordUsage persists before it emits):
	// re-sum the ledger. Known limitation: a background subagent spawned before
	// a /clear (newSession) keeps reporting after the switch, so its late cost
	// is persisted into — and shown for — the new session. Rare (only a
	// *background* subagent outlives a turn — classifier/reader/recap/setup all
	// finish synchronously), and it only nudges a display figure, so we accept
	// it rather than thread session identity through the bus.
	pi.events.on(USAGE_CHANNEL, () => {
		if (lastCtx) recomputeMain(lastCtx);
		repaint();
	});

	const refreshPr = (cwd: string, branch: string | null) => {
		const token = ++prToken;
		if (!branch) {
			pr = undefined;
			repaint();
			return;
		}
		void fetchPrNumber(cwd, branch).then((found) => {
			if (token !== prToken) return; // a newer branch superseded this lookup
			pr = found;
			repaint();
		});
	};

	pi.on("session_start", (_event, ctx) => {
		recomputeMain(ctx);
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui: unknown, theme: unknown, footerData: unknown) => {
			const paint = safeThemePaint(theme);
			const fd = footerData as {
				getGitBranch(): string | null;
				getExtensionStatuses(): ReadonlyMap<string, string>;
				/** Returns the unsubscribe (pi keeps callbacks in a Set for the process lifetime). */
				onBranchChange(cb: () => void): () => void;
			};

			/** The path + branch shown, and the PR looked up: the worktree's while one is active. */
			const currentLocation = () => footerLocation(ctx.cwd, fd.getGitBranch() ?? undefined, worktree);

			const snapshot = (): FooterData => {
				const usage = ctx.getContextUsage();
				const ultracode = fd.getExtensionStatuses().get(ULTRACODE_STATUS_KEY);
				const effort = ultracode ?? safeThinkingLevel(ctx);
				const model = ctx.model;
				const location = currentLocation();
				return {
					cwd: location.cwd,
					home: process.env.HOME || process.env.USERPROFILE || "",
					branch: location.branch,
					contextTokens: usage?.tokens ?? undefined,
					contextWindow: usage?.contextWindow,
					contextPercent: usage?.percent,
					cost: mainUsage.cost,
					cacheHitPercent: mainUsage.cacheHitPercent,
					pr,
					model: model && isRealModel(model.id) ? formatModel(model.provider, model.id) : "none",
					effort,
				};
			};

			const component = linesComponent((width) => buildFooterLines(snapshot(), width, paint));
			repaint = () => {
				component.invalidate();
				(tui as { requestRender?: () => void } | undefined)?.requestRender?.();
			};

			// The branch drives the PR lookup; seed it now and follow changes. The
			// factory re-runs on every session_start (/clear, /new, resume) and pi
			// only disposes the component, so the subscription must be released
			// here — otherwise each replaced footer keeps firing its `gh pr list`
			// against a stale cwd on every branch change.
			refreshLocation = () => {
				const location = currentLocation();
				refreshPr(location.cwd, location.branch ?? null);
			};
			refreshLocation();
			const stopFollowingBranch = fd.onBranchChange(() => {
				refreshLocation();
				repaint();
			});

			return Object.assign(component, {
				dispose: () => {
					stopFollowingBranch();
					repaint = () => {};
					refreshLocation = () => {};
				},
			});
		});
	});

	// The main session's own entries changed: refresh the cached main-usage (the
	// only place the O(n) transcript scan runs), then repaint.
	pi.on("message_end", (_event, ctx) => {
		recomputeMain(ctx);
		repaint();
	});
	pi.on("agent_end", (_event, ctx) => {
		recomputeMain(ctx);
		repaint();
	});
	// Model/effort switches change only the label; no main-usage recompute needed.
	pi.on("model_select", () => repaint());
	pi.on("thinking_level_select", () => repaint());
}

/** Current effort/thinking level as a short label, or undefined if unavailable. */
function safeThinkingLevel(ctx: ExtensionContext): string | undefined {
	return ctx.thinkingLevel;
}
