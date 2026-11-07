/**
 * One Code's tool-call-corruption text (the profile's
 * `text.toolCallCorruption`): what the model hears when OpenRouter delivers
 * a call whose arguments look cut off or broken.
 */

import type { ArgumentDamage, ToolCallCorruptionText } from "../../../extensions/tool-call-corruption/text.ts";

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

export const toolCallCorruption: ToolCallCorruptionText = {
	damage,
	suspectBlock: ({ reason }) => `${reason} It was not run. Send the complete command again; if it really ends there, drop the trailing blank or the empty option.`,
	corruptBlock: ({ reason, repeat }) =>
		`OpenRouter tool-call corruption: ${reason}${repeat ? " An earlier command in this run came through cut the same way." : ""} Do not retry this call; switch models or exclude the upstream provider.`,
};
