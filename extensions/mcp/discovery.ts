/** Collect an MCP list response's cursor pages without silently dropping later entries. */
export async function collectPages<T>(
	fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
	signal?: AbortSignal,
): Promise<T[]> {
	const items: T[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	while (true) {
		signal?.throwIfAborted();
		const page = await fetchPage(cursor);
		signal?.throwIfAborted();
		for (const item of page.items) items.push(item);
		if (page.nextCursor === undefined) return items;
		if (seen.has(page.nextCursor)) throw new Error("MCP server repeated a pagination cursor; check the server's list implementation.");
		seen.add(page.nextCursor);
		cursor = page.nextCursor;
	}
}
