/**
 * Prompt sections shared across tiers.
 *
 * A `PromptBundle` is the tier's static text: `lead` sections come before the
 * dynamic tools/memory/environment/scratchpad blocks, `tail` sections after.
 * `template.ts` owns the dynamic-block placement and is tier-agnostic.
 *
 * Every register is Claude Code's text for the models in its tier, with One
 * Code's identity line in place of Claude Code's and tool names in One Code's
 * snake_case (`working-docs/decisions/system-prompt.md`, "Four registers").
 */

export interface PromptBundle {
	lead: string[];
	tail: string[];
	/** Whether the memory section uses the long spec (`lib/memory.ts`). */
	verboseMemory: boolean;
	/**
	 * `lead` without the bullets that steer to `task_create`, for a session model
	 * that runs without the task tools (Claude Code writes its TaskCreate line
	 * only when the tool is enabled). Absent when `lead` has no such bullet.
	 */
	leadWithoutTaskTools?: string[];
}

export const IDENTITY = `You are One Code, an interactive agent that helps users with software engineering tasks, running on the pi agent harness.`;

export const SECURITY = `IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.`;

/** The long register's second line, on the security paragraph's next line. */
export const URL_BAN = `IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.`;

/**
 * Both registers' session guidance shares these two bullets; the long register
 * puts its fork bullet between them. pi runs a `!`-prefixed line as a shell
 * command and adds its output to the conversation, as Claude Code does.
 */
export const BANG_COMMAND_BULLET = ` - If you need the user to run a shell command themselves (e.g., an interactive login like \`gcloud auth login\`), suggest they type \`! <command>\` in the prompt — the \`!\` prefix runs the command in this session so its output lands directly in the conversation.`;
export const TYPED_SKILL_BULLET = ` - When the user types \`/<skill-name>\`, invoke it via the skill tool. Only use skills listed in the user-invocable skills section — don't guess.`;

/** Claude Code's text as it stands, without a period after its last word. */
export const CONTEXT_MANAGEMENT = `# Context management
When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.

When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey`;
