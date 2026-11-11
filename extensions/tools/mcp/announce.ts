/**
 * What to tell the model when MCP state changes inside an epoch (pure).
 *
 * The MCP instructions and failed-servers reminders are `first-prepend` blocks
 * on message 1. A request that opens an epoch renders them from live state;
 * inside an epoch message 1 is the record (extensions/request/ledger), so changes ride
 * notices on the request's tail, decided when the request goes out from what
 * the epoch has told (the same rule as the deferred-tools listing). What was
 * told is a whole-text block fact per server (`mcp-instructed:<name>`,
 * `mcp-failed:<name>`): the hash of the instructions or error last told, or of
 * the empty text once a drop or a recovery was announced.
 */

import { mcpFailuresReminder, shownFailure, shownInstructions } from "./client.ts";
import type { McpResultText } from "./text.ts";
import type { BlockFact, ToldFact } from "../../lib/request/ledger/records.ts";
import { toldBlockFact } from "../../lib/request/reminders.ts";
import { countNoun } from "../../lib/ui/tui-render.ts";

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
 * Facts store and compare the exact bounded values the reminder puts on the
 * wire. A changing tail beyond either cap is not a model-visible capability
 * change and must not become a false notice.
 */
const instructedFact = (name: string, instructions: string, text: McpResultText): BlockFact => toldBlockFact(INSTRUCTED + name, shownInstructions(instructions, text));
const failedFact = (name: string, error: string): BlockFact => toldBlockFact(FAILED + name, shownFailure(error));

/** What message 1's two MCP blocks rendered from `snapshot` tell. */
export function mcpFacts(snapshot: McpSnapshot, text: McpResultText): ToldFact[] {
	return [
		...snapshot.connected.flatMap((c) => (c.instructions ? [instructedFact(c.name, c.instructions, text)] : [])),
		...snapshot.failed.map((f) => failedFact(f.name, f.error)),
	];
}

/**
 * What changed since the epoch told `told` (whole-text block hashes by key),
 * and the facts announcing it tells. While the startup connections are still
 * `settling`, a server not connected yet is not a drop, and neither is one in
 * `connecting` (a reconnect in flight).
 */
export function mcpDelta(
	told: ReadonlyMap<string, string>,
	snapshot: McpSnapshot,
	text: McpResultText,
	settling = false,
	connecting: ReadonlySet<string> = new Set(),
): McpDelta {
	const connectedNames = new Set(snapshot.connected.map((c) => c.name));
	// One failure per server (the latest): two kept errors would alternate as the told fact.
	const failed = [...new Map(snapshot.failed.map((f) => [f.name, f])).values()];
	const failedNames = new Set(failed.map((f) => f.name));
	const toldNames = (prefix: string) => [...told].filter(([key, hash]) => key.startsWith(prefix) && hash !== NONE).map(([key]) => key.slice(prefix.length));
	const newInstructions = snapshot.connected
		.filter((c) => c.instructions && told.get(INSTRUCTED + c.name) !== instructedFact(c.name, c.instructions, text).hash)
		.map((c) => ({ name: c.name, instructions: shownInstructions(c.instructions as string, text) }));
	const newFailures = failed
		.filter((f) => told.get(FAILED + f.name) !== failedFact(f.name, f.error).hash)
		.map((f) => ({ name: f.name, error: shownFailure(f.error) }));
	const recovered = toldNames(FAILED).filter((name) => connectedNames.has(name));
	const dropped = settling ? [] : toldNames(INSTRUCTED).filter((name) => !connectedNames.has(name) && !failedNames.has(name) && !connecting.has(name));
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
export function mcpChangeNotices(delta: McpDelta, text: McpResultText): string[] {
	const notices: string[] = [];
	if (delta.recovered.length > 0) notices.push(text.notices.recovered(delta.recovered));
	if (delta.newInstructions.length > 0) notices.push(text.notices.connected(delta.newInstructions.map((s) => ({ name: s.name, text: s.instructions }))));
	if (delta.newFailures.length > 0) notices.push(mcpFailuresReminder(delta.newFailures, text));
	if (delta.dropped.length > 0) notices.push(text.notices.dropped(delta.dropped));
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
