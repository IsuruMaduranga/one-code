/**
 * context extension — Claude Code's `/context`: what fills the context
 * window, as a grid of cells and an estimate by category
 * (lib/context/context-usage.ts has the numbers, lib/ui/context-usage-view.ts
 * the screen).
 *
 * It reads; it never sends. The numbers come from the session's last request
 * as the ledger recorded it (the branch's fold, so a resume or a /tree switch
 * reads the branch it is on) and from what the provider reported for its
 * reply. Before the first request, and after a compaction until the next one,
 * they estimate the request the next prompt will send from the parts that
 * build it (`nextRequest`), read through queries that keep, record and tell
 * nothing; nothing here sends a request or touches the prompt cache.
 *
 * Custom agents (project, user and plugin agent files) are their own category,
 * by the Agent tool extension's answer on AGENT_GROUPS_QUERY_CHANNEL; with no
 * answer every agent row stays in System tools.
 *
 * In the fullscreen TUI each list (MCP tools, custom agents, memory files, skills) shows as one
 * count-and-tokens row, and `/context all` expands them, as Claude Code
 * 2.1.330 does (`collapseDetailSections`); regular mode, RPC and one-shot runs
 * always get the full lists.
 *
 * Shown as a local command result, like `/doctor report`: in the TUI a
 * display-only transcript entry (appendEntry: never in the model's context)
 * drawn at the terminal's width; in RPC a plain-text notice; in a one-shot
 * run printed. The model reads a Markdown report instead (`contextReport`),
 * the command's stdout in the breadcrumb the next prompt carries
 * (`registerLocalCommand` with `reportsResult`), as Claude Code passes the
 * screen as display-only and the report as its meta message (findings §101).
 */

import * as os from "node:os";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { branchUsage, type BreakdownOptions, breakdownRequest, type ContextUsage, contextUsage, previewRequest } from "../../lib/context/context-usage.ts";
import { queryDeferred } from "../../lib/request/deferred.ts";
import { queryAgentGroups } from "../../lib/agents/agent-catalog.ts";
import { projectConfigDirName } from "../../lib/profile/sources.ts";
import { renderReminders, STACK_QUERY_CHANNEL, type StackQuery } from "../../lib/request/reminders.ts";
import { instructionRole, messagesKey, systemRoleLayout, withSystemRoleContext } from "../../lib/request/system-role.ts";
import { requestSystemPrompt } from "../../lib/ui/prompt-options.ts";
import { canShowCustomUi, printAnswer } from "../../lib/notify/headless-output.ts";
import { brandedId } from "../../lib/profile/brand.mjs";
import { feature } from "../../lib/profile/feature.ts";
import { isPathAtOrUnder, relativeDisplayPath, tildify } from "../../lib/profile/paths.ts";
import { sessionIdentity } from "../../lib/request/anthropic-auth.ts";
import { foldSession } from "../../lib/request/ledger/fold-memo.ts";
import { contextReport, renderContextUsage } from "../../lib/ui/context-usage-view.ts";
import { registerLocalCommand } from "../../lib/ui/local-command.ts";
import { linesComponent, safeThemeBold, safeThemePaint } from "../../lib/ui/tui-render.ts";
import { USER_MARKER } from "../../lib/ui/user-message.ts";

const ENTRY_TYPE = brandedId("context-usage");

/** The width the plain text (stdout, RPC, one-shot) is laid out for: wide enough for the full grid beside its legend. */
const TEXT_WIDTH = 100;

interface ContextEntryData {
	usage: ContextUsage;
	/** Drawn with each list collapsed to one row (fullscreen, no `all`). */
	collapsed?: boolean;
	/** What followed `/context` on the command line, echoed above the result. */
	args?: string;
}

/** The custom-agents section's note: the profile's project config folder plus `agents/`. */
const agentsDir = () => `${projectConfigDirName()}/agents/`;

/**
 * Whether pi's TUI runs fullscreen: its startup rule, the `--tui-mode` flag
 * over the `tuiMode` setting (default fullscreen). pi exposes no live mode to
 * an extension, so a mode switched later in the session is not seen here.
 */
function fullscreenTui(ctx: ExtensionCommandContext): boolean {
	const at = process.argv.indexOf("--tui-mode");
	const flag = at >= 0 ? process.argv[at + 1] : undefined;
	if (flag === "regular" || flag === "fullscreen") return flag === "fullscreen";
	try {
		return SettingsManager.create(ctx.cwd, getAgentDir()).getTuiMode() !== "regular";
	} catch {
		return true;
	}
}

/** pi's auto-compaction settings for `model`, or none when its settings cannot be read. */
function compactionSettings(ctx: ExtensionCommandContext): { enabled: boolean; reserveTokens: number } | undefined {
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionSettings(ctx.model);
		return { enabled: settings.enabled, reserveTokens: settings.reserveTokens };
	} catch {
		return undefined;
	}
}

