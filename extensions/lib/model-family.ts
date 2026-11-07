/**
 * Whether a session runs on a Claude-family model (pure: no pi imports, so the
 * source provider may use it; lib/shared-module.ts). Claude Code's own subagent
 * conventions (`CLAUDE_CODE_SUBAGENT_MODEL`, `.claude/agents` model fields) are
 * honored across providers only on such sessions; elsewhere subagents stay on
 * the session's provider. Only provider/id are consulted, so a minimal model
 * shape suffices.
 */
export function isClaudeFamilyModel(model: { provider: string; id: string }): boolean {
	return model.provider === "anthropic" || /claude/i.test(model.id);
}
