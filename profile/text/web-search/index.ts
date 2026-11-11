/**
 * One Code's web_search text (the profile's `text.webSearch`): the
 * descriptions (description.ts), the parameters, each route's result, the
 * notes on routes that fell back, and every failure.
 */

import { type WebSearchText } from "../../../extensions/sdk/profile.ts";
import { webSearchDescription } from "./description.ts";

export const webSearch: WebSearchText = {
	description: webSearchDescription,
	params: {
		query: "The search query to use",
		allowed_domains: "Only include search results from these domains",
		blocked_domains: "Never include search results from these domains",
	},
	searchKeywords: ["web", "search", "internet", "google", "news", "lookup", "online", "current"],
};
