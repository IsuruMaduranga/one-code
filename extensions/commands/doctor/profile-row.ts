/** The report's `profile` field: the profile the launch chose, with home-relative paths; nothing on the default profile alone. */
import { tildify } from "../../lib/profile/paths.ts";
import { profileSummary } from "../../lib/profile/profile.ts";

export function profileRow(home: string): { profile?: string } {
	const profile = profileSummary((path) => tildify(path, home));
	return profile !== undefined ? { profile } : {};
}
