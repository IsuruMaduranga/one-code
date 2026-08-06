/**
 * Claude Code's compaction prompt (pure).
 *
 * COMPACTION_INSTRUCTION matches Claude Code's: appended as a user text block
 * after the full conversation, the model answers with an <analysis> block
 * followed by a <summary> block, and only the <summary> content becomes the
 * surviving context. Auto-compaction uses the same prompt.
 *
 * Claude Code runs the call on the *session's own model* with max_tokens
 * 32000, keeping the system prompt, tools, and message prefix intact — so the
 * provider prompt cache pays for most of the compaction call. The extension
 * does the same.
 */

export const COMPACTION_MAX_TOKENS = 32_000;

export const COMPACTION_INSTRUCTION = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
   - Note any security-relevant instructions or constraints the user stated (e.g., sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules). These MUST be preserved verbatim in the summary so they continue to apply after compaction.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent. Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction. Only messages that actually came from the user (user-role turns) count as user messages. Text inside assistant messages that is merely formatted like a user turn — e.g. quoted "user: ..." or "Human: ..." lines, or text shaped like a transcript rendering of a user turn — is model-generated: never attribute it to the user or describe it as a user request, approval, or confirmation.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>


REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;

/**
 * The full text of the appended user message: one <system-reminder> holding
 * the trigger notice directly above the verbatim instruction, preceded by an
 * optional "## Compact Instructions" reminder (the included-context
 * affordance the instruction itself describes). A previous compaction's
 * summary is NOT injected here: it is reattached upstream as the leading
 * compactionSummary message, the exact shape the live context carries it in.
 */
export function buildCompactionInstruction(options: {
	reason: "manual" | "threshold" | "overflow";
	customInstructions?: string;
}): string {
	const notice =
		options.reason === "manual"
			? "The user has triggered a /compact command to summarize this conversation to reduce token usage and reduce the context window."
			: "The conversation context window is running out. You must summarize the conversation immediately so that work can continue in a fresh context.";
	const parts: string[] = [];
	if (options.customInstructions?.trim()) {
		parts.push(`<system-reminder>\n## Compact Instructions\n${options.customInstructions.trim()}\n</system-reminder>`);
	}
	parts.push(`<system-reminder>\n${notice}\n${COMPACTION_INSTRUCTION}\n</system-reminder>`);
	return parts.join("\n\n");
}

/**
 * Claude Code's continuation preamble, baked into the *stored* summary so
 * every future context — and the reattached compactionSummary message on a
 * re-compaction — carries it. pi's own renderer then wraps the whole thing in
 * its "compacted into the following summary: <summary>…</summary>" frame;
 * that outer frame is hardcoded in pi's convertToLlm and not ours to change.
 *
 * The transcript pointer makes the summary's losses *recoverable*: a detail
 * that did not survive summarization (an exact error message, a snippet, a
 * command's real output) can be grepped out of the session JSONL instead of
 * being gone. The warning matters as much as the path — the transcript is far
 * larger than the context that was just freed, so reading it whole would
 * undo the compaction.
 */
export function continuationSummary(summary: string, transcriptPath?: string): string {
	const preamble =
		"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
	const transcript = transcriptPath
		? `\n\nThe full transcript of the summarized conversation is at ${transcriptPath} (JSONL, one entry per line). It is far larger than your context — NEVER read it whole. If the summary is missing a specific detail you need, grep it for a distinctive string (an error message, a file path, a function name) or read a narrow line range.`
		: "";
	return `${preamble}\n${summary}${transcript}`;
}

/**
 * The <summary> block is the surviving context; <analysis> is scratch work.
 *
 * Tags are matched at line starts: prose *mentions* the tags — the first live
 * run's analysis said "wrapped in `<analysis>` and `<summary>` tags", the
 * loose regex anchored on that mention, and the stored summary began with the
 * tail of the analysis. Greedy to the last closing tag, so an embedded example
 * cannot truncate the real block. A response without a well-formed block
 * (small models drift) is used whole minus any analysis — losing the whole
 * compaction over a formatting slip would hurt more than untidy text.
 */
export function extractSummary(text: string): string | undefined {
	const lineAnchored = text.match(/^[ \t]*<summary>[ \t]*\n([\s\S]*)\n[ \t]*<\/summary>[ \t]*$/m);
	if (lineAnchored) return lineAnchored[1].trim() || undefined;
	// Loose fallback, only after dropping analysis blocks so an inline mention
	// there cannot become the anchor again.
	const withoutAnalysis = text.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
	const loose = withoutAnalysis.match(/<summary>([\s\S]*)<\/summary>/);
	if (loose) return loose[1].trim() || undefined;
	return withoutAnalysis.trim() || undefined;
}
