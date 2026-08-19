/**
 * footer extension — replaces pi's built-in status line with One Code's own via
 * `ctx.ui.setFooter`. A single line: path + branch on the left; context fill,
 * all-in cost, cache-hit health, PR number, model, and effort on the right.
 *
 * pi's footer only ever sees the main session's usage. Here the cost figure is a
 * true total: the main session (from its entries, exactly as pi computes it)
 * plus every out-of-band LLM call reported on the usage bus (in-process
 * subagents, the auto-mode classifier, and the reader-style one-shots — web-fetch,
 * recap, and auto-mode setup — via the shared withReasoningFallback wrapper). The effort label
 * after the model reads the live thinking level, and swaps to "✦ ultracode" when
 * the effort extension has published that status.
 *
 * Set CC_FOOTER=0 to keep pi's built-in footer instead.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { linesComponent, safeThemePaint } from "../lib/tui-render.ts";
import { formatModel } from "../permissions/modes.ts";
import { ULTRACODE_STATUS_KEY } from "../effort/slider.ts";
import { USAGE_CHANNEL, type UsageRecord } from "../lib/usage-bus.ts";
import { buildFooterLines, computeMainUsage, type FooterData } from "./footer-line.ts";
import { fetchPrNumber } from "./pr.ts";

export default function footerExtension(pi: ExtensionAPI) {
	if (process.env.CC_FOOTER === "0") return;

	// Out-of-band cost accumulated from the usage bus, on top of the main-session
	// total. Reset per session so the footer tracks the current session.
	let extraCost = 0;
	// Main-session cost + latest cache-hit, recomputed only when the main session's
	// own entries change (message_end/agent_end) — an O(n) transcript scan that must
	// NOT run on every repaint (usage-bus/model/effort events change neither).
	let mainUsage: { cost: number; cacheHitPercent?: number } = { cost: 0 };
	let pr: number | undefined;
	/** Bumped per branch change so a slow gh lookup for an old branch is ignored. */
	let prToken = 0;

	/** Invalidate the memoized line and repaint; set once the footer mounts. */
	let repaint = () => {};

	const recomputeMain = (ctx: ExtensionContext) => {
		mainUsage = computeMainUsage(ctx.sessionManager.getEntries());
	};

	// Known limitation: a background subagent spawned before a /clear (newSession)
	// keeps reporting here after session_start has reset extraCost, so its late
	// cost lands in the new session's total. Rare (only a *background* subagent
	// outlives a turn — classifier/reader/recap/setup all finish synchronously),
	// and it only nudges a display figure, so we accept it rather than thread
	// session identity through the bus.
	pi.events.on(USAGE_CHANNEL, (data) => {
		extraCost += (data as UsageRecord).cost;
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
		extraCost = 0;
		recomputeMain(ctx);
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui: unknown, theme: unknown, footerData: unknown) => {
			const paint = safeThemePaint(theme);
			const fd = footerData as {
				getGitBranch(): string | null;
				getExtensionStatuses(): ReadonlyMap<string, string>;
				onBranchChange(cb: () => void): void;
			};

			const snapshot = (): FooterData => {
				const usage = ctx.getContextUsage();
				const ultracode = fd.getExtensionStatuses().get(ULTRACODE_STATUS_KEY);
				const effort = ultracode ?? safeThinkingLevel(ctx);
				return {
					cwd: ctx.cwd,
					home: process.env.HOME || process.env.USERPROFILE || "",
					branch: fd.getGitBranch() ?? undefined,
					contextTokens: usage?.tokens ?? undefined,
					contextWindow: usage?.contextWindow,
					contextPercent: usage?.percent,
					cost: mainUsage.cost + extraCost,
					cacheHitPercent: mainUsage.cacheHitPercent,
					pr,
					model: ctx.model ? formatModel(ctx.model.provider, ctx.model.id) : undefined,
					effort,
				};
			};

			const component = linesComponent((width) => buildFooterLines(snapshot(), width, paint));
			repaint = () => {
				component.invalidate();
				(tui as { requestRender?: () => void } | undefined)?.requestRender?.();
			};

			// The branch drives the PR lookup; seed it now and follow changes.
			refreshPr(ctx.cwd, fd.getGitBranch());
			fd.onBranchChange(() => {
				refreshPr(ctx.cwd, fd.getGitBranch());
				repaint();
			});

			return Object.assign(component, {
				dispose: () => {
					repaint = () => {};
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
