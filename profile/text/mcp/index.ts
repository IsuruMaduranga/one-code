/**
 * One Code's MCP words (the profile's `text.mcp`): the resource tools'
 * descriptions and parameters.
 */

import type { McpText } from "../../../extensions/sdk/profile.ts";

export const mcp: McpText = {
	resources: {
		descriptions: {
			list_mcp_resources:
				"List resources and URI templates exposed by connected MCP servers. Resources are readable documents or data the server offers, addressed by uri. Substitute template variables to construct a resource uri.",
			read_mcp_resource: "Read one resource from an MCP server by uri. Use list_mcp_resources to find uris.",
			read_mcp_resource_dir:
				'List the direct children of a directory resource on an MCP server (resources/directory/read). Not recursive: each entry carries its own uri, and subdirectories appear with mimeType "inode/directory" — call again on a subdirectory uri to descend. Only servers that support directory listing accept this; others return an error.',
		},
		params: {
			list: { server: "Limit to one server by name" },
			read: { server: "Server name that owns the resource", uri: "Resource uri" },
			dir: { server: "Server name that owns the directory", uri: "The directory resource uri to list" },
		},
		searchKeywords: ["mcp", "resource", "document", "uri", "directory"],
	},
};
