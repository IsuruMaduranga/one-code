/**
 * Whether a session runs on a Claude-family model (pure: no pi imports, so the
 * source provider may use it; lib/profile/shared-module.ts). Claude Code's own subagent
 * conventions (`CLAUDE_CODE_SUBAGENT_MODEL`, `.claude/agents` model fields) are
 * honored across providers only on such sessions; elsewhere subagents stay on
 * the session's provider. Only provider/id are consulted, so a minimal model
 * shape suffices.
 */
export function isClaudeFamilyModel(model: { provider: string; id: string }): boolean {
	return model.provider === "anthropic" || /claude/i.test(model.id);
}

const CLAUDE_WITHHELD: readonly string[] = ["yield"];

/**
 * The tools a session's model is not offered; every other tool is offered to
 * every model. A Claude model is not offered yield (tools/background): it waits the way
 * Claude Code's default does, by ending the turn until the notification
 * arrives (Claude Code's own Yield is behind a flag). Other models, which
 * bring blocking-wait habits from their own harnesses, wait in one yield call
 * instead (`decisions/subagents-workflows.md`). With no model yet, nothing is
 * withheld until the first model boundary decides.
 */
export function toolsWithheldFrom(model: { provider: string; id: string } | undefined): readonly string[] {
	return model !== undefined && isClaudeFamilyModel(model) ? CLAUDE_WITHHELD : [];
}

/**
 * The active-tool list with `owned` (the caller's model-gated tools) set to
 * what the model is offered: a withheld one removed, an offered one appended
 * when `live` has it and the list lacks it. The same array when nothing
 * changes, so the caller sets the tools only on a change; the order of the
 * other names is kept.
 */
export function withOfferedTools(active: readonly string[], owned: readonly string[], withheld: readonly string[], live: (tool: string) => boolean): readonly string[] {
	const drop = owned.filter((tool) => withheld.includes(tool) && active.includes(tool));
	const add = owned.filter((tool) => !withheld.includes(tool) && live(tool) && !active.includes(tool));
	if (drop.length === 0 && add.length === 0) return active;
	return [...active.filter((tool) => !drop.includes(tool)), ...add];
}
