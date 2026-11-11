/**
 * The tool-call-corruption wording (request/tool-call-corruption/text.ts),
 * which the golden snapshot cannot reach: the damage and both blocks, for a
 * call whose arguments OpenRouter's streaming cut or broke.
 */
import { describe, expect, it } from "vitest";
import { toolCallCorruptionText as toolCallCorruption } from "../../extensions/request/tool-call-corruption/text.ts";

describe("the tool-call-corruption text", () => {
	it("words the damage and both blocks", () => {
		const reason = toolCallCorruption.damage({ kind: "cutAfterOption", option: "-rn" });
		expect(reason).toBe('The shell command ends with "-rn" and nothing after it, the shape of arguments cut off before a quoted string.');
		expect(toolCallCorruption.suspectBlock({ reason })).toContain("It was not run. Send the complete command again");
		expect(toolCallCorruption.corruptBlock({ reason, repeat: true })).toContain("An earlier command in this run came through cut the same way. Do not retry this call");
		expect(toolCallCorruption.corruptBlock({ reason, repeat: false })).not.toContain("An earlier command");
	});
});
