/** Quoting one word for a shell command line. Pure. */

/** A POSIX shell single-quoted word: the text exactly, whatever it holds. */
export function shellQuote(word: string): string {
	return `'${word.replace(/'/g, "'\\''")}'`;
}

/** PowerShell single-quoted literal: only `'` needs escaping, as `''`. */
export function powershellQuote(word: string): string {
	return `'${word.replace(/'/g, "''")}'`;
}
