/**
 * The profile module a launch with no choice runs, for tests that need its
 * source: `profile/index.ts`, or the folder the brand's `defaultProfile`
 * names (lib/profile/brand.mjs), where a product may have no
 * `profile/index.ts` at all. Imported by path, so the base suite runs on
 * either shape.
 */
import { pathToFileURL } from "node:url";
import type { Profile } from "../../../extensions/lib/profile/profile-contract.ts";
import { PROFILE_MODULE } from "../../../extensions/lib/profile/profile.ts";

export const { profile } = (await import(pathToFileURL(PROFILE_MODULE).href)) as { profile: Profile };
