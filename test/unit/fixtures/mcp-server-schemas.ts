// Schema fragments from GitHub's custom_properties_write tool snapshot:
// https://github.com/github/github-mcp-server/blob/71ef8266e48110974b13aef50b4df6ff9914ff68/pkg/github/__toolsnaps__/custom_properties_write.snap
// Paths are relative to inputSchema.properties.properties.items.oneOf[1].properties.
export const githubCustomPropertyDescription = {
	anyOf: [{ type: "string" }, { type: "null" }],
	description: "A short description of the property. Omit when updating to preserve the current description; use null to clear it.",
};

export const githubCustomPropertyAllowedValues = {
	anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }],
	description: "The ordered list of allowed values for single_select and multi_select properties. Omit when updating to preserve the current list; use null or an empty array to clear it.",
};

// inputSchema.properties.properties.items.oneOf[0].properties.value
export const githubCustomPropertyValue = {
	description: "Repository level only: the value to assign. A string, an array of strings, or null to clear the value.",
	oneOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }, { type: "null" }],
};

// Generated with Pydantic 2.11.9 from the public tools' Optional[dict] and
// Optional[Union[int, str]] annotations, not captured tools/list responses.
// https://github.com/scheduleonce/mcp-server/blob/34616cd38185b23f3d65f0f4ae4fba9313a3a559/tools.py#L161
export const onceHubCustomFields = {
	anyOf: [{ additionalProperties: true, type: "object" }, { type: "null" }],
	default: null,
	description: "Key-value pairs for the booking form. Example: {'company': 'Acme', 'interests': ['Pricing', 'Demo']}",
	title: "Custom Fields",
};

// https://gitlab.com/gitlab-org/modelops/applied-ml/code-suggestions/ai-assist/-/blob/8b253a2548fb1860ec957a5dcc4a64cb8cdfb0b8/duo_workflow_service/tools/gitlab_resource_input.py#L18
export const gitLabProjectId = {
	anyOf: [{ type: "integer" }, { type: "string" }, { type: "null" }],
	default: null,
	description: "The ID or URL-encoded path of the project. Examples: 123, 'gitlab-org%2Fgitlab'. Required if URL is not provided.",
	title: "Project Id",
};
