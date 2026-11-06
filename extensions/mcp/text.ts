/**
 * What MCP needs from a profile (types only). The extension decides what
 * happened; the profile words it (working-docs/features/profiles/). The caps
 * stay in the base (a server's description, instructions and error line are
 * bounded before the profile sees them); the profile words the cut labels.
 * A server's own text (its instructions, a tool's description, an error it
 * sent) passes through unchanged.
 */

/** Which step of talking to a server ran out of time (client.ts). */
export type McpStep = "connect" | "listTools" | "listResources" | "listResourceTemplates" | "close" | "exchangeCode";

/** A server's stderr tail; `cut` when only its end is shown. */
export interface StderrTail {
	text: string;
	cut: boolean;
}

/** Why a server is listed as failed, or what it warned about after connecting. */
export type McpFailure =
	/** The SDK's, the server's or the system's own message. */
	| { kind: "error"; osMessage: string; stderr?: StderrTail }
	/** `server` is unknown only while exchanging an authorization code. */
	| { kind: "timedOut"; server?: string; step: McpStep; ms: number; stderr?: StderrTail }
	| { kind: "closedDuringDiscovery"; server: string; stderr?: StderrTail }
	/** The server closed the connection after it was up. */
	| { kind: "closedByServer"; stderr?: string }
	/** A tool skipped because its namespaced name is over the provider's limit. */
	| { kind: "nameTooLong"; tool: string; length: number; max: number }
	/** A tool skipped because its namespaced name belongs to another tool. */
	| { kind: "nameTaken"; tool: string; name: string }
	/** A list's next-page cursor came back a second time. */
	| { kind: "repeatedCursor" }
	/** Connected, but a list failed (`refresh`: a later tool-list refresh). */
	| { kind: "listFailed"; list: "tools" | "resources" | "resourceTemplates"; refresh?: boolean; reason: McpFailure };

/** What is wrong with a server's image bytes (schema.ts validateImageData). */
export type ImageProblem =
	| { kind: "empty" }
	| { kind: "emptyAfterDecode" }
	| { kind: "tooLarge"; bytes: number; limit: number }
	| { kind: "unrecognised"; claimed?: string }
	| { kind: "unsupported"; mime: string }
	/** The container is not whole: `chunk` names the PNG chunk for the chunk defects. */
	| { kind: "png"; defect: "signature" | "noEnd" | "chunkPastData" | "checksum" | "headerNotFirst" | "zeroSize" | "noData"; chunk?: string }
	| { kind: "jpeg"; defect: "noScan" | "badMarker" | "endsBeforeScan" | "truncated" | "segmentPastData" | "noEnd" }
	| { kind: "gif"; defect: "header" | "truncated" | "zeroSize" | "noTrailer" }
	| { kind: "webp"; defect: "truncated" | "shorterThanRiff" | "noImage" | "chunkPastData" };

/** One server's instructions as shown (already cut to the cap). */
export interface ServerInstructions {
	name: string;
	text: string;
}

export interface McpText {
	/** A server whose sign-in expired or never happened, met during a call (the user signs in with /mcp). */
	needsAuthentication(p: { server: string }): string;
	/** Message 1's block of the servers' own instructions. */
	instructions(servers: readonly ServerInstructions[]): string;
	/** Instructions past the cap: the kept head. */
	instructionsCut(head: string): string;
	/** Message 1's block of failed servers; each `error` is a worded failure's first line, bounded. */
	failed(servers: ReadonlyArray<{ name: string; error: string }>): string;
	/** One failure, as the failed-servers block and /mcp show it. */
	failure(failure: McpFailure): string;
	/** Inside an epoch: what changed since message 1 or the last notice. */
	notices: {
		recovered(names: readonly string[]): string;
		connected(servers: readonly ServerInstructions[]): string;
		dropped(names: readonly string[]): string;
		/** A tool-list refresh failed; `failure` is worded. */
		refreshFailed(p: { server: string; failure: string }): string;
		/** Tools a refresh removed or changed, by their registered names. */
		toolsChanged(p: { server: string; tools: readonly string[] }): string;
	};
	/** A server's tool: its fallback description, the description cut, and its call results. */
	tool: {
		description(p: { server: string; tool: string }): string;
		/** A server's tool or parameter description past the cap: the kept head and the full length. */
		descriptionCut(p: { head: string; chars: number }): string;
		notConnected(server: string): string;
		gone(p: { server: string; tool: string }): string;
		schemaChanged(name: string): string;
		callFailed(osMessage: string): string;
	};
	/** A content block the result shows as text. */
	content: {
		imageUndecodable(p: { server?: string; problem: ImageProblem; bytes: number }): string;
		/** An embedded resource without text. */
		resource(uri?: string): string;
		/** A block of a type with no text form (`audio`, ...). */
		other(type: string): string;
		binaryResource(p: { uri?: string; mimeType?: string; kb: number }): string;
	};
	/** The resource tools. */
	resources: {
		descriptions: Record<"list_mcp_resources" | "read_mcp_resource" | "read_mcp_resource_dir", string>;
		params: {
			list: Record<"server", string>;
			read: Record<"server" | "uri", string>;
			dir: Record<"server" | "uri", string>;
		};
		/** Search terms for `tool_search`, shared by the three tools. */
		searchKeywords: string[];
		/** `connected` when the result lists the servers that are. */
		unknownServer(p: { name: string; connected?: readonly string[] }): string;
		line(p: { server: string; uri: string; name?: string; description?: string; template: boolean }): string;
		none: string;
		readFailed(p: { uri: string; osMessage: string }): string;
		directoryEntry(p: { uri?: string; name?: string; mimeType?: string }): string;
		directoryEmpty: string;
		directoryFailed(p: { uri: string; osMessage: string }): string;
	};
}
