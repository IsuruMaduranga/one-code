/**
 * The ledger redacts a product's secret values from a request's new tail
 * (lib/request/ledger/redact.ts): only from the append point on, and never in
 * the model's own messages.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetProcessStateForTest } from "../../extensions/lib/profile/process-state.ts";
import { redactSecretValuesIn, setSecretValues } from "../../extensions/lib/profile/secrets.ts";
import { redactTail } from "../../extensions/lib/request/ledger/redact.ts";

const SECRET = "hunter2-token";
const HIDDEN = "[secret:t]";

beforeEach(() => {
	resetProcessStateForTest();
	setSecretValues("a", [{ value: SECRET, name: "t" }]);
});

describe("redactTail", () => {
	it("rewrites user and tool-result elements of an Anthropic request, from the append point on", () => {
		const payload = {
			system: [{ type: "text", text: `prompt ${SECRET}` }],
			messages: [
				{ role: "user", content: `recorded ${SECRET}` },
				{ role: "assistant", content: [{ type: "thinking", thinking: SECRET, signature: "s" }, { type: "tool_use", id: "1", name: "bash", input: { command: `echo ${SECRET}` } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: SECRET }] }, { type: "text", text: `<system-reminder>\nchanged: ${SECRET}\n</system-reminder>` }] },
			],
		};
		const out = redactTail(payload, "anthropic-messages", 1, redactSecretValuesIn) as typeof payload;
		// The recorded element and the system prompt are not the tail.
		expect(out.messages[0]).toBe(payload.messages[0]);
		expect(out.system).toBe(payload.system);
		// The model's own message goes back as written: thinking, signature and call input.
		expect(out.messages[1]).toBe(payload.messages[1]);
		expect(out.messages[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: HIDDEN }] }, { type: "text", text: `<system-reminder>\nchanged: ${HIDDEN}\n</system-reminder>` }],
		});
	});

	it("reads the other dialects' lists and roles", () => {
		const completions = { messages: [{ role: "developer", content: SECRET }, { role: "assistant", content: SECRET }, { role: "tool", tool_call_id: "1", content: SECRET }] };
		expect(redactTail(completions, "openai-completions", 0, redactSecretValuesIn).messages).toEqual([{ role: "developer", content: HIDDEN }, { role: "assistant", content: SECRET }, { role: "tool", tool_call_id: "1", content: HIDDEN }]);
		const responses = {
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: SECRET }] },
				{ type: "reasoning", encrypted_content: SECRET },
				{ type: "function_call", call_id: "1", name: "bash", arguments: JSON.stringify({ command: SECRET }) },
				{ type: "function_call_output", call_id: "1", output: SECRET },
			],
		};
		expect(redactTail(responses, "openai-responses", 0, redactSecretValuesIn).input).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: HIDDEN }] },
			responses.input[1],
			responses.input[2],
			{ type: "function_call_output", call_id: "1", output: HIDDEN },
		]);
		const google = { contents: [{ role: "model", parts: [{ text: SECRET }] }, { role: "user", parts: [{ functionResponse: { name: "bash", response: { output: SECRET } } }] }] };
		expect(redactTail(google, "google-generative-ai", 0, redactSecretValuesIn).contents).toEqual([google.contents[0], { role: "user", parts: [{ functionResponse: { name: "bash", response: { output: HIDDEN } } }] }]);
	});

	it("returns the same payload when nothing in the tail holds a value", () => {
		const payload = { messages: [{ role: "user", content: SECRET }, { role: "user", content: "clean" }] };
		expect(redactTail(payload, "anthropic-messages", 1, redactSecretValuesIn)).toBe(payload);
	});
});
