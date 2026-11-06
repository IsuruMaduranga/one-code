/**
 * The agent view's shared half: while the user views an agent (the subagents
 * panel's Enter-to-view), the editor targets that agent, as Claude Code
 * 2.1.283's does (findings §40). A label sits on the editor's top border, the
 * empty editor shows `Message @<label>…`, and what the user submits goes to
 * the agent in Claude Code's mid-turn wrapper. The subagents extension owns
 * the view and announces it over `AGENT_VIEW_CHANNEL`; the branding extension
 * owns the editor and paints it (extensions share no module state).
 */

import { fitPainted, visibleWidth } from "./text-width.ts";
import { cutPlainText } from "./tui-render.ts";
import { notificationWords } from "./notification-words.ts";

/** `{ target }` while an agent is viewed, `{}` when the view returns to main. */
export const AGENT_VIEW_CHANNEL = "one-code:agent-view";

export interface AgentViewTarget {
	/** The top-border label: `@<name>` for a fork, the run's description otherwise. */
	badge: string;
	/** The empty editor's placeholder: `Message @<name or agent type>…`. */
	placeholder: string;
}

export interface AgentViewAnnouncement {
	target?: AgentViewTarget;
}

/** The slice of a live run the target is built from. */
export interface ViewedRun {
	name: string;
	agentType: string;
	label: string;
}

/**
 * The editor target for a viewed run, Claude Code's shapes: a fork shows
 * `@what-word-is` on the border and `Message @what-word-is…`; a regular agent
 * shows its description on the border and `Message @general-purpose…`.
 */
export function agentViewTarget(run: ViewedRun, fork: boolean): AgentViewTarget {
	const handle = fork ? run.name : run.agentType;
	return { badge: fork ? `@${run.name}` : run.label, placeholder: `Message @${handle}…` };
}

/** A message the user types at an agent, idle or running, in the profile's wrapper. */
export function userMessageForAgent(text: string): string {
	return notificationWords().userMessageMidTurn({ text });
}

/** The user's own text inside `userMessageForAgent`'s wrapper, or undefined for any other prompt. */
export function unwrapUserMessage(prompt: string): string | undefined {
	// The wrapper around the text, from the profile's own words.
	const probe = userMessageForAgent("\u0000");
	const at = probe.indexOf("\u0000");
	const opener = probe.slice(0, at);
	const closer = probe.slice(at + 1);
	if (!opener || !prompt.startsWith(opener) || !prompt.endsWith(closer)) return undefined;
	const end = prompt.length - closer.length;
	return end < opener.length ? undefined : prompt.slice(opener.length, end);
}

/**
 * Draw `badge` (already painted, padding included, `badgeWidth` columns) at the
 * right end of the editor's top border, followed by one border glyph:
 * `─── @name ─`. The rest of the border, and anything pi embeds at its left
 * (the working status), keeps its paint. No-op when the border is too narrow.
 */
export function applyBorderBadge(lines: string[], badge: string, badgeWidth: number, borderGlyph: string): string[] {
	const top = lines[0];
	if (top === undefined) return lines;
	const width = visibleWidth(top);
	const tail = badgeWidth + 1;
	if (width < tail + 4) return lines;
	const head = fitPainted(top, width - tail).text;
	const out = lines.slice();
	out[0] = `${head}\x1b[0m${badge}${borderGlyph}`;
	return out;
}

/** The label cut to fit a border of `width` columns, keeping room for the border itself. */
export function fitBadge(label: string, width: number): string {
	const room = Math.floor(width / 2) - 3;
	return room <= 1 ? "" : cutPlainText(label, room);
}
