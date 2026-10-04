import { validateToolArguments } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { jsonSchemaToTypeBox } from "../../extensions/mcp/schema.ts";
import {
	githubCustomPropertyAllowedValues,
	githubCustomPropertyDescription,
	githubCustomPropertyValue,
	gitLabProjectId,
	onceHubCustomFields,
} from "./fixtures/mcp-server-schemas.ts";

describe("real MCP server schema fragments", () => {
	it.each([
		{ name: "GitHub property description", schema: githubCustomPropertyDescription, accepted: [null, "description"], rejected: [1, [], {}] },
		{ name: "GitHub allowed values", schema: githubCustomPropertyAllowedValues, accepted: [null, [], ["one"]], rejected: ["one", [1], {}] },
		{ name: "GitHub property value", schema: githubCustomPropertyValue, accepted: [null, "one", ["one"]], rejected: [1, false, [1], {}] },
		{ name: "OnceHub custom fields", schema: onceHubCustomFields, accepted: [null, {}, { company: "Example" }], rejected: [1, false, [], "text"] },
		{ name: "GitLab project ID", schema: gitLabProjectId, accepted: [null, 123, "group%2Fproject"], rejected: [1.5, false, [], {}] },
		// The real GitLab field is also nullable; this reduction isolates its
		// non-null integer|string union rather than claiming an exact capture.
		{ name: "GitLab non-null project ID", schema: { ...gitLabProjectId, anyOf: gitLabProjectId.anyOf.filter((branch) => branch.type !== "null") }, accepted: [123, "group%2Fproject"], rejected: [null, 1.5, false, [], {}] },
	])("preserves $name and its equivalent type-array form", ({ schema, accepted, rejected }) => {
		// These branches have disjoint types. Their equivalent type-array form
		// exercises the server spelling that used to lose all but one member.
		const branches = "anyOf" in schema ? schema.anyOf : schema.oneOf;
		const typeArraySchema = {
			...branches.find((branch) => branch.type === "array"),
			type: branches.map((branch) => branch.type),
			description: schema.description,
		};
		for (const input of [schema, typeArraySchema]) {
			const converted = jsonSchemaToTypeBox(input);
			for (const value of accepted) expect(Value.Check(converted, value), `accept ${JSON.stringify(value)}`).toBe(true);
			for (const value of rejected) expect(Value.Check(converted, value), `reject ${JSON.stringify(value)}`).toBe(false);
			expect(converted).toHaveProperty("description", schema.description);
		}
	});

	it("preserves GitHub's nullable description inside an array of property definitions", () => {
		// Reduce the real tool's items.oneOf to its definition branch so this
		// test isolates nested nullability rather than exclusive-union handling.
		const converted = jsonSchemaToTypeBox({
			type: "object",
			properties: {
				properties: {
					type: "array",
					items: { type: "object", properties: { description: githubCustomPropertyDescription } },
				},
			},
		});
		expect(Value.Check(converted, { properties: [{ description: null }] })).toBe(true);
		expect(Value.Check(converted, { properties: [{ description: "A description" }] })).toBe(true);
		expect(Value.Check(converted, { properties: [{ description: false }] })).toBe(false);
	});
});

