/**
 * web_search's model-facing description (pure).
 *
 * The short form, on frontier and workhorse models, is One Code's own: it
 * names the backends that answer and how the domain filters apply to each.
 * The long form, on cheap and tiny models (lib/tool-variants.ts), is the text
 * Claude Code writes for its weakest models, addressed to the model rather
 * than to Claude, with the backends line in place of "Web search is only
 * available in the US".
 */

import type { DescriptionForm } from "../lib/tool-variants.ts";

export const WEB_SEARCH_SHORT_DESCRIPTION =
	"Search the web. Returns result blocks with titles and URLs.\n\n" +
	"- `allowed_domains` / `blocked_domains` filter results (enforced on Brave/Tavily/Exa; with provider-native search they become `site:` operators in the query, best-effort).\n" +
	'- After answering from results, end with a "Sources:" list of the URLs you used as markdown links.\n' +
	"- Uses the model provider's own search when it has one; otherwise a configured search API (Brave, Tavily) or, with no key, a free rate-limited endpoint — the result names which.";

export const WEB_SEARCH_LONG_DESCRIPTION = `
- Allows you to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond your knowledge cutoff
- Searches are performed automatically within a single API call

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites
  - Uses the model provider's own search when it has one; otherwise a configured search API (Brave, Tavily) or, with no key, a free rate-limited endpoint — the result names which

IMPORTANT - Use the correct year in search queries:
  - The current month is (provided in the conversation below). You MUST use this year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation" with the current year, NOT last year
`;

export function webSearchDescription(form: DescriptionForm): string {
	return form === "long" ? WEB_SEARCH_LONG_DESCRIPTION : WEB_SEARCH_SHORT_DESCRIPTION;
}
