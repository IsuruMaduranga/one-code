/**
 * tool-search extension — Claude Code's ToolSearch.
 *
 * Deactivates every tool registered in the deferred registry at session start,
 * tells the model which names exist (a system reminder, as Claude Code does),
 * and activates matches additively when the model calls `tool_search`.
 *
 * Load order matters: this extension must come BEFORE any extension that defers
 * a tool, because those emit their defer request while extensions are loading
 * and pi's event bus only delivers to listeners already registered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFER_CHANNEL, deferredRegistry, type DeferRequest, searchTools } from "../lib/deferred.ts";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";

export default function toolSearchExtension(pi: ExtensionAPI) {
	pi.events.on(DEFER_CHANNEL, (data) => {
		deferredRegistry.add(data as DeferRequest);
	});

	const searchableTools = () =>
		pi
			.getAllTools()
			.filter((tool) => deferredRegistry.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				keywords: deferredRegistry.keywordsFor(tool.name),
			}));

	pi.on("session_start", () => {
		const deferred = new Set(deferredRegistry.names);
		if (deferred.size === 0) return;

		const active = pi.getActiveTools().filter((name) => !deferred.has(name));
		pi.setActiveTools(active);

		const available = searchableTools();
		if (available.length === 0) return;
		pi.events.emit(REMINDER_CHANNEL, {
			scope: "every-turn",
			key: "deferred-tools",
			text: [
				"The following tools are available but their schemas are NOT loaded, so they cannot be called yet:",
				...available.map((t) => `- ${t.name}: ${t.description.split("\n")[0]}`),
				"",
				'Load one with tool_search before using it — `select:<name>[,<name>]` for exact names, or keywords to search. Once a schema is loaded it stays callable for the rest of the session.',
			].join("\n"),
		});
	});

	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		description:
			"Load the schemas of tools that are available but not yet callable. Query forms: `select:<name>[,<name>]` to load exact tools by name, `+<term> <words>` to require a term in the tool name, or plain keywords to search. Returns the tools that are now callable.",
		promptSnippet: "tool_search - load additional tool schemas on demand",
		parameters: Type.Object({
			query: Type.String({ description: "Tool names (`select:a,b`) or keywords describing the capability needed" }),
			max_results: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: "Maximum tools to load (default 5)" }),
			),
		}),
		async execute(_toolCallId, params) {
			const available = searchableTools();
			const matches = searchTools(params.query, available, params.max_results ?? 5);

			if (matches.length === 0) {
				const names = available.map((t) => t.name).join(", ") || "(none)";
				return {
					content: [
						{ type: "text", text: `No tools matched "${params.query}". Tools that can be loaded: ${names}` },
					],
					details: { matches: [] as string[], added: [] as string[] },
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
							added.length > 0
								? `Loaded ${added.join(", ")}. These tools are now callable.`
								: `Already loaded: ${loaded.join(", ")}.`,
					},
				],
				details: { matches: loaded, added },
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