function contextExtension(pi: ExtensionAPI) {
	const measure = (ctx: ExtensionCommandContext): ContextUsage => {
		const home = os.homedir();
		const displayPath = (path: string) => (isPathAtOrUnder(path, ctx.cwd) ? relativeDisplayPath(ctx.cwd, path) : tildify(path, home));
		const agentGroups = queryAgentGroups(pi.events, ctx.cwd);
		const branch = ctx.sessionManager.getBranch() as Parameters<typeof branchUsage>[0];
		const last = foldSession(ctx.sessionManager, sessionIdentity(pi, ctx.model)).lastRequest;
		const replied = branchUsage(branch);
		const piUsage = ctx.getContextUsage();
		// A recorded request describes the context until a compaction replaces it; before one, or after a compaction, estimate the next.
		const recorded = last && !replied.compacted ? last : undefined;
		const preview = recorded ? undefined : replied.compacted ? "compaction" : "first";
		const next = recorded ? undefined : nextBreakdown(ctx, { displayPath, agentGroups });
		const breakdown = recorded ? breakdownRequest({ api: recorded.identity.api, head: recorded.head, list: recorded.list }, { displayPath, agentGroups }) : next?.breakdown;
		return contextUsage({
			model: { name: ctx.model?.name ?? "No model", id: ctx.model?.id ?? "" },
			window: piUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
			compaction: compactionSettings(ctx),
			compacted: replied.compacted,
			breakdown,
			...(breakdown && preview ? { preview } : {}),
			...(next?.error !== undefined ? { estimateError: next.error } : {}),
			reported: recorded && replied.prompt !== undefined && typeof piUsage?.tokens === "number" ? { prompt: replied.prompt, total: piUsage.tokens } : undefined,
		});
	};

	/** The breakdown of the request the next prompt will send, or why estimating it failed: a broken estimate must not break /context, and the screen names the failure. */
	const nextBreakdown = (ctx: ExtensionCommandContext, options: BreakdownOptions): { breakdown?: ReturnType<typeof breakdownRequest>; error?: string } => {
		try {
			return { breakdown: breakdownRequest(nextRequest(ctx), options) };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	};

	/**
	 * The request the next prompt will send, from the parts that build it, each
	 * read without effect: the system prompt the system-prompt extension builds
	 * from pi's base options, the active tools tool-search has not deferred, and
	 * the live first-message stack placed by the real renderer on the
	 * conversation pi would send (none before the first prompt; the summary and
	 * kept tail after a compaction) plus an empty stand-in for the prompt.
	 */
	const nextRequest = (ctx: ExtensionCommandContext) => {
		const systemPrompt = requestSystemPrompt(pi.events, ctx, ctx.getSystemPromptOptions()) ?? ctx.getSystemPrompt();
		const deferred = queryDeferred(pi.events).map((tool) => tool.name);
		const skip = new Set(deferred);
		const active = new Set(pi.getActiveTools());
		const tools = pi.getAllTools().filter((tool) => active.has(tool.name) && !skip.has(tool.name));
		const query: StackQuery = { ctx };
		pi.events.emit(STACK_QUERY_CHANNEL, query);
		// Owners that would queue their block at the first prompt append it: back into Claude Code's order.
		const stack = (query.stack ?? []).map((entry, at) => ({ entry, at })).sort((a, b) => a.entry.order - b.entry.order || a.at - b.at).map(({ entry }) => entry);
		const messages = ctx.sessionManager
			.buildSessionProjection()
			.messages.filter((message) => message.role !== "system");
		const prompt = { role: "user", content: [], timestamp: Date.now() } as unknown as AgentMessage;
		const layout = systemRoleLayout(ctx.model);
		const placed = renderReminders([...messages, prompt], {
			epoch: true,
			layout: layout !== undefined,
			stack,
			sticky: (query.sticky ?? []).map((entry) => ({ ...entry, delivered: false })),
			oneShots: [],
		});
		// On a model that takes a mid-conversation system message, the session facts move there, unframed, as system-reminder's payload hook moves them.
		const lifted = layout && ctx.model ? withSystemRoleContext({ [messagesKey(layout)]: placed.messages }, layout, placed.moved, instructionRole(layout, ctx.model))?.[messagesKey(layout)] : undefined;
		return previewRequest({ systemPrompt, tools, deferred, list: Array.isArray(lifted) ? lifted : placed.messages });
	};

	pi.registerEntryRenderer<ContextEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const usage = entry.data?.usage;
		if (!usage) return undefined;
		const paint = safeThemePaint(theme);
		const bold = safeThemeBold(theme);
		const collapsed = entry.data?.collapsed === true;
		const args = entry.data?.args ? ` ${entry.data.args}` : "";
		// The command line above its result, as Claude Code's transcript shows it.
		return linesComponent((width) => [`${paint("dim", USER_MARKER)} /context${args}`, ...renderContextUsage(usage, { width, paint, bold, collapsed, agentsDir: agentsDir() })]);
	});

	registerLocalCommand(pi, "context", {
		description: "Show what fills the context (all: expand every list)",
		reportsResult: true,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const usage = measure(ctx);
			const ui = canShowCustomUi(ctx);
			// Claude Code collapses the lists only in its fullscreen presentation, unless asked for all.
			const collapsed = ui && args.trim().toLowerCase() !== "all" && fullscreenTui(ctx);
			// People see the screen; the model reads the Markdown report, the same in every presentation (findings §101).
			const screen = () => renderContextUsage(usage, { width: TEXT_WIDTH, agentsDir: agentsDir() }).join("\n");
			if (ui) pi.appendEntry<ContextEntryData>(ENTRY_TYPE, { usage, collapsed, args: args.trim() });
			else if (ctx.hasUI) ctx.ui.notify(screen(), "info");
			else printAnswer(ctx, screen());
			return contextReport(usage);
		},
	});
}

export default feature("context", contextExtension);
