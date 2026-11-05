/**
 * One Code's `/btw` text (the profile's `text.btw`): Claude Code's
 * side-question reminder, verbatim from its capture (captures/btw.json,
 * CC 2.1.278).
 */

import type { BtwText } from "../../extensions/btw/text.ts";

/**
 * CC's verbatim side-question reminder (captures/btw.json message 20). It frames
 * the answering instance as a separate, lightweight, tool-less agent so the
 * model answers in one shot from context instead of trying to act. Like Claude
 * Code, the replayed request still declares the session's real tools (they are
 * part of the cached prefix); a tool call in the answer is never executed, only
 * its text is shown, and the exchange never reaches the main conversation.
 */
export const SIDE_QUESTION_REMINDER = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- Do NOT write tool calls or tool output as text (for example invoke or function_calls XML blocks) - nothing you write here is executed; if answering would need reading files, running commands, or searching, say that can't be checked from a side question and suggest asking in the main conversation
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>`;

export const btw: BtwText = {
	// CC's reminder, a blank line, then the user's question verbatim
	// (captures/btw.json message 20 is exactly this string).
	question: (question) => `${SIDE_QUESTION_REMINDER}\n\n${question}`,
	stubReason: "Unavailable during this side question; answer in text.",
};
