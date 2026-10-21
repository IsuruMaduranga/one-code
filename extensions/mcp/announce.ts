/**
 * What to tell the model when MCP state changes inside an epoch (pure).
 *
 * The MCP instructions and failed-servers reminders are `first-prepend` blocks
 * on message 1. A request that opens an epoch renders them from live state;
 * inside an epoch message 1 is the record (extensions/ledger), so changes ride
 * notices on the request's tail, decided when the request goes out from what
 * the epoch has told (the same rule as the deferred-tools listing). What was
 * told is a whole-text block fact per server (`mcp-instructed:<name>`,
 * `mcp-failed:<name>`): the hash of the instructions or error last told, or of
 * the empty text once a drop or a recovery was announced.
 */

import { mcpFailuresReminder, mcpInstructionsReminder } from "./client.ts";
import type { BlockFact, ToldFact } from "../lib/ledger/records.ts";
import { toldBlockFact } from "../lib/reminders.ts";
import { countNoun } from "../lib/tui-render.ts";

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
	/** What announcing this delta tells, for the request that carries it. */
	facts: ToldFact[];
}

const INSTRUCTED = "mcp-instructed:";
const FAILED = "mcp-failed:";
/** The told hash of "nothing": a drop or a recovery was announced. */
const NONE = toldBlockFact("", "").hash;

/**
 * Store and compare the exact bounded values the reminder puts on the wire.
 * A changing tail beyond either cap is not a model-visible capability change
 * and must not become a false notice.
 */
function displayedInstructions(name: string, instructions: string): string {
	const rendered = mcpInstructionsReminder([{ server: { name }, instructions }]);
	const prefix = "# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n" + `## ${name}\n`;
	return rendered?.startsWith(prefix) ? rendered.slice(prefix.length) : instructions;
}
function displayedFailure(error: string): string {
	return error.split("\n")[0].slice(0, 300);
}

const instructedFact = (name: string, instructions: string): BlockFact => toldBlockFact(INSTRUCTED + name, displayedInstructions(name, instructions));
const failedFact = (name: string, error: string): BlockFact => toldBlockFact(FAILED + name, displayedFailure(error));

/** What message 1's two MCP blocks rendered from `snapshot` tell. */
export function mcpFacts(snapshot: McpSnapshot): ToldFact[] {
	return [
		...snapshot.connected.flatMap((c) => (c.instructions ? [instructedFact(c.name, c.instructions)] : [])),
		...snapshot.failed.map((f) => failedFact(f.name, f.error)),
	];
}

/**
 * What changed since the epoch told `told` (whole-text block hashes by key),
 * and the facts announcing it tells. While the startup connections are still
 * `settling`, a server not connected yet is not a drop.
 */
export function mcpDelta(told: ReadonlyMap<string, string>, snapshot: McpSnapshot, settling = false): McpDelta {
	const connectedNames = new Set(snapshot.connected.map((c) => c.name));
	const failedNames = new Set(snapshot.failed.map((f) => f.name));
	const toldNames = (prefix: string) => [...told].filter(([key, hash]) => key.startsWith(prefix) && hash !== NONE).map(([key]) => key.slice(prefix.length));
	const newInstructions = snapshot.connected
		.filter((c) => c.instructions && told.get(INSTRUCTED + c.name) !== instructedFact(c.name, c.instructions).hash)
		.map((c) => ({ name: c.name, instructions: displayedInstructions(c.name, c.instructions as string) }));
	const newFailures = snapshot.failed
		.filter((f) => told.get(FAILED + f.name) !== failedFact(f.name, f.error).hash)
		.map((f) => ({ name: f.name, error: displayedFailure(f.error) }));
	const recovered = toldNames(FAILED).filter((name) => connectedNames.has(name));
	const dropped = settling ? [] : toldNames(INSTRUCTED).filter((name) => !connectedNames.has(name) && !failedNames.has(name));
	return {
		newInstructions,
		newFailures,
		recovered,
		dropped,
		facts: [
			...newInstructions.map((s) => toldBlockFact(INSTRUCTED + s.name, s.instructions)),
			...newFailures.map((f) => toldBlockFact(FAILED + f.name, f.error)),
			...recovered.map((name) => toldBlockFact(FAILED + name, "")),
			...dropped.map((name) => toldBlockFact(INSTRUCTED + name, "")),
		],
	};
}

/**
 * The notices for a delta, in the order they go on the tail. Empty when
 * nothing changed.
 */
export function mcpChangeNotices(delta: McpDelta): string[] {
	const notices: string[] = [];
	const add = (text: string) => notices.push(text);
	if (delta.recovered.length > 0) {
		add(
			`MCP server${delta.recovered.length === 1 ? "" : "s"} ${delta.recovered.join(", ")} ` +
				"connected after this conversation started (an earlier notice reported a connection failure). " +
				"The server's tools are available as deferred tools — load them with tool_search.",
		);
	}
	if (delta.newInstructions.length > 0) {
		const names = delta.newInstructions.map((s) => s.name);
		add(
			`MCP server${names.length === 1 ? "" : "s"} ${names.join(", ")} connected after this conversation started; ` +
				"the tools are available as deferred tools (load with tool_search). Server instructions:\n\n" +
				mcpInstructionsReminder(delta.newInstructions.map((s) => ({ server: { name: s.name }, instructions: s.instructions }))),
		);
	}
	if (delta.newFailures.length > 0) {
		add(mcpFailuresReminder(delta.newFailures));
	}
	if (delta.dropped.length > 0) {
		add(
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
