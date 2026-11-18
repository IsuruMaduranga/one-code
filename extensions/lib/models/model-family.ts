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

/**
 * Whether a session's model is offered the yield tool (tools/background):
 * every model outside the Claude family. Claude models wait the way Claude
 * Code's default does, by ending the turn until the notification arrives
 * (its own Yield is behind a flag); other models, which bring blocking-wait
 * habits from their own harnesses, wait in one yield call instead
 * (`decisions/subagents-workflows.md`). With no model yet, the tool stays
 * offered until the first model boundary decides.
 */
export function yieldOffered(model: { provider: string; id: string } | undefined): boolean {
	return model === undefined || !isClaudeFamilyModel(model);
}
