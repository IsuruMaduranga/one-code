/**
 * web_fetch's model-facing description (pure).
 *
 * The short form, on frontier and workhorse models, is One Code's own: it
 * describes what this fetch does that Claude Code's does not (an optional
 * `prompt`, windowed pages, Anthropic's server-side fetch). The long form, on
 * cheap and tiny models (lib/tool-variants.ts), is the text Claude Code writes
 * for its weakest models, with One Code's tool names, without the claude.ai
 * artifact line, with `prompt` optional and with the paging note in place of
 * "Results may be summarized".
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";

export const WEB_FETCH_SHORT_DESCRIPTION =
	"Fetch a URL and return its readable content as markdown. Navigation and boilerplate are stripped. Pass `prompt` to have a small fast model answer it from the full page instead of returning the page itself — prefer that for long pages (on an Anthropic API-key session, Anthropic's server-side fetch answers it). Without `prompt`, long pages are windowed; pass `offset` to continue reading. Responses are cached for 15 minutes. Cross-host redirects are reported instead of followed; call again with the new URL to follow one.";

export const WEB_FETCH_LONG_DESCRIPTION = `IMPORTANT: web_fetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.

- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and an optional prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - localhost and other hostnames without a dot are not supported; for a local server, use curl via bash
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Without a prompt, a long page is returned in windows; pass \`offset\` to continue reading
  - Includes a self-cleaning cache (entries expire after 15 minutes) for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new web_fetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via bash instead (e.g., gh pr view, gh issue view, gh api).
`;

export function webFetchDescription(form: DescriptionForm): string {
	return form === "long" ? WEB_FETCH_LONG_DESCRIPTION : WEB_FETCH_SHORT_DESCRIPTION;
}
