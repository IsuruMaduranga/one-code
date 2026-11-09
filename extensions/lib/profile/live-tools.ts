/**
 * Which tools this session can have, for text that names another tool (types
 * only). The base answers from the feature registry and the tool switches
 * when the profile resolves (lib/profile/profile.ts), and builds the profile's text
 * for that answer (`Profile.text`); the text leaves out what is off,
 * so a request never names a tool it does not carry. The golden sweep fails
 * when one does (test/e2e/golden-requests.mjs --sweep).
 */

export interface LiveTools {
	has(tool: string): boolean;
}
