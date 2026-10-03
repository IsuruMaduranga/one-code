/**
 * The plan-mode tools' model-facing texts (pure): Claude Code's EnterPlanMode
 * and ExitPlanMode descriptions and results, with One Code's snake_case tool
 * names. The plan stays file-based (decisions/modes.md, "Plan mode is
 * file-based"); only the wording follows Claude Code.
 */

import type { PromptTier } from "../lib/model-tier.ts";

/**
 * Claude Code's EnterPlanMode description, which prefers plan mode for any
 * non-trivial implementation task. Frontier and workhorse models get it.
 */
export const ENTER_PLAN_MODE_DESCRIPTION = [
	"Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.",
	"",
	"## When to Use This Tool",
	"",
	"**Prefer using enter_plan_mode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:",
	"",
	"1. **New Feature Implementation**: Adding meaningful new functionality",
	"   - Example: \"Add a logout button\" - where should it go? What should happen on click?",
	"   - Example: \"Add form validation\" - what rules? What error messages?",
	"",
	"2. **Multiple Valid Approaches**: The task can be solved in several different ways",
	"   - Example: \"Add caching to the API\" - could use Redis, in-memory, file-based, etc.",
	"   - Example: \"Improve performance\" - many optimization strategies possible",
	"",
	"3. **Code Modifications**: Changes that affect existing behavior or structure",
	"   - Example: \"Update the login flow\" - what exactly should change?",
	"   - Example: \"Refactor this component\" - what's the target architecture?",
	"",
	"4. **Architectural Decisions**: The task requires choosing between patterns or technologies",
	"   - Example: \"Add real-time updates\" - WebSockets vs SSE vs polling",
	"   - Example: \"Implement state management\" - Redux vs Context vs custom solution",
	"",
	"5. **Multi-File Changes**: The task will likely touch more than 2-3 files",
	"   - Example: \"Refactor the authentication system\"",
	"   - Example: \"Add a new API endpoint with tests\"",
	"",
	"6. **Unclear Requirements**: You need to explore before understanding the full scope",
	"   - Example: \"Make the app faster\" - need to profile and identify bottlenecks",
	"   - Example: \"Fix the bug in checkout\" - need to investigate root cause",
	"",
	"7. **User Preferences Matter**: The implementation could reasonably go multiple ways",
	"   - If you would use ask_user_question to clarify the approach, use enter_plan_mode instead",
	"   - Plan mode lets you explore first, then present options with context",
	"",
	"## When NOT to Use This Tool",
	"",
	"Only skip enter_plan_mode for simple tasks:",
	"- Single-line or few-line fixes (typos, obvious bugs, small tweaks)",
	"- Adding a single function with clear requirements",
	"- Tasks where the user has given very specific, detailed instructions",
	"- Pure research/exploration tasks (use the Agent tool instead)",
	"",
	"## What Happens in Plan Mode",
	"",
	"In plan mode, you'll:",
	"1. Thoroughly explore the codebase using `find`, `grep`, and read",
	"2. Understand existing patterns and architecture",
	"3. Design an implementation approach",
	"4. Present your plan to the user for approval",
	"5. Use ask_user_question if you need to clarify approaches",
	"6. Exit plan mode with exit_plan_mode when ready to implement",
	"",
	"## Examples",
	"",
	"### GOOD - Use enter_plan_mode:",
	"User: \"Add user authentication to the app\"",
	"- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)",
	"",
	"User: \"Optimize the database queries\"",
	"- Multiple approaches possible, need to profile first, significant impact",
	"",
	"User: \"Implement dark mode\"",
	"- Architectural decision on theme system, affects many components",
	"",
	"User: \"Add a delete button to the user profile\"",
	"- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates",
	"",
	"User: \"Update the error handling in the API\"",
	"- Affects multiple files, user should approve the approach",
	"",
	"### BAD - Don't use enter_plan_mode:",
	"User: \"Fix the typo in the README\"",
	"- Straightforward, no planning needed",
	"",
	"User: \"Add a console.log to debug this function\"",
	"- Simple, obvious implementation",
	"",
	"User: \"What files handle routing?\"",
	"- Research task, not implementation planning",
	"",
	"## Important Notes",
	"",
	"- This tool REQUIRES user approval - they must consent to entering plan mode",
	"- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work",
	"- Users appreciate being consulted before significant changes are made to their codebase",
	"",
].join("\n");

