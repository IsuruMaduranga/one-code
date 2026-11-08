/**
 * Stand-ins for the web_search fallback chain's tests (web-search-backends and
 * One Code's web-search-backends-wording).
 */
import type { SearchBackend } from "../../../extensions/web/backends.ts";

/** The failure data a backend or the chain threw. */
export async function failureOf(work: Promise<unknown> | (() => unknown)): Promise<unknown> {
	try {
		await (typeof work === "function" ? work() : work);
	} catch (error) {
		return (error as { failure?: unknown }).failure;
	}
	throw new Error("expected a failure");
}

/** A backend labelled by its name that searches with `impl`. */
export const fakeBackend = (name: SearchBackend["name"], keyless: boolean, impl: SearchBackend["search"]): SearchBackend => ({
	name,
	label: name,
	keyless,
	search: impl,
});

/** One search result. */
export const ONE_RESULT = [{ title: "T", url: "https://a.com/", snippet: "S" }];
