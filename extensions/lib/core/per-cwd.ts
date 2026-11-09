/**
 * Memoized get-or-create-by-cwd factory.
 *
 * Several tool definitions from pi (bash, read, write, edit, grep, find, ls)
 * close over their working directory at construction time, but a session's
 * cwd can change mid-run (worktree switches). Extensions that wrap those
 * definitions re-create them per cwd and cache the result so a given cwd only
 * pays construction cost once.
 */

export function perCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
	const cache = new Map<string, T>();
	return (cwd: string): T => {
		let value = cache.get(cwd);
		if (!value) {
			value = create(cwd);
			cache.set(cwd, value);
		}
		return value;
	};
}
