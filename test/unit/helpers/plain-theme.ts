/**
 * A theme that paints nothing: every color and style returns the text as it
 * is, so a test compares plain strings and any escape code in the output
 * leaked from the input. A test that needs one style to show (a panel's
 * selected row) overrides it: `{ ...plainTheme, inverse: (text) => `[${text}]` }`.
 */
export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	dim: (text: string) => text,
	inverse: (text: string) => text,
};
