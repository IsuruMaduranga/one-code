/**
 * What to tell the model when MCP state changes after the first request (pure).
 *
 * The MCP instructions and failed-servers reminders are `first-prepend` blocks
 * on message 1. Before the first request they are simply (re)written; after it
 * message 1 is part of every request's cached prefix, so they are FROZEN and
 * changes ride one-shot notices where the model reads next (same rule as the
 * deferred-tools listing, tool-search/announce.ts). `McpAnnounced` records what
 * the model has been told; `mcpDelta` compares it with the live state.
 */

import { mcpFailuresReminder, mcpInstructionsReminder } from "./client.ts";
import { countNoun } from "../lib/tui-render.ts";

export interface McpAnnounced {
	/** Servers whose instructions the model has been given, with the text it saw. */
	instructed: Map<string, string>;
	/** Servers the model has been told failed, with the error it saw. */
	failed: Map<string, string>;
}

export interface McpSnapshot {
	connected: Array<{ name: string; instructions?: string }>;
	failed: Array<{ name: string; error: string }>;
}

export interface McpDelta {
	/** Connected servers whose instructions the model has not seen (a new server, or new text after a reconnect). */
	newInstructions: Array<{ name: string; instructions: string }>;
	/** Failures the model has not been told about (a new server, or a new error). */
	newFailures: Array<{ name: string; error: string }>;
	/** Servers the model was told had failed that are connected now. */
	recovered: string[];
	/** Servers whose instructions the model saw that are no longer connected and not reported failed. */
	dropped: string[];
}

export function emptyAnnounced(): McpAnnounced {
	return { instructed: new Map(), failed: new Map() };
}

/**
 * Store and compare the exact bounded values the reminder puts on the wire.
 * A changing tail beyond either cap is not a model-visible capability change
 * and must not become a false resume addendum.
 */
function displayedInstructions(name: string, instructions: string): string {
	const rendered = mcpInstructionsReminder([{ server: { name }, instructions }]);
	const prefix = "# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n" + `## ${name}\n`;
	return rendered?.startsWith(prefix) ? rendered.slice(prefix.length) : instructions;
}
function displayedFailure(error: string): string {
	return error.split("\n")[0].slice(0, 300);
}

/** Maps are serialized as entry arrays so arbitrary server instructions/errors round-trip exactly. */
export interface McpAnnouncedBaseline { instructed: Array<[string, string]>; failed: Array<[string, string]> }
export function serializeMcpAnnounced(announced: McpAnnounced): McpAnnouncedBaseline {
	return { instructed: [...announced.instructed], failed: [...announced.failed] };
}
/** Best-effort compatibility reader for stacks written before structured MCP baselines. */
export function mcpAnnouncedFromReminders(instructions: string | undefined, failures: string | undefined): McpAnnounced {
	const announced = emptyAnnounced();
	const instructionPrefix = "# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n";
	if (instructions?.startsWith(instructionPrefix)) {
		for (const section of instructions.slice(instructionPrefix.length).split("\n\n## ")) {
			const normalized = section.startsWith("## ") ? section.slice(3) : section;
			const newline = normalized.indexOf("\n");
			if (newline > 0) announced.instructed.set(normalized.slice(0, newline), normalized.slice(newline + 1));
		}
	}
	const failurePrefix = "The following MCP servers are configured but failed to connect — their tools (typically named mcp__<server>__*) are unavailable for this session:\n";
	if (failures?.startsWith(failurePrefix)) {
		for (const line of failures.slice(failurePrefix.length).split("\n")) {
			if (!line.startsWith("- ")) break;
			const colon = line.indexOf(": ", 2);
			if (colon > 2) announced.failed.set(line.slice(2, colon), line.slice(colon + 2));
		}
	}
	return announced;
}

export function mcpAnnouncedBaseline(value: unknown): McpAnnounced | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const pairs = (item: unknown): Array<[string, string]> | undefined =>
		Array.isArray(item) && item.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string")
			? item as Array<[string, string]>
			: undefined;
	const instructed = pairs(input.instructed);
	const failed = pairs(input.failed);
	return instructed && failed ? { instructed: new Map(instructed), failed: new Map(failed) } : undefined;
}

