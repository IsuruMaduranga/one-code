import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { getJsonSchemaToolParameters, makeStrictJsonSchema, resolveJsonSchemaStrictSampling } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertTools as convertGoogleTools } from "@earendil-works/pi-ai/api/google-shared";
import { jsonSchemaToTypeBox } from "../../extensions/mcp/schema.ts";

function convertedMcpParameters() {
	return jsonSchemaToTypeBox({
		type: "object",
		description: "A server-defined input object.",
		properties: {
			text: { type: ["string", "null"], description: "Optional text." },
			object: {
				type: ["object", "null"],
				description: "Optional structured value.",
				properties: { label: { type: "string", description: "A nested label." } },
				required: ["label"],
			},
			array: {
				type: ["array", "null"],
				description: "Optional list.",
				items: { type: "string", description: "A list entry." },
			},
			choice: { type: ["integer", "string"], description: "An identifier or name." },
		},
		required: ["text", "object", "array", "choice"],
	});
}

function tool(parameters = convertedMcpParameters()) {
	return { name: "mcp__server__tool", description: "An MCP tool.", parameters };
}

function offlineModel<T extends Api>(api: T, provider: string): Model<T> {
	return {
		id: "schema-test", name: "Schema test", api, provider, baseUrl: "https://example.invalid",
		reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("MCP TypeBox schemas through provider adapters", () => {
	it("keeps nullable and multi-type MCP values as described anyOf unions", () => {
		const parameters = convertedMcpParameters() as Record<string, unknown>;
		const properties = parameters.properties as Record<string, Record<string, unknown>>;

		expect(parameters).toMatchObject({
			type: "object",
			description: "A server-defined input object.",
			additionalProperties: true,
		});
		expect(properties.text).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
			description: "Optional text.",
		});
		expect(properties.object).toMatchObject({
			anyOf: [
				{
					type: "object",
					additionalProperties: true,
					properties: { label: { type: "string", description: "A nested label." } },
					required: ["label"],
				},
				{ type: "null" },
			],
			description: "Optional structured value.",
		});
		expect(properties.array).toMatchObject({
			anyOf: [{ type: "array", items: { type: "string", description: "A list entry." } }, { type: "null" }],
			description: "Optional list.",
		});
		expect(properties.choice).toEqual({
			anyOf: [{ type: "integer" }, { type: "string" }],
			description: "An identifier or name.",
		});
	});

	it.each([false, null])("forwards the converted schema through Responses with strict=%s and Google JSON Schema", (strict) => {
		const parameters = convertedMcpParameters();
		const definition = tool(parameters);
		const responses = convertResponsesTools([definition], { strict, supportsStrictMode: true });
		const google = convertGoogleTools([definition], false, false);
		const googleLegacy = convertGoogleTools([definition], true, false);

		expect(responses).toEqual([
			{
				type: "function",
				name: "mcp__server__tool",
				description: "An MCP tool.",
				parameters,
				strict,
			},
		]);
		expect(google).toEqual([
			{
				functionDeclarations: [
					{
						name: "mcp__server__tool",
						description: "An MCP tool.",
						parametersJsonSchema: parameters,
					},
				],
			},
		]);
		expect(googleLegacy).toEqual([
			{
				functionDeclarations: [
					{
						name: "mcp__server__tool",
						description: "An MCP tool.",
						parameters,
					},
				],
			},
		]);
	});
	it.each(["anthropic", "openai"])("keeps unions in the %s request builder without network access", async (provider) => {
		const definition = tool();
		const context = normalizeContext({
			messages: [{ role: "user", content: "Inspect the schema.", timestamp: 0 }],
			tools: [definition],
		});
		const fetch = vi.fn(async () => { throw new Error("Network access is disabled in this test"); });
		let payload: unknown;
		const options = {
			apiKey: "offline-test-key", fetch, maxRetries: 0,
			onPayload: (value: unknown) => { payload = value; throw new Error("Schema captured before dispatch"); },
		};
		const stream = provider === "anthropic"
			? streamAnthropic(offlineModel("anthropic-messages", provider), context, options)
			: streamCompletions(offlineModel("openai-completions", provider), context, options);
		const result = await stream.result();
		expect(result.errorMessage).toContain("Schema captured before dispatch");
		expect(fetch).not.toHaveBeenCalled();
		if (provider === "anthropic") {
			const schema = definition.parameters as Record<string, unknown>;
			expect(payload).toMatchObject({ tools: [{
				name: definition.name,
				input_schema: { type: "object", properties: schema.properties, required: schema.required },
			}] });
		} else {
			expect(payload).toMatchObject({ tools: [{ function: { name: definition.name, parameters: definition.parameters } }] });
		}
	});
});

describe("pi-ai JSON Schema constrained sampling", () => {
	it("accepts a closed root with a nullable scalar anyOf", () => {
		const schema = {
			type: "object",
			properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
			required: ["value"],
			additionalProperties: false,
		};

		expect(makeStrictJsonSchema(schema)).toEqual(schema);
		expect(getJsonSchemaToolParameters({ ...tool(schema), constrainedSampling: { type: "json_schema", strict: "require" } }, true)).toEqual(schema);
	});

	it("rejects nullable composite anyOf and nullable object type arrays", () => {
		for (const branch of [
			{ type: "object", properties: { name: { type: "string" } } },
			{ type: "array", items: { type: "string" } },
		]) {
			expect(() => makeStrictJsonSchema({
				type: "object",
				properties: { value: { anyOf: [branch, { type: "null" }] } },
				required: ["value"],
				additionalProperties: false,
			})).toThrow("object and array unions are unsupported");
		}
		expect(() =>
			makeStrictJsonSchema({
				type: "object",
				properties: { value: { type: ["object", "null"], properties: { name: { type: "string" } } } },
				required: ["value"],
				additionalProperties: false,
			}),
		).toThrow("properties require type object");
	});

	it("falls back from prefer and rejects require for MCP's open converted object", () => {
		const definition = {
			...tool(),
			constrainedSampling: { type: "json_schema" as const, strict: "prefer" as const },
		};

		expect(resolveJsonSchemaStrictSampling(definition, true)).toBeUndefined();
		expect(() =>
			resolveJsonSchemaStrictSampling({ ...definition, constrainedSampling: { type: "json_schema", strict: "require" } }, true),
		).toThrow("schema-valued or true additionalProperties is unsupported");
	});
});