describe("MCP array-valued schema types", () => {
	it.each([
		{ name: "nullable string", schema: { type: ["string", "null"] }, accepted: ["text", null], rejected: [false, 1, [], {}] },
		{ name: "nullable object", schema: { type: ["object", "null"], properties: { path: { type: "string" } }, required: ["path"] }, accepted: [{ path: "/tmp" }, null], rejected: [{}, { path: 1 }, "text", []] },
		{ name: "nullable array", schema: { type: ["array", "null"], items: { type: "string" } }, accepted: [["text"], [], null], rejected: [[1], "text", {}] },
		{ name: "integer or string", schema: { type: ["integer", "string"] }, accepted: [1, "one"], rejected: [1.5, null, false, []] },
		{ name: "bare nullable object", schema: { type: ["object", "null"] }, accepted: [{}, { extra: true }, null], rejected: [[], "text", 1] },
		{ name: "null first", schema: { type: ["null", "boolean"] }, accepted: [null, true, false], rejected: [0, "false", {}] },
		{ name: "object or string", schema: { type: ["object", "string"], properties: { path: { type: "string" } }, required: ["path"] }, accepted: [{ path: "/tmp" }, "text"], rejected: [{}, { path: 1 }, null, []] },
		{ name: "array or boolean", schema: { type: ["array", "boolean"], items: { type: "integer" } }, accepted: [[1], true, false], rejected: [[1.5], null, "text", {}] },
		{ name: "null only", schema: { type: ["null"] }, accepted: [null], rejected: [false, 0, "", [], {}] },
		{ name: "three primitive types", schema: { type: ["number", "boolean", "null"] }, accepted: [1.5, true, false, null], rejected: ["text", [], {}] },
		{ name: "nullable array items", schema: { type: "array", items: { type: ["string", "null"] } }, accepted: [["text", null], []], rejected: [[1], null, "text"] },
	])("preserves the accepted values of $name", ({ schema, accepted, rejected }) => {
		const converted = jsonSchemaToTypeBox(schema);
		for (const value of accepted) expect(Value.Check(converted, value), `accept ${JSON.stringify(value)}`).toBe(true);
		for (const value of rejected) expect(Value.Check(converted, value), `reject ${JSON.stringify(value)}`).toBe(false);
	});

	it.each([
		{ type: ["string", "null"], value: null },
		{ type: ["number", "null"], value: null },
		{ type: ["boolean", "null"], value: null },
		{ type: ["integer", "string"], value: "123" },
	])("does not coerce an already valid $type argument", ({ type, value }) => {
		const tool = {
			name: "mcp__demo__update",
			description: "Update a value",
			parameters: jsonSchemaToTypeBox({ type: "object", properties: { value: { type } }, required: ["value"] }),
		};
		expect(validateToolArguments(tool, { type: "toolCall", id: "update-1", name: tool.name, arguments: { value } })).toEqual({ value });
	});

	it("keeps a nested nullable property required without inventing a value", () => {
		const converted = jsonSchemaToTypeBox({
			type: "object",
			properties: {
				options: {
					type: "object",
					properties: { cursor: { type: ["string", "null"] } },
					required: ["cursor"],
				},
			},
			required: ["options"],
		});
		expect(Value.Check(converted, { options: { cursor: null } })).toBe(true);
		expect(Value.Check(converted, { options: { cursor: "next" } })).toBe(true);
		expect(Value.Check(converted, { options: {} })).toBe(false);
		expect(Value.Check(converted, { options: { cursor: false } })).toBe(false);
	});

	it("does not turn an explicit anyOf null branch into an unconstrained branch", () => {
		const converted = jsonSchemaToTypeBox({ anyOf: [{ type: "string" }, { type: "null" }] });
		expect(Value.Check(converted, null)).toBe(true);
		expect(Value.Check(converted, "text")).toBe(true);
		expect(Value.Check(converted, 1)).toBe(false);
	});

	it("keeps union descriptions on the union and property descriptions on the property", () => {
		const input = {
			type: ["object", "null"],
			description: "Options, or null to clear them",
			properties: { cursor: { type: ["string", "null"], description: "The next cursor" } },
			required: ["cursor"],
		};
		const original = structuredClone(input);
		expect(jsonSchemaToTypeBox(input)).toEqual({
			anyOf: [
				{
					type: "object",
					properties: { cursor: { anyOf: [{ type: "string" }, { type: "null" }], description: "The next cursor" } },
					required: ["cursor"],
					additionalProperties: true,
				},
				{ type: "null" },
			],
			description: "Options, or null to clear them",
		});
		expect(input).toEqual(original);
	});

	it("keeps a single-member type array's description without a redundant union", () => {
		expect(jsonSchemaToTypeBox({ type: ["string"], description: "A path" })).toEqual({ type: "string", description: "A path" });
	});

	it("keeps a standalone null branch restrictive", () => {
		const converted = jsonSchemaToTypeBox({ type: "null" });
		expect(Value.Check(converted, null)).toBe(true);
		expect(Value.Check(converted, "not null")).toBe(false);
	});
});
