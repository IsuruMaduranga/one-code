/**
 * The tool-call-corruption extension's words: why a call's arguments look
 * damaged (request/tool-call-corruption/tool-call-corruption.ts decides),
 * and the block the model gets for a suspect call and a corrupt one, when
 * OpenRouter delivers a call whose arguments look cut off or broken.
 */

/** What is wrong with a call's raw arguments. */
export type ArgumentDamage =
	| { kind: "notOneJson" }
	/** The command ends with an option and nothing after it (`option` as it appears). */
	| { kind: "cutAfterOption"; option: string }
	| { kind: "unbalancedQuote" };

export interface ToolCallCorruptionText {
	damage(damage: ArgumentDamage): string;
	/** A suspect call, returned once so the model can resend it; `reason` is the damage worded. */
	suspectBlock(p: { reason: string }): string;
	/** A corrupt call, which ends the turn; `repeat` when an earlier command in the run came through cut the same way. */
	corruptBlock(p: { reason: string; repeat: boolean }): string;
}

function damage(d: ArgumentDamage): string {
	switch (d.kind) {
		case "notOneJson":
			return "The raw tool-call arguments are not exactly one JSON value.";
		case "cutAfterOption":
			return `The shell command ends with "${d.option}" and nothing after it, the shape of arguments cut off before a quoted string.`;
		case "unbalancedQuote":
			return "The shell command ends with an unbalanced double quote, indicating truncated tool-call arguments.";
	}
}

export const toolCallCorruptionText: ToolCallCorruptionText = {
	damage,
	suspectBlock: ({ reason }) => `${reason} It was not run. Send the complete command again; if it really ends there, drop the trailing blank or the empty option.`,
	corruptBlock: ({ reason, repeat }) =>
		`OpenRouter tool-call corruption: ${reason}${repeat ? " An earlier command in this run came through cut the same way." : ""} Do not retry this call; switch models or exclude the upstream provider.`,
};
