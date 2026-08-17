/**
 * tool-search extension — Claude Code's ToolSearch.
 *
 * Deactivates every tool registered in the deferred registry at session start,
 * tells the model which names exist (a system reminder, as Claude Code does),
 * and activates matches additively when the model calls `tool_search`.
 *
 * Deferral runs on ALL model tiers, matching Claude Code: capture-confirmed that
 * current CC (v2.1.224/226) defers the niche/long-tail tools behind ToolSearch
 * even on Haiku, keeping only the core set eager (findings §14). Which tools are
 * deferrable is decided per tool (extensions opt in via DEFER_CHANNEL) — core
 * tools like read/edit/write/bash never register, so they stay eager.
 *
 * The mechanism is provider-independent: `pi.setActiveTools` edits the agent's
 * active tool set (`agent.state.tools`), which IS what pi sends, so a deactivated
 * tool is omitted from the request on any provider (OpenRouter, deepseek, etc.).
 * Provider-native deferral (Anthropic `defer_loading`, OpenAI `tool_search_call`)
 * is only a cache optimization on top; without it, loading a tool mid-session
 * grows the tools array and invalidates the prompt cache from the tools block
 * down — an accepted tradeoff (findings §7).
 *
 * Load order matters: this extension must come BEFORE any extension that defers
 * a tool, because those emit their defer request while extensions are loading
 * and pi's event bus only delivers to listeners already registered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFER_CHANNEL,
	deferredMissReminderText,
	deferredRegistry,
	deferredReminderText,
	type DeferRequest,
	resultText,
	searchTools,
	selectedNames,
	toolNotFoundName,
} from "../lib/deferred.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";

export default function toolSearchExtension(pi: ExtensionAPI) {
	let sessionStarted = false;

	const searchableTools = () =>
		pi
			.getAllTools()
			.filter((tool) => deferredRegistry.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				keywords: deferredRegistry.keywordsFor(tool.name),
			}));

	const announceDeferred = () => {
		const available = searchableTools();
		if (available.length === 0) return;
		pi.events.emit(REMINDER_CHANNEL, {
			scope: "every-turn",
			key: "deferred-tools",
			text: deferredReminderText(available),
			placement: "first-prepend",
			order: CONTEXT_ORDER.deferredTools,
		});
	};

	/** Deactivate every deferred-registry tool and announce the loadable set. */
	const deferAll = () => {
		const deferred = new Set(deferredRegistry.names);
		if (deferred.size === 0) return;
		const active = pi.getActiveTools();
		const next = active.filter((name) => !deferred.has(name));
		if (next.length !== active.length) pi.setActiveTools(next);
		announceDeferred();
	};

	pi.events.on(DEFER_CHANNEL, (data) => {
		const request = data as DeferRequest;
		deferredRegistry.add(request);
		// A defer arriving after the session_start pass (MCP servers connect
		// asynchronously and register their tools then) would otherwise leave the
		// tool eager AND unlisted in the reminder. Deactivate it and refresh the
		// keyed reminder.
		if (sessionStarted && request?.name) {
			const active = pi.getActiveTools();
			if (active.includes(request.name)) {
				pi.setActiveTools(active.filter((name) => name !== request.name));
			}
			announceDeferred();
		}
	});

	pi.on("session_start", () => {
		sessionStarted = true;
		deferAll();
	});

	// The every-turn deferred-tools list tells the model to load via tool_search,
	// but if it calls a deferred tool directly anyway, pi's core dispatcher fails
	// the call with a bare "Tool <name> not found" — which fires here as an error
	// tool_execution_end. (This path skips beforeToolCall/afterToolCall, so the
	// tool_call/tool_result hooks never see it.) The call can't be salvaged
	// mid-turn, but we steer the model straight back to tool_search on its next
	// step with a one-shot reminder, far more pointed than the standing list.
	pi.on("tool_execution_end", (event) => {
		if (!event.isError) return;
		const name = toolNotFoundName(resultText(event.result));
		if (!name || !deferredRegistry.has(name)) return;
		pi.events.emit(REMINDER_CHANNEL, {
			scope: "next-turn",
			key: `deferred-miss-${name}`,
			text: deferredMissReminderText(name),
		});
	});

	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		...ccToolRenderers("Tool Search"),
		description:
			"Load the schemas of tools that are available but not yet callable. Query forms: `select:<name>[,<name>]` to load exact tools by name, `+<term> <words>` to require a term in the tool name, or plain keywords to search. Returns the tools that are now callable.",
		promptSnippet: "Load additional tool schemas on demand",
		parameters: Type.Object({
			query: Type.String({ description: "Tool names (`select:a,b`) or keywords describing the capability needed" }),
			max_results: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: "Maximum tools to load (default 5)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const available = searchableTools();
			const matches = searchTools(params.query, available, params.max_results ?? 5);

			// For an exact `select:` query, a requested name that matched nothing was
			// silently dropped before — the model was told the rest "Loaded" and only
			// discovered the miss later as an opaque InputValidationError. Always
			// surface the unmatched names.
			const requested = selectedNames(params.query);
			const notFound = requested
				? requested.filter((n) => !matches.some((m) => m.name.toLowerCase() === n))
				: [];
			const notFoundNote =
				notFound.length > 0
					? ` Not found (not deferred tool names — check spelling, or search by keyword instead of \`select:\`): ${notFound.join(", ")}.`
					: "";

			if (matches.length === 0) {
				const names = available.map((t) => t.name).join(", ") || "(none)";
				return {
					content: [
						{ type: "text", text: `No tools matched "${params.query}".${notFoundNote} Tools that can be loaded: ${names}` },
					],
					details: { matches: [] as string[], added: [] as string[], notFound },
					isError: true,
				};
			}

			const active = pi.getActiveTools();
			const added = matches.map((m) => m.name).filter((name) => !active.includes(name));
			if (added.length > 0) {
				pi.setActiveTools([...new Set([...active, ...added])]);
			}

			const loaded = matches.map((m) => m.name);
			return {
				content: [
					{
						type: "text",
						text:
							(added.length > 0
								? `Loaded ${added.join(", ")}. These tools are now callable.`
								: `Already loaded: ${loaded.join(", ")}.`) + notFoundNote,
					},
				],
				details: { matches: loaded, added, notFound },
			};
		},
	});

	pi.registerCommand("tools-deferred", {
		description: "Show which tools are deferred (loadable via tool_search)",
		handler: async (_args, ctx) => {
			const available = searchableTools();
			const activeSet = new Set(pi.getActiveTools());
			const lines = available.map((t) => `${activeSet.has(t.name) ? "loaded " : "deferred"} ${t.name}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No deferred tools registered.", "info");
		},
	});
}