/**
 * One Code's own description for the cheap and tiny tiers. Weak models read a
 * "prefer plan mode" description as standing policy and planned trivial tasks
 * (decisions/tools.md, "Weak-model steering"), so this one says most tasks do
 * not need it.
 */
export const ENTER_PLAN_MODE_DESCRIPTION_WEAK =
	"Enter plan mode: read-only investigation to design an approach before changing anything. Most tasks do not need it.\n" +
	"For a small or clearly-scoped change, act directly instead. Enter plan mode only for multi-file work whose design is genuinely unclear, or when the user asks for a plan. In plan mode only read-only tools are available, plus one writable file: the plan file whose path you are told, where you build the plan incrementally.";

/** The enter_plan_mode description a model of `tier` gets. */
export function enterPlanModeDescription(tier: PromptTier): string {
	return tier === "cheap" || tier === "tiny" ? ENTER_PLAN_MODE_DESCRIPTION_WEAK : ENTER_PLAN_MODE_DESCRIPTION;
}

/** Claude Code's ExitPlanMode description. */
export const EXIT_PLAN_MODE_DESCRIPTION = [
	"Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.",
	"",
	"## How This Tool Works",
	"- You should have already written your plan to the plan file specified in the plan mode system message",
	"- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote",
	"- This tool simply signals that you're done planning and ready for the user to review and approve",
	"- The user will see the contents of your plan file when they review it",
	"",
	"## When to Use This Tool",
	"IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.",
	"",
	"## Before Using This Tool",
	"Ensure your plan is complete and unambiguous:",
	"- If you have unresolved questions about requirements or approach, use ask_user_question first (in earlier phases)",
	"- Once your plan is finalized, use THIS tool to request approval",
	"",
	"**Important:** Do NOT use ask_user_question to ask \"Is this plan okay?\" or \"Should I proceed?\" - that's exactly what THIS tool does. exit_plan_mode inherently requests user approval of your plan.",
	"",
	"## Examples",
	"",
	"1. Initial task: \"Search for and understand the implementation of vim mode in the codebase\" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.",
	"2. Initial task: \"Help me implement yank mode for vim\" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.",
	"3. Initial task: \"Add a new feature to handle user authentication\" - If unsure about auth method (OAuth, JWT, etc.), use ask_user_question first, then use exit plan mode tool after clarifying the approach.",
	"",
].join("\n");

/** Claude Code's EnterPlanMode result. */
const ENTERED_PLAN_MODE = [
	"Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.",
	"",
	"In plan mode, you should:",
	"1. Thoroughly explore the codebase to understand existing patterns",
	"2. Identify similar features and architectural approaches",
	"3. Consider multiple approaches and their trade-offs",
	"4. Use ask_user_question if you need to clarify the approach",
	"5. Design a concrete implementation strategy",
	"6. When ready, use exit_plan_mode to present your plan for approval",
	"",
	"Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.",
].join("\n");

/**
 * enter_plan_mode's result: Claude Code's text, then the plan file's path so
 * the model can start writing the plan in the same turn.
 */
export function enteredPlanModeText(planFilePath: string): string {
	return `${ENTERED_PLAN_MODE}\n\nYour plan file is ${planFilePath}, the one file you may write: build your plan there.`;
}

/** exit_plan_mode's result when the user approves: Claude Code's text, with the plan file's contents. */
export function approvedPlanText(planFilePath: string, plan: string): string {
	return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\nYour plan has been saved to: ${planFilePath}\nYou can refer back to it if needed during implementation.\n\n## Approved Plan:\n${plan}`;
}

/** Claude Code's reminder after the approval: plan mode is over and the plan file stays readable. */
export function exitedPlanModeText(planFilePath: string): string {
	return `## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions. The plan file is located at ${planFilePath} if you need to reference it.`;
}