/** What message 1 says after it was (re)written from `snapshot`, before the first request. */
export function announcedFrom(snapshot: McpSnapshot): McpAnnounced {
	return {
		instructed: new Map(
			snapshot.connected.filter((c) => c.instructions).map((c) => [c.name, displayedInstructions(c.name, c.instructions as string)]),
		),
		failed: new Map(snapshot.failed.map((f) => [f.name, displayedFailure(f.error)])),
	};
}

export function mcpDelta(announced: McpAnnounced, snapshot: McpSnapshot): McpDelta {
	const connectedNames = new Set(snapshot.connected.map((c) => c.name));
	const failedNames = new Set(snapshot.failed.map((f) => f.name));
	return {
		newInstructions: snapshot.connected
			.filter((c) => c.instructions && announced.instructed.get(c.name) !== displayedInstructions(c.name, c.instructions as string))
			.map((c) => ({ name: c.name, instructions: displayedInstructions(c.name, c.instructions as string) })),
		newFailures: snapshot.failed
			.filter((f) => announced.failed.get(f.name) !== displayedFailure(f.error))
			.map((f) => ({ name: f.name, error: displayedFailure(f.error) })),
		recovered: [...announced.failed.keys()].filter((name) => connectedNames.has(name)),
		dropped: [...announced.instructed.keys()].filter((name) => !connectedNames.has(name) && !failedNames.has(name)),
	};
}

export function applyMcpDelta(announced: McpAnnounced, delta: McpDelta): void {
	for (const s of delta.newInstructions) announced.instructed.set(s.name, s.instructions);
	for (const f of delta.newFailures) announced.failed.set(f.name, f.error);
	for (const name of delta.recovered) announced.failed.delete(name);
	for (const name of delta.dropped) announced.instructed.delete(name);
}

/** One-shot notice texts for a delta, in the order they should be queued. Empty when nothing changed. */
export function mcpChangeNotices(delta: McpDelta): string[] {
	const notices: string[] = [];
	if (delta.recovered.length > 0) {
		notices.push(
			`MCP server${delta.recovered.length === 1 ? "" : "s"} ${delta.recovered.join(", ")} ` +
				"connected after this conversation started (an earlier notice reported a connection failure). " +
				"The server's tools are available as deferred tools — load them with tool_search.",
		);
	}
	if (delta.newInstructions.length > 0) {
		const names = delta.newInstructions.map((s) => s.name);
		notices.push(
			`MCP server${names.length === 1 ? "" : "s"} ${names.join(", ")} connected after this conversation started; ` +
				"the tools are available as deferred tools (load with tool_search). Server instructions:\n\n" +
				mcpInstructionsReminder(delta.newInstructions.map((s) => ({ server: { name: s.name }, instructions: s.instructions }))),
		);
	}
	if (delta.newFailures.length > 0) {
		notices.push(mcpFailuresReminder(delta.newFailures));
	}
	if (delta.dropped.length > 0) {
		notices.push(
			`MCP server${delta.dropped.length === 1 ? "" : "s"} ${delta.dropped.join(", ")} disconnected; ` +
				'their tools answer "not connected" until the server is reconnected (the user can do that in /mcp).',
		);
	}
	return notices;
}

/**
 * The user's startup notices, Claude Code's wording (`useMcpConnectivityStatus`):
 * `2 MCP servers failed · /mcp` and `1 MCP server needs auth · /mcp`, with each
 * server's error left to /mcp. Printing every server's raw error ("fetch
 * failed" per remote server when offline) buried the prompt.
 */
export function mcpStartupNotices(failedServers: number, needsAuth: number): string[] {
	const out: string[] = [];
	if (failedServers > 0) out.push(`${countNoun(failedServers, "MCP server")} failed · /mcp`);
	if (needsAuth > 0) out.push(`${countNoun(needsAuth, "MCP server")} ${needsAuth === 1 ? "needs" : "need"} auth · /mcp`);
	return out;
}
