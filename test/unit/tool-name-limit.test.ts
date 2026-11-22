import { describe, expect, it } from "vitest";
import { limitWithdrawals, maxToolNameLength, namesOverLimit, WIDEST_TOOL_NAME_LENGTH } from "../../extensions/lib/request/tool-name-limit.ts";

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

describe("limitWithdrawals", () => {
	const long = "m".repeat(70);
	const other = "n".repeat(70);
	const base = { blocked: () => false, deferred: () => false, registered: new Set(["read", long, other]) };
	const refusing = (name: string) => name.length > 64;
	const taking = () => false;

	it("records an active up-front tool the model refuses, and keeps a recorded one the model still refuses", () => {
		expect(limitWithdrawals({ ...base, active: ["read", long], recorded: [other], refused: refusing })).toEqual({ restore: [], record: [other, long] });
	});

	it("restores a recorded tool the model takes and consumes the record whether or not it comes back", () => {
		const blocked = (name: string) => name === other;
		expect(limitWithdrawals({ ...base, blocked, active: ["read"], recorded: [long, other], refused: taking })).toEqual({ restore: [long], record: [] });
	});

	it("leaves a deferred, unregistered or already active tool to the reasons that decide it", () => {
		const deferred = (name: string) => name === other;
		expect(limitWithdrawals({ ...base, deferred, active: ["read", other], recorded: [long, other], refused: taking, registered: new Set(["read", other]) })).toEqual({ restore: [], record: [] });
		expect(limitWithdrawals({ ...base, deferred, active: ["read", other], recorded: [], refused: refusing })).toEqual({ restore: [], record: [] });
	});
});
