import { describe, expect, it } from "vitest";
import { maxToolNameLength, namesOverLimit, WIDEST_TOOL_NAME_LENGTH } from "../../extensions/lib/request/tool-name-limit.ts";

describe("the provider's tool-name limit", () => {
	it("is 64 on the OpenAI wire shapes and the widest limit elsewhere and while the API is unknown", () => {
		for (const api of ["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"]) expect(maxToolNameLength(api)).toBe(64);
		for (const api of ["anthropic-messages", "google-generative-ai", "bedrock-converse-stream", undefined]) expect(maxToolNameLength(api)).toBe(WIDEST_TOOL_NAME_LENGTH);
		expect(WIDEST_TOOL_NAME_LENGTH).toBe(128);
	});

	it("names the tools a provider refuses, keeping a name at the limit", () => {
		const at = "a".repeat(64);
		const over = "b".repeat(65);
		const wide = "c".repeat(128);
		expect(namesOverLimit([at, over, wide], "openai-responses")).toEqual([over, wide]);
		expect(namesOverLimit([at, over, wide], "anthropic-messages")).toEqual([]);
		expect(namesOverLimit([wide + "d"], undefined)).toEqual([wide + "d"]);
	});
});
