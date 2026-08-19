/**
 * /mcp panel data model (pure — no pi, no fs).
 *
 * The mcp extension builds an `McpEntry[]` from its live connection state each
 * repaint; this module owns the shared vocabulary the state machine and the
 * renderer agree on: the status/auth glyphs and the per-entry action list. The
 * list view groups entries under a heading (computed by the wiring, e.g. "User
 * MCPs (~/.claude.json)"); the detail view shows one entry's fields and actions.
 */

export type McpEntryStatus = "connected" | "failed" | "authNeeded" | "connecting" | "disabled";

export interface McpEntry {
	name: string;
	/** Heading this entry sits under in the grouped list. */
	group: string;
	status: McpEntryStatus;
	toolCount?: number;
	/** Failure reason, shown as the detail view's "Issue" line. */
	issue?: string;
	/** http server url, shown as the detail view's "URL" line. */
	url?: string;
	/** Where the server was configured, shown as "Config location". */
	configLocation: string;
	/** Present when auth state is known; drives the "Auth" line. */
	authState?: "authenticated" | "notAuthenticated";
	/** True only for an OAuth-capable http server (Authenticate can actually help). */
	canAuthenticate: boolean;
}

export type McpAction = "reconnect" | "authenticate" | "disable" | "enable";

export interface McpActionItem {
	key: McpAction;
	label: string;
}

/** The numbered action list for an entry, matching Claude Code's detail view. */
export function actionsFor(entry: McpEntry): McpActionItem[] {
	if (entry.status === "disabled") return [{ key: "enable", label: "Enable" }];
	const primary: McpActionItem =
		entry.status === "authNeeded" && entry.canAuthenticate
			? { key: "authenticate", label: "Authenticate" }
			: { key: "reconnect", label: "Reconnect" };
	return [primary, { key: "disable", label: "Disable" }];
}

/** Glyph + label for a status; the wiring paints the glyph in the status colour. */
export function statusText(entry: McpEntry): { glyph: string; label: string; color: string } {
	switch (entry.status) {
		case "connected":
			return { glyph: "✔", label: "connected", color: "success" };
		case "authNeeded":
			return { glyph: "⚠", label: "needs authentication", color: "warning" };
		case "connecting":
			return { glyph: "…", label: "connecting", color: "dim" };
		case "disabled":
			return { glyph: "○", label: "disabled", color: "dim" };
		case "failed":
			return { glyph: "✘", label: "failed", color: "error" };
	}
}
